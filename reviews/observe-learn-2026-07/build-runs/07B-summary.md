> **Update 2026-07-04:** built, independently audited (SAFE, two auditors) and **deployed live** (prod `05a9bdd`). See DECISIONS.md.

# Build run 07 Part B — richer dimensions + the actual-paid signal (2026-07-04)

Scope: build prompt 07 items 4-7 (`BUILD-PROMPTS/07-learning-granularity-hierarchy.md`),
on branch `feat/observe-grain-2026-07`, on top of Part A's cohort engine
(`07A-summary.md`). NOT deployed — deployment is the orchestrator's step.

## What shipped

| Commit | Change |
|---|---|
| `4642f19` | Learning #8 (`promo_gap`): actual-paid vs listed-rate-near-booking, per channel + cohort, on the weekly settle; profile field, ledger key, starvation column, weekly blind-spot copy |
| `a79dc74` | Ghost scorer stamps `paidVsListedGapPct` + `heavyPromo` on scores; calibration gains `bookedHeavyPromo` / `bookedNoIntervention` |
| `b78a4c8` | Pickup velocity measured on the settle for old-enough `PeerControl` rows; learning #1 wired into profile/ledger (`src/lib/observe/pickup.ts`) |
| `2cec7a5` | Calibration + drop dose-response re-cuts by `group:` tag and size band, min-n suppressed; mine script emits the cohort tables |
| `8a9c6d2` | Market-stratified GlobalMethodology: per-client `leadTimeByMarket` (normalised city), whitelisted, aggregated per market in the rebuild |

Gate: `npm run typecheck`, `lint --max-warnings=0`, `test:tenant-isolation`,
`test:observe` 227/227 (200 after Part A), `test:observe-schedule` 6/6 — all green.

## The actual-paid design (item 4) — read this before auditing

Prod `rawJson` inspection (read-only, 2026-07-04): the explicit discount fields
are too sparse to learn from — `reservationCouponId` set on 220/41,984
reservations, `reservationFees` "DISCOUNT - …" lines on ~28, `financeField`
empty on all rows. So the prompt's fallback carries the signal: gross nightly
actually paid (`accommodationFare / nights`) vs the listed rate in force near
booking (latest `RateChange` at/before booking → `newValue`; else earliest
change after → `oldValue`; else the scanned `RateState` rate).

Measured on prod (trailing 90d): 4,927 recent bookings, 4,275 with a rate
observation. Median paid/listed per channel: booking.com **0.74**, airbnb
**0.99**, direct **0.72** — the gap is dominated by STRUCTURAL wedges (VAT,
channel pricing), not promos. Hence:

- the learning is per channel (medians include the wedge, stated in the type docs);
- "heavy promo" is judged RELATIVE to the channel's own median
  (`HEAVY_PROMO_EXCESS_PCT = 0.15`, calibrated: within-channel p50→p10 spread
  is ~8-13pp), absolute floor `0.30` only when a channel has no baseline
  (`MIN_CHANNEL_PROMO_N = 10`);
- the promo-gap block is NOT whitelisted into GlobalMethodology (group labels
  can carry building names); the REQUIRED leak test now asserts this.

Ghost-scorer feed: `realisedRate` already IS actual-paid (revenueAllocated =
fare/nights), so `realisedVsProposed` stays untouched; the fix is that a
promo-filled night is no longer counted as "nothing acted and it booked
anyway" — `bookedNoIntervention` excludes both rate-moved and heavy-promo
bookings, and `bookedHeavyPromo` is reported separately.

## Pickup velocity (item 5)

`measureSettledPickups` runs on the weekly settle before the learnings
recompute: for each unmeasured `PeerControl` whose drop is old enough
(`PICKUP_WINDOW_DAYS = 7` + `PICKUP_SETTLE_LAG_DAYS = 1`), it counts bookings
covering the event night created in the window (cancelled-in-window excluded),
subject vs the RECORDED control set, per listing-day; raw counts persist under
`PeerControl.detail.pickup`. `computePickupVelocity` pools trailing-90d
measured events with a control through the existing `pickupVelocity` core into
`profile.pickupVelocity` with n. Prod note: all 1,350 rows' events are 0-7
days old today, so measurement begins on the first settle after deploy.

## Decisions an auditor should scrutinise

1. **Heavy-promo threshold is channel-relative** (median + 15pp). A channel-wide
   promo campaign would raise the median and mask itself; the absolute
   `meanGapPct`/`medianGapPct` per channel remain visible on the profile for a
   human to spot that.
2. **Listed rate for old bookings without a `RateChange`** falls back to the
   current `RateState` rate — valid only because a night with no recorded
   change has held its rate since scanning began (window bounded to 90d,
   scanner running since 2026-06-02). Bookings predating the scanner mostly
   resolve nothing and drop out (unknown ≠ clean).
3. **Pickup counts bookings, not nights**, and excludes bookings cancelled
   inside the window; rung-3 rows (no control) are measured moved-only and
   excluded from the aggregate (no honest comparison).
4. **Learning #8 added to `LEARNING_KEYS`** — ledger/starvation matrix now have
   eight columns; the "seven learnings" language in older docs is superseded.
5. **Min-n suppression constants**: `MIN_CALIBRATION_COHORT_N = 10` (report
   cells), `MIN_COHORT_CELL_TREATED = 20` (dose-response, matches the mine
   script's existing signal floor), `MIN_CHANNEL_PROMO_N` /
   `MIN_COHORT_PROMO_N = 10`, `MARKET_LEAD_MIN_NIGHTS = 300` (prod: belfast
   31,289 nights / 3 tenants; single-listing villages fall out).
6. **`computeLeadTime` changed signature** (returns `{ leadTime,
   leadTimeByMarket }`); only `learnings.ts` consumed it.
7. **Settle cost**: `computePromoGap` runs twice on the settle (learnings +
   scorer) — deliberate simplicity; each run is one bounded query set.

## What Part C needs to know

- Profile (`ClientProfileDoc`) new fields: `pickupVelocity { movedPerListingDay,
  controlPerListingDay, liftPct, eventsWithControl, windowDays } | null`,
  `promoGap: PromoGapLearning | null` (`byChannel` medians/means/heavyShare with
  n; `byCohort` medians with n; `withListedRate` is the sample),
  `leadTimeByMarket { [cityKey]: { medianLeadDays, bucketPcts, n } } | null`.
- `CalibrationReport` new fields: `bookedHeavyPromo`, `bookedNoIntervention`,
  `byGroup`, `bySizeBand` (both `CalibrationBucket[]`, already min-n
  suppressed; readout already renders them + the heavy-promo headline clause).
- `GlobalMethodologyDoc.leadTimeByMarket` — per city label:
  `{ leadTimeBucketPcts, medianLeadDays, samples, nights }`.
- Weekly-report copy hooks: `plainBlindSpot` has `pickup_velocity` and
  `promo_gap` cases; the promo-gap line per client (item 9) should come from
  `profile.promoGap.byChannel` — remember the structural-wedge caveat: quote
  the HEAVY share ("about 1 in 10 recent bookings came with a big discount"),
  not the raw median gap, or booking.com's VAT wedge reads as a 26% promo.
- Suggestion provenance for the readout is unchanged from Part A
  (`detail.curveCohort` / `detail.occupancyCohort`).
- New exports: `src/lib/observe/actual-paid.ts` (`computePromoGap`,
  `isHeavyPromo`, gap/aggregate pure fns, constants),
  `src/lib/observe/pickup.ts` (`measureSettledPickups`,
  `computePickupVelocity`, pure fns), `aggregateDropOutcomesByCohort` +
  `MIN_COHORT_CELL_TREATED` in `drop-outcomes.ts`, `leadTimeByMarket` in
  `learnings-core.ts`, `MARKET_LEAD_MIN_NIGHTS` in `learnings.ts`,
  `MIN_CALIBRATION_COHORT_N` in `suggestion-scoring.ts`.
- `WeeklySettleResult` gained `pickups { measured, withControl }` (the worker
  test's shape assertions were unaffected).
