# CALENDAR-INVENTORY.md — what the Calendar tab actually does (2026-06-30)

Scope: the Calendar tab and the occupancy/push machinery behind it. Grounded
against current prod code (`2abcb9c`) + live prod data (read-only probe).

## Live listings in scope (Little Feather Management)

All 3 are `rate_copy` + `rateCopyPushEnabled=true`, `occupancyScope=group`,
tag `group:Student Accomodation`, on the live allowlist, pushing 5×/day:

| Listing | HostawayID | unit_count | source listing |
|---|---|---|---|
| Studio Apartment at The Edge | 515526 | 150 | (PriceLabs-driven shadow) |
| Alma Place Short Stays | 514009 | 50 | … |
| City Centre 6-bed at Alma Place | 554857 | 6 | … |

## The live price-build pipeline (rate_copy path — the one that pushes)

`rate-copy-push-worker` (5×/day, Europe/London) → `executeRateCopyPush`
(`rate-copy-push-service.ts`) → `computeRateCopyByDate` → `computeRateCopyByDateFromRows`
(`rate-copy.ts`) → `executePushRates` (`hostaway/push-service.ts`, verify-after-push)
→ Hostaway `PUT /v1/listings/{id}/calendar`.

Per-date math (`computeRateCopyByDateFromRows`):
1. **source rate** = source listing's `CalendarRate.rate` for the date (its PriceLabs price, pulled by source-sync).
2. **occupancy multiplier** = `1 + adjPct/100` where `adjPct = lookupMultiUnitOccupancyLeadTimeAdjustmentPct(matrix, occupancyPct, leadTimeDays)`.
   - `occupancyPct` comes from `computeMultiUnitOccupancyByDate` (the occupancy cell).
   - **Guardrail A (matrix cap):** the matrix cell bounds how far this can move.
3. **manual override** (fixed replaces rate & bypasses min; percentage-delta multiplies, min still applies).
4. **min floor** = `max(rate, targetUserMin)` where `targetUserMin = minimumPriceOverride ?? basePriceOverride × 0.7`.
   - **Guardrail B (min floor):** never below this (except a fixed override, by design).
5. **round** to `roundingIncrement`.
6. **min-stay** = override.minStay ?? settings.minimumNightStay.

Both guardrails Mark relies on live in step 2 (matrix cap) and step 4 (min floor).

## Occupancy compute (today) — `multi-unit-occupancy.ts`

- `computeMultiUnitOccupancyByDate({tenantId, listingInputs, fromDate, toDate})`
  → reservations overlapping each date (non-cancelled) → `unitsSold`.
- Denominator = **`unitCount` (static)**, summed across any group members that
  share a `group:` tag *within the provided `listingInputs`*.
- **BUT the push service passes only the single target listing** into
  `listingInputs` and gates on `unitCount >= 2` — so today each listing prices
  on its **own** static unit count; `occupancyScope=group` is configured but the
  occupancy compute never actually pools across buildings.
- `occupancyPct = round(unitsSold / sum(unitCount) × 100, 1dp)`.

## Hostaway availability data we already store

`CalendarRate.rawJson` (synced) contains per date, per multi-unit listing:
`status`, `isAvailable`, `countAvailableUnits` (= total physical units, static),
**`availableUnitsToSell`** (released-and-still-sellable), `countBlockedUnits`,
`countPendingUnits`, `reservations[]` (length ≈ booked). `countReservedUnits` is
null for these listings, so booked comes from our `Reservation` table.

Verified live (The Edge, early July 2026): `availableUnitsToSell` ∈ {2..18},
`reservations.length` ∈ {13..31}, sum ≈ **31 released** vs `unit_count` 150 →
this is the "only ~42 of 150 released" stock Mark wants to yield on.

## Calendar UI surfaces

- `calendar-grid-panel.tsx` — the grid + cell inspector (base, occupancy %,
  multipliers, min floor, final, live-vs-recommended).
- `calendar-settings-panel.tsx` — Occupancy section: scope selector (already
  typed `portfolio|group|property`), unit-count editor, matrix editor.
- `property-settings-drawer.tsx` — per-listing settings.

## The four fixes mapped to real code

- **Fix 1** — `rate-copy-push-service.ts` §5: when `occupancyScope==="group"`,
  pool all group-tag members (incl. single-unit) into `listingInputs`; drop the
  `unitCount>=2` exclusion for group members. Split `group:Student Accomodation`
  → `group:The Edge` + `group:Alma Place` (data) so Edge ≠ Alma denominator.
- **Fix 2** — `multi-unit-occupancy.ts`: denominator = booked + `availableUnitsToSell`
  per date (fallback `unit_count` when unpopulated); surface the basis used.
- **Fix 3** — `rate-copy-push-worker.ts`: hourly repeatable for toggled listings,
  delta-only push, allowlist intact, backpressure + structured cycle log.
- **Fix 4** — calendar inspector + settings: show occupancy basis (booked /
  released, denominator, fallback flag), scope in effect, matrix cell, last-pushed
  vs live, next push time; name the group pool + members.
