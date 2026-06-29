# AUDIT-A2 — Multi-unit booking specialist findings

Agent 2. Repo: `/Users/markmccracken/Documents/signals`. Date 2026-06-29.
Tenant under investigation: **Little Feather Management** (`cmoeuax4x000ery6qv2emihce`) —
the production tenant and the only one with multi-unit listings. READ-ONLY.

Scripts (re-runnable): `scripts/audit/a2-inventory.ts`, `a2-occupancy.ts`,
`a2-portfolio-and-adr.ts`, `a2-deepdive-and-overflow.ts`.

## The three multi-unit listings (all real, all `group:Student Accomodation`)

| hwId | name | unit_count | beds | cap | reservations | nightfacts |
| --- | --- | --- | --- | --- | --- | --- |
| 515526 | Studio Apartment at The Edge | **100** | 1 | 2 | 1266 | 4107 |
| 514009 | Alma Place Short Stays | **20** | 1 | 1 | 148 | 513 |
| 554857 | City Centre 6 bedroom apartment at Alma Place | **6** | 6 | 6 | 17 | 49 |

The `unit_count=100` listing is **not a data error** — it is a real student-accommodation
block ("The Edge") booked as individual studios. On its busiest night (2026-08-07/08) it had
**52 concurrent non-cancelled reservations** — well within 100, and consistent with a large
student block. So the 100 is plausible. (Caveat: see F2 on Alma Place, where 20 looks too low.)

---

## F1 — P1 — Occupancy% and RevPAR are massively overstated for multi-unit listings (inventory denominator ignores `unit_count`)

**This, not reservation-ADR, is the multi-unit defect.** Mark's #1 suspicion (per-reservation
ADR inflating ~N×) is **disproved** — see F3.

### Root cause
The reports-service inventory denominator is **active-listing-days, never scaled by
`unit_count`**, and is then floored to occupied nights:

- `groupCalendarInventoryDaily` (`src/lib/reports/service.ts:2783-2788`) = `COUNT(*)` of
  `calendar_rates` rows per date. A multi-unit listing has **exactly 1 calendar_rates row per
  date** (one rate per Hostaway listing), regardless of `unit_count`.
- `withInventoryDailyFallback` (`service.ts:2811-2814`) and the per-listing path
  (`service.ts:1281-1282`, `:1535`) all compute
  `inventoryNights = Math.max(occupiedNights, calendarInventory>0 ? calendarInventory : 1)`.
  The fallback inventory per listing is **1**, never `unit_count`.
- `resolveOccupancyPercent` (`service.ts:733-739`) divides nights by that denominator and
  **clamps to 0–100**. When 52 rooms are occupied on one date, `occupied(52) > inventory(1)` so
  the `max` makes inventory = 52 → occupancy pinned at exactly **100%**, and the clamp hides the
  fact that true occupancy is 52/100 = 52%.
- Confirmed by grep: **nowhere** in `src/lib/reports/**` or `src/lib/metrics/**` is inventory/
  availability multiplied by `unit_count`. The `multi-unit-occupancy.ts` module that *does* know
  about `unit_count` is only wired into the **pricing-calendar** path (`service.ts:4849+`), not
  into any report's occupancy/RevPAR.

### Evidence — per-listing, August 2026 (peak), scoped report vs unit-scaled truth

| listing | uc | occ nights | report inventory | **report occ%** | **true occ%** | report RevPAR | true RevPAR | overstated |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| The Edge | 100 | 552 | 552 | **100.0%** | **17.8%** | £118.38 | £21.08 | **5.62×** |
| 6-bed Alma | 6 | 31 | 53 | **58.5%** | **16.7%** | £246.81 | £70.33 | **3.51×** |
| Alma Place | 20 | 332 | 334 | **99.4%** | **53.5%** | £62.30 | £33.56 | **1.86×** |

Per-date (Alma Place, uc=20): 2026-08-08 had occ=41 → report shows 100.0%, true is 205%
(see F2); 2026-08-05 had occ=18 → report shows 100.0%, true is 90.0%.

### Blast radius — portfolio headline numbers are wrong for the production tenant
Whole-tenant trailing-365 (2025-06-29 → 2026-06-29), `buildSalesReport`, no filter:

- report inventory = **18,957**; unit-scaled inventory = **63,318**
- **REPORT occupancy% = 75.1% → TRUE ≈ 22.5%** (overstated **3.34×**)
- **REPORT RevPAR = £84.32 → TRUE ≈ £25.24** (overstated **3.34×**)
- (Revenue and occupied-nights are correct — only the *denominator* is wrong, so ADR is fine.)

Affected surfaces (everything that divides by inventory): **Stayed (sales)** occupancy/RevPAR
columns and series, **Pace** occupancy, **Property Drilldown** occupancy/RevPAR
(`buildPropertyDeepDiveReport`, same `:1535` denominator), **Overview** focus-finder occupancy
deltas, and the **PDF/CSV/PPTX exports** of all of the above. Revenue, ADR, nights, bookings are
**not** affected.

Note the registry/signal_lab engine (`metrics/registry.ts`) uses a *different* availability
source (`CalendarRate.available` count) but it **also** does not scale by `unit_count`, so
signal_lab occupancy/RevPAR for these listings is wrong in the same direction.

### Proposed fix
Multiply the per-listing per-date inventory by `unit_count` (default 1) in the inventory builders,
and **remove the 0–100 occupancy clamp** for multi-unit (or keep the clamp but only after the
denominator is correct). Concretely: thread `unit_count` into `groupCalendarInventoryDaily` /
`withInventoryDailyFallback` / the `:1281` and `:1535` per-listing paths so
`inventoryNights += unit_count` per active listing-day (lifecycle-gated as today), instead of
`+= 1`. Stop using `Math.max(occupied, inventory)` as the inventory — that floor is what masks
the overflow; with a correct `unit_count` denominator it is no longer needed.

### Risk of fix
Medium. It *lowers* Little Feather's headline occupancy (75% → ~22%) and RevPAR — a large,
visible change to a number the client sees, so it needs a heads-up to Mark, not a silent deploy.
Single-unit listings (`unit_count` null/1) are unaffected (×1). Must keep the lifecycle gate so
removed/not-yet-onboarded listing-days are still excluded. Other tenants have no multi-unit
listings, so their numbers do not move at all (good blast-radius containment). Verify with the
A2 scripts before/after.

---

## F2 — P2 — `Alma Place Short Stays` (uc=20) is over-occupied vs its unit_count (data/config, not a code bug)

On 2026-08-08, **44 non-cancelled reservations** overlap a single night on Alma Place, whose
`unit_count` is **20** (37 on 08-07, 24 on 08-09). That is structurally impossible for a true
20-unit block. Two possibilities, both worth Mark confirming:

1. `unit_count=20` is **understated** — the block actually has ~40+ studios; or
2. genuine source-data **double-booking / overlapping reservations** in Hostaway.

This is why F1's "true occ%" for Alma hits 205% on the peak night. It does **not** change F1's
conclusion (occupancy is still overstated by the report because inventory isn't scaled), but it
means even a correct ×`unit_count` fix would show >100% for Alma until the `unit_count` is
corrected. No reservation double-count exists in the night path: for The Edge (100) and the 6-bed
(6), **no date exceeds unit_count**; only Alma overflows, pointing at its `unit_count` value
specifically. Recommend Mark verify Alma's real room count via `/api/listings/unit-count`.

Root cause: data/config value in `Listing.unit_count` for hwId 514009, not a formula.
Fix: correct the `unit_count` (owner action) — no code change. Risk: none (data only).

---

## F3 — NOT A BUG — reservation-level ADR is correct for multi-unit (Mark's #1 suspicion disproved)

The hypothesis was: one Hostaway reservation books N units but stores all-units `total` against
single-unit `nights`, inflating `SUM(total)/SUM(nights)` ~N×. **False.** Each room booking is its
own `Reservation` row:

- **0 reservations** in the three multi-unit listings have `nights <> (departure − arrival)` —
  stored nights always equal the literal stay span. No aggregated-units total.
- Sample of highest-`total` multi-unit reservations gives sane per-room ADRs: The Edge studios
  £66–£98, e.g. `res …xr0ugw` 61 nights / £5,964 = **£97.78**. The one outlier (£1,348 ADR) is a
  2-night booking of the genuine **6-bedroom whole apartment** (uc listing, but let as one unit at
  peak) — £2,698 / 2 nights — not a multi-unit aggregation artifact.
- `buildReservationsReport` scoped to all multi-unit listings (booked 2025-01-01 → 2026-06-29):
  resv=1431, nights=4669, revenue=£360,107, **summary ADR = £77.13** — consistent with per-room
  pricing. The booked-tab path (`groupReservationBookingsDaily`, `SUM(total)/SUM(nights)`) is
  equally safe for the same reason.

The night-level expansion (`src/lib/sync/nightfact.ts:49-97`) is also correct: one reservation →
one NightFact per calendar night, revenue spread `accommodationFare / losNights`; multi-unit
bookings each contribute exactly 1 night per date, so there is no per-reservation revenue or
night double-count. This matches the lead's pre-confirmation.

---

## F4 — How multi-unit reservations arrive & expand (verified correct)

Hostaway models each of these "blocks" as **one listing** but sends **one reservation per booked
room** (1266 reservations against the 100-unit The Edge; up to 52 overlapping a single date).
Sync stores each as a normal `Reservation` (its own `total`/`nights`/`arrival`/`departure`) and
`rebuildNightFactsForReservations` (`nightfact.ts:122+`) expands each into one NightFact per
night. There is **no fan-out by `unit_count`** anywhere in sync — and that is correct, because the
reservations themselves already represent the individual rooms. The only place `unit_count` *needs*
to enter is the **denominator** (inventory/availability), which is exactly where it is missing
(F1). `src/lib/hostaway/normalize.ts` only normalizes channel/status strings — not relevant to
expansion.

---

## Summary

- **P1 ×1 (F1):** Multi-unit occupancy% and RevPAR are overstated because the inventory
  denominator never scales by `unit_count` and is floored to occupied nights, then clamped to
  100%. Production tenant (Little Feather) portfolio occupancy shows **75.1% vs true ~22.5%** and
  RevPAR **£84.32 vs ~£25.24** (3.34× over). Per-listing up to 5.62× (The Edge). Affects Stayed /
  Pace / Drilldown / Overview occupancy+RevPAR and all their exports; revenue/ADR/nights are fine.
  Fix: scale inventory by `unit_count`; drop the `max(occupied, inv)` floor. Root cause
  `service.ts:2811-2814`, `:1281-1282`, `:1535`, `:733-739`.
- **P2 ×1 (F2):** `Alma Place Short Stays` has 44 reservations overlapping one date vs
  `unit_count=20` — the unit_count looks understated (or genuine overbooking). Owner data check,
  no code fix.
- **Not a bug (F3):** reservation-level ADR is correct — each room is its own reservation; 0 rows
  have nights ≠ stay span; multi-unit summary ADR £77.13. Mark's #1 suspicion is disproved.
- **Verified (F4):** the 100-unit listing is real; sync expansion is correct; `unit_count` belongs
  only in the denominator.

Top 3: **F1** (P1, real customer-facing distortion of the production tenant's headline
occupancy/RevPAR), **F2** (P2, Alma unit_count likely wrong), **F3** (clears the originally
suspected ADR path).
