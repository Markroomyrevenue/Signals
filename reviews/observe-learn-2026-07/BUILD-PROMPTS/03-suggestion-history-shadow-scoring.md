# Build prompt 03 – Preserve suggestion history + shadow suggestions + ghost scoring

Copy-paste this whole file into a fresh Claude Code session at the `signals` repo root.

## Context (self-contained; assume no memory of prior sessions)

The observe-and-learn system (`src/lib/observe/**`) generates pending price-drop `Suggestion`
rows per tenant, but only after a 30-day observation window graduates
(`src/lib/observe/observe-service.ts`, ~lines 152-155). A July 2026 review
(`reviews/observe-learn-2026-07/REVIEW.md`) found:

1. **The evidence is destroyed daily.** `generateSuggestionsForClient` deletes ALL pending
   rows every run and regenerates (`src/lib/observe/suggestions.ts`, the
   `prisma.suggestion.deleteMany({ where: { tenantId, clientKey, status: "pending" } })` at
   ~line 181). There is no record of what was suggested when at what rate, so even a purely
   retrospective evaluation ("did nights we flagged on Tuesday book by Friday, at what rate?")
   is impossible.
2. **The silent window produces nothing testable.** Before graduation the system emits no
   suggestions at all, so the 30 days yield recomputed descriptive stats and a leap of faith
   at day 30.
3. **Nothing scores anything.** No job compares a suggestion to what subsequently happened.
   `NightFact` (occupancy, `revenueAllocated`, `leadTimeDays`), `Reservation`
   (`createdAt`, `cancelledAt`) and `RateChange` already contain everything needed to settle
   outcomes.

This prompt turns the pre-push period into calibration data. Nothing here applies any price
change; the system remains observe-only.

## Task

Work on a branch off `main`.

1. **Stop destroying history.** Replace the delete-and-regenerate with supersession: mark
   prior pending rows `status = "superseded"` instead of deleting. Keep the readout and the
   suggestions API returning pending rows only (existing behaviour unchanged for consumers).
2. **Shadow generation from day 1.** Run `generateSuggestionsForClient` on every daily run
   regardless of graduation, writing rows with `status = "shadow"` for ungraduated tenants
   (graduated tenants keep writing `pending`). Shadow rows must never appear in the readout's
   pending list or the day-30 email; they exist only for scoring. Guard volume: shadow rows are
   superseded daily like pending ones, so the table grows by at most ~50 rows per tenant per
   day; add a retention note (superseded rows older than 120 days may be pruned by a follow-up
   job – do not build pruning yet).
3. **Ghost scorer.** On the existing weekly settle path (`runWeeklySettleForTenant`,
   `observe-service.ts` ~lines 193-220), add a scorer that processes every suggestion
   (shadow, superseded, pending) whose stay date has passed by 2+ days and which has no score
   yet. For each, record on the suggestion's `detail` JSON (or a new tenant-scoped
   `SuggestionScore` table if `detail` gets unwieldy – prefer `detail` for v1):
   - `outcome`: `booked_no_action` | `expired_empty` | `cancelled_after_booking`
     (re-check `Reservation.cancelledAt` on later passes);
   - `realisedRate` from `NightFact.revenueAllocated` when booked, and
     `realisedVsProposed = realisedRate / proposedValue`;
   - `daysToBookingAfterSuggestion` from the reservation `createdAt`;
   - `rateMovedAfter`: whether a `RateChange` on that listing/date occurred between suggestion
     and booking (the status quo acted anyway).
4. **Calibration report in the readout.** Add a section per client: of the last N scored
   suggestions, the share that booked anyway with no drop, at what average realised rate vs
   the proposed drop; bucketed by suggested drop size and lead-time bucket, each with its `n`.
   Plain English, e.g. "Of 120 nights the system would have dropped, 68 booked anyway at full
   rate." This is the graduation evidence Mark sees instead of a leap of faith.
5. **Shadow-Mark agreement line.** Using `RateChange` rows (price drops with |changePct| >= 3%
   to skip RMS noise), report per client: nights where Mark/the RMS dropped and the system
   also flagged, flagged-but-not-dropped, dropped-but-not-flagged, with counts. Label it
   "method agreement (experimental)" – attribution of who moved the price is not yet solved,
   so present it as observational.

## Constraints (house rules, non-negotiable)

- Every new Prisma query touching `Listing`, `Reservation`, `NightFact`, `PaceSnapshot`,
  `CalendarRate`, `DailyAgg`, or `SyncRun` MUST filter by `tenantId` (see
  `scripts/test-tenant-isolation.ts`). Any new model gets `@@index([tenantId, ...])`.
- If a migration is needed (status values are strings, so likely not), write it but never run
  `prisma migrate dev` against prod; prod migrations are manual `prisma migrate deploy` per
  CLAUDE.md.
- Do not change the graduation gate, the pending-only human-approval posture, or apply any
  price anywhere. Do not touch `src/lib/sync/pace.ts`, pace queries in
  `src/lib/reports/service.ts`, or `src/lib/hostaway/**`. No AirROI.
- Owner preference: one fix per commit where practical.

## Green gate (all must pass)

```
npm run typecheck
npm run lint -- --max-warnings=0
npm run test:tenant-isolation
```

Plus unit tests covering: supersession (pending rows become superseded, not deleted), shadow
rows excluded from the readout pending list, the scorer's three outcome classes including the
cancellation re-check, and the calibration bucketing.

## Finish

Report what changed, the test evidence, and the commit list. Then ask Mark explicitly:
**deploy to the live webapp or keep local?** Note for Mark: every day this is not deployed is
a day of calibration data lost before the 2026-07-28 graduation, and the `signals-worker`
Railway service must be restarted for the new scorer to run. If this is an autonomous or
overnight run and Mark cannot answer, do NOT auto-deploy: leave the change local with a
"TO DEPLOY" block at the top of your summary. If Mark says deploy, follow the standing deploy
& self-heal protocol in CLAUDE.md end to end.
