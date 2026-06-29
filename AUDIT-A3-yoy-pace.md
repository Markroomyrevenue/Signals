# AUDIT-A3 — YoY / pace comparison specialist

Agent 3. Repo `/Users/markmccracken/Documents/signals`. Today **2026-06-29**.
READ-ONLY against prod. All numbers below are from the live prod DB via the
audit harness. Tenant used for worked examples: **Little Feather Management**
(`cmoeuax4x000ery6qv2emihce`).

Harness scripts (added, namespaced `a3-*`):
- `scripts/audit/a3-yoy-pace.ts` — deep-dive ADR-vs-LY reconcile (past/future/mixed × both modes), cancelled-after-cutoff inclusion proof, pace report reconcile.
- `scripts/audit/a3-nullbooking.ts` — quantifies NULL `booking_created_at` impact on the YoY-as-at reference.
- `scripts/audit/a3-mu.ts`, `a3-muinv.ts` — multi-unit (unit_count=100) deep-dive / inventory probe.

---

## Headline verdict

The **core YoY/pace arithmetic is correct**. For a real high-ADR-variance
Little Feather listing, the deep-dive `current.adr` and `reference.adr`
reconcile **to the penny** against an independent night_facts recompute across
**all 12 cases** (past / mixed / future × `yoy_otb` / `ly_stayed`). Numerator
and denominator are consistent on both sides (current on-the-books vs LY
on-the-books-as-at-cutoff for `yoy_otb`; current vs LY-finished for
`ly_stayed`). There is **no apples-to-oranges stayed-vs-OTB bug** in the ADR
comparison itself. Pace on-books nights & revenue reconcile to the penny too.

**The defect Mark reports ("ADR vs last year doesn't display right") is a
front-end rendering bug in the drilldown's *last* column** ("Calendar ADR vs
last year") — not in the YoY computation. The main "ADR … vs last year" column
is correct; the calendar-ADR column improvises a wrong value the backend never
gave it. Details in P1 below.

---

## Evidence — deep-dive ADR-vs-LY reconciliation (charter 1 & 2)

Listing `cmoeuazju0kcpt80oewbhd9v1` (single-unit, GBP, monthly-ADR stddev ≈ 80):

| mode | period | type | report cur nights/ADR | raw cur | report ref nights/ADR | raw ref | verdict |
|---|---|---|---|---|---|---|---|
| yoy_otb | 2026-05 | past | 22 / 78.95 | 22 / 78.95 | 26 / 147.53 | 26 / 147.53 | PASS |
| yoy_otb | 2026-06 | mixed | 24 / 220.86 | 24 / 220.86 | 21 / 131.72 | 21 / 131.72 | PASS |
| yoy_otb | 2026-07 | future | 14 / 235.41 | 14 / 235.41 | 22 / 140.67 | 22 / 140.67 | PASS |
| ly_stayed | 2026-05 | past | 22 / 78.95 | = | 26 / 147.53 | = | PASS |
| ly_stayed | 2026-06 | mixed | 24 / 220.86 | = | 21 / 131.72 | = | PASS |
| ly_stayed | 2026-07 | future | 14 / 235.41 | = | 28 / 163.34 | 28 / 163.34 | PASS |

The future-period reference correctly differs between modes (yoy_otb 22 nights
@140.67 = "LY as at the cutoff"; ly_stayed 28 nights @163.34 = "LY finished").
The mixed-period splice (LY-stayed for dates ≤ today, LY-pace-cutoff for dates
> today) reconciles exactly, confirming the `resolvePropertyDeepDiveComparisonData`
date-by-date blend (`service.ts:2435-2457`) is sound.

**365-day cutoff / period alignment:** clean. `paceCutoff = addUtcDays(today,-365)`
(`service.ts:4523`) and `lyStart/lyEnd = addUtcYearsClamped(periodStart/End,-1)`
(`:4526-4527`). `addUtcYearsClamped` (`:592`) clamps the day to the LY month's
length, so each month maps to its same-named LY month with that month's own day
count — no off-by-one, leap-year safe (Feb-29 clamps to Feb-28). Month-granularity
YoY is **calendar-aligned (same month), not weekday-aligned** — a defensible and
standard convention; flagged as definitional, not a defect.

## Evidence — cancelled-but-live-at-cutoff inclusion (charter 3) — VERIFY ONLY

Owner requirement: a booking that was LIVE at the snapshot date (today−365 =
**2025-06-29**) must count in the YoY-as-at reference even if cancelled later.
**Confirmed working.** Real example (5 such rows found):

```
listing=cmoeuazrk0kedt80olac1csu4 stay=2025-06-24 status=cancelled
  booked=2025-04-18  cancelled_at=2025-09-22T08:27:29Z  resv=40469435
```

This reservation was on the books on 2025-06-29 and cancelled in Sept 2025.
LY month 2025-06 for that listing:
- nights **WITH** cancelled-after-cutoff inclusion = **55**
- nights **WITHOUT** (is_occupied only) = **30**
- → inclusion correctly adds **25 nights** to the YoY-as-at reference.

The `includeCancelledAfterCutoff` branch at `service.ts:1145-1153` and the
matching `pace.ts:58-67` deliver this. `r.cancelled_at > cutoff::date` is the
right boundary ("still live AT the cutoff"). **pace.ts cancelled logic verified
correct — not refactored.**

## Evidence — pace report reconcile (charter 4)

Window 2026-06-29 .. 2026-09-27, all Little Feather listings:

| mode | current on-books (report → raw) | LY reference (report → ungated raw) |
|---|---|---|
| yoy_otb | 4159 nights / £449,242.10 → 4159 / £449,242.10 **PASS** | 1994 / £239,785.69 → 1994 / £239,785.68 (lifecycle-gate OK) |
| ly_stayed | 4159 / £449,242.10 → 4159 / £449,242.10 **PASS** | 4908 / £556,428.37 → 4908 / £556,428.38 (OK) |

Current-side on-books and revenue reconcile to the penny. The yoy_otb LY
reference (1994) being far below ly_stayed (4908) is correct YoY-as-at semantics
— a year ago only ~40% of these nights were yet on the books. Lifecycle gate
removed nothing for this window (report == raw).

---

## Findings (severity-ranked)

### P1 — "Calendar ADR vs last year" drilldown column renders a wrong / blank value
**This is the bug Mark reported.** `app/components/revenue-dashboard.tsx`.

- The column header is **"Calendar ADR vs last year"** (`:8339`).
- Its cell renders `liveAdrDelta` (`:8416-8417`), defined at **`:8384`** as
  `row.liveRate − row.reference.adr`, gated on `row.liveVsReferenceAdrPct`.
- But the backend's purpose-built field is `liveVsReferenceAdrPct =
  computeDeltaPct(calendarAdr, lyStayedAdr)` (`pricing-report-assembly.ts:528`),
  where `calendarAdr` = blended booked + remaining-live ADR (`:455-458`) and the
  reference is **always `lyStayedAdr`** (not the compareMode reference).

Three concrete defects:
1. **Wrong minuend.** UI uses `liveRate` (raw nightly live rate) instead of
   `calendarAdr` (the blended calendar ADR the column name promises). `calendarAdr`
   is computed in the backend but **never returned** in `PropertyDeepDiveRow`
   (`service.ts:290-294` exposes only `liveRate`, `liveVsCurrentAdrPct`,
   `liveVsReferenceAdrPct`), so the UI *cannot* show the intended number.
2. **Wrong reference basis.** UI subtracts `row.reference.adr` (yoy_otb or
   ly_stayed depending on the toggle), while the gate `liveVsReferenceAdrPct` was
   computed against `lyStayedAdr`. The displayed delta and its null-gate measure
   different things, so the cell can render a number whose sign/magnitude doesn't
   match the gate that allowed it.
3. **Blank for all past periods.** For `periodMode === "past"` the service returns
   `liveRate: null` for every listing (live-rate map is empty, `service.ts:4616-4625`).
   So `liveAdrDelta` is null and the whole "Calendar ADR vs last year" column is
   blank on past months — even though `liveVsReferenceAdrPct` (and the ordinary
   ADR-vs-LY) data exists. This is the most visible "doesn't display right" symptom.

**Root cause:** `revenue-dashboard.tsx:8382-8384` + `:8416-8417` reconstruct an
absolute currency delta from fields that don't carry the calendar-ADR value.
**Proposed fix (mostly display, small backend addition):**
- Backend: surface `calendarAdr` and `lyStayedAdr` (and ideally `liveVsReferenceAdrPct`
  already exists) on `PropertyDeepDiveRow` — they're already computed at
  `pricing-report-assembly.ts:455-467`, just not returned.
- UI: render the column as `formatSignedPercent(row.liveVsReferenceAdrPct)` (or a
  currency delta `calendarAdr − lyStayedAdr`) and show "—" when null, instead of
  `liveRate − reference.adr`. Align the header wording with whichever basis is chosen.
**Risk:** Low. Display-layer change plus an additive field on the response (no
formula change to any reconciled number). Confirm with Mark whether the column
should compare *calendar ADR* (booked+live blend) vs *last-year-stayed*, which is
what the backend intended, vs the compareMode reference.

### P2 — Multi-unit (unit_count=100) listing makes the YoY drilldown comparison meaningless (cross-ref to multi-unit agent)
Listing `cmoqx89cr01sbqs0o7ov4gs43`, `unit_count=100`, created 2026-05-04.
Deep-dive (this month, yoy_otb): current **6 nights, occ 17.65%**, reference
**656 nights**, ADR delta −26.61%, health "behind".

The **ADR itself is internally consistent** (rev/nights match raw on both sides,
PASS), so this is not a YoY-formula bug. But:
- **Occupancy denominator ignores `unit_count`.** Current month has 30
  `calendar_rates` rows (1/day, **not** ×100) and 6 occupied nights → 17.65%
  implies inventory ≈ 34, i.e. days-not-units. LY month has **0** calendar_rates
  rows but **656** occupied night_facts across 30 dates (~21.9 occupied
  units/night). So current and LY sit on **different inventory bases**, and the
  "6 vs 656 / behind −26.61%" YoY signal is an artefact of the unit-count/inventory
  data problem, surfacing through the YoY drilldown Mark looks at.
**Root cause:** inventory/occupancy for multi-unit listings (the unit_count=100
anomaly the lead flagged), not pace/YoY. **Hand to the multi-unit agent.** Fix is
out of my charter; flagging because it manifests on the drilldown surface.
**Risk of ignoring:** misleading "behind" health + occupancy% on multi-unit rows.

### P3 — NULL `booking_created_at` handled inconsistently between pace.ts and the report YoY path (latent; zero impact today)
- `pace.ts:59` **includes** NULL-booking night_facts in pace snapshots
  (`booking_created_at IS NULL OR DATE(...) <= snapshot`).
- The report YoY-as-at path passes `excludeMissingBookingCreatedAt: true`, so
  `service.ts:1140` **drops** NULL-booking rows from the `yoy_otb` reference
  entirely (they can never satisfy `IS NOT NULL`).

These are different code paths (snapshot writer vs live night_facts query), so
not a direct contradiction, but they treat undated bookings oppositely in YoY.
**Measured impact: ZERO** — across all 5 live tenants, the LY-as-at window
(2025-06-29 .. 2025-12-29) has **0** occupied night_facts with NULL
`booking_created_at`. Latent inconsistency only. **Do not refactor pace.ts**
(owner-confirmed). If a future Hostaway source produces undated bookings, the
yoy_otb reference would silently under-count. **Proposed fix:** none now; add a
code comment documenting the intentional divergence, or align the report path to
pace.ts's NULL-inclusive rule if/when undated bookings appear.
**Risk:** None today.

### P3 — Definitional: month-granularity YoY is same-month, not same-weekday aligned
`addUtcYearsClamped` maps each month to its same-named LY month. Standard and
defensible, but note the **reservations tab** uses a *different* "last-year
same-weekday ADR" concept (`service.ts:246-247`). A user toggling between tabs
could see two different "vs last year" ADRs for overlapping data. Not a defect;
document so QA doesn't conflate them. **Risk:** None.

---

## ≤12-line summary

- **YoY/pace arithmetic is correct.** Deep-dive `current.adr` & `reference.adr`
  reconcile to the penny across all 12 cases (past/mixed/future × yoy_otb/ly_stayed);
  numerator/denominator consistent — no stayed-vs-OTB bug. Pace nights & revenue
  reconcile to the penny.
- **Cancelled-but-live-at-cutoff inclusion VERIFIED** (real resv 40469435 adds 25
  nights to LY-as-at). pace.ts cancelled logic correct — not refactored.
- **365-day cutoff & leap-year/period alignment clean** (no off-by-one).
- Severity counts: **P0 0 · P1 1 · P2 1 · P3 2.**
- Top 3:
  1. **P1** — "Calendar ADR vs last year" drilldown column (revenue-dashboard.tsx
     :8382-8384/:8416-8417) renders `liveRate − reference.adr`, not the backend's
     `calendarAdr`-based value (never returned); blank on all past periods. **This
     is Mark's "doesn't display right."** Fix: display + surface `calendarAdr`.
  2. **P2** — unit_count=100 listing: occupancy denom ignores unit_count, current
     (6) vs LY (656) on different inventory bases → bogus "behind". Hand to multi-unit agent.
  3. **P3** — NULL booking_created_at included in pace.ts but excluded in report
     YoY path; latent, 0 rows today.
