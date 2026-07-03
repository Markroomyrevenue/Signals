# Build prompt 01 – Suggestion safety gates (deadline: before 2026-07-28)

Copy-paste this whole file into a fresh Claude Code session at the `signals` repo root.

## Context (self-contained; assume no memory of prior sessions)

The observe-and-learn system (`src/lib/observe/**`, live since 2026-06-27) runs a daily 05:30
Europe/London job per tenant. After a tenant's 30-day observation window graduates, it writes
pending price-drop `Suggestion` rows for a human to review. All four active tenants graduate on
**2026-07-28**. A July 2026 multi-agent review (`reviews/observe-learn-2026-07/REVIEW.md`)
found the generator will produce trust-destroying output on day one unless gated:

1. **No minimum-price clamp.** `proposedValue = Math.round(rate * (1 - dropPct))` in
   `judgeNightForSuggestion` (`src/lib/observe/suggestions.ts`, around line 76-77) has no floor
   of any kind.
2. **Event-blind.** Nothing in `src/lib/observe/**` references `eventAdjustmentForDate`
   (`src/lib/pricing/events.ts`) or `src/lib/agents/pricing-comparison/trial-events.ts`.
   Fleadh Cheoil (Belfast, 2026-08-02..09) is priced +15..60% by trial events; the generator
   would propose ~20% cuts on those same nights at confidence 0.81, sorted near the top because
   event-week rates inflate `revenueAtRisk`.
3. **Compounding ratchet.** Each run deletes all pending rows and regenerates from the CURRENT
   rate (`suggestions.ts` around line 181), so an applied drop on a still-empty night gets a
   fresh 5-25% cut off the already-dropped rate daily, with no memory. Approved rows are kept
   but not excluded from regeneration, so a night can carry an approved drop AND a fresh
   pending drop.
4. **Curve miscalibration.** `expectedCumulativeFill` (`suggestions.ts` ~lines 29-37) is the
   share of eventual bookings with lead >= d, not the probability the night is booked; at ~70%
   occupancy it over-reads urgency everywhere.
5. **Multi-unit blindness.** `booked` is "any occupied NightFact" (~lines 165-174), so a
   40-unit building with one unit sold is never flagged, and a truly empty multi-unit night has
   `revenueAtRisk` understated. `Listing.unitCount >= 2` marks multi-units in this codebase.
6. **Unreadable output.** The readout table shows internal listing ids, not names
   (`src/lib/observe/readout.ts` ~line 101).

## Task

Work on a branch off `main`. Implement, in `src/lib/observe/suggestions.ts` (pure logic in the
exported functions so it stays unit-testable) plus `readout.ts`:

1. **Min floor:** clamp `proposedValue` to the listing's minimum price. Resolution order:
   latest `EngineSnapshot.min` for the listing (tenant-filtered), else the pricing-settings
   minimum if one exists for the listing, else the lowest rate observed for that listing in
   `rate_states` over the trailing 180 days, else skip the clamp but flag
   `detail.floorUnknown = true`. If the clamped value equals or exceeds the current rate, do
   not emit the suggestion.
2. **Event shield:** for each candidate night, call `eventAdjustmentForDate` from
   `src/lib/pricing/events.ts` (the shared one-source-of-truth helper per CLAUDE.md). If the
   night carries a positive event adjustment, do not emit a drop; count it as blocked with
   reason `event`.
3. **No compounding:** skip nights that already have an `approved` or `applied` suggestion for
   the same tenant/listing/date. Additionally enforce a per-night cumulative cap: if prior
   non-pending suggestions (or, once available, applied drops) within the trailing 14 days
   total >= 25% for that night, block with reason `cumulative_cap`.
4. **Occupancy scaling:** multiply `expectedCumulativeFill` by the tenant's trailing-365d
   final occupancy for matching DOW (from `NightFact`, tenant-filtered) before comparing to
   `RISK_FILL_THRESHOLD`, so the trigger compares like with like. Keep the raw curve value in
   the reason string alongside the scaled one.
5. **Multi-unit awareness:** for listings with `unitCount >= 2`, treat a night as booked only
   when occupied units >= unitCount (fully sold), and scale `revenueAtRisk` by the number of
   unsold units. Read the multi-unit conventions in memory/codebase before implementing
   (`Listing.unitCount`; occupancy pooling by `group:` tag exists elsewhere – do not replicate
   it here, per-listing is fine for v1).
6. **Blocked counter:** return and persist counts of blocked suggestions by reason; render a
   "blocked" line in the readout (`readout.ts`) – this is a deliberate trust metric.
7. **Readable readout:** join listing names into the readout suggestions table.

## Constraints (house rules, non-negotiable)

- Every new Prisma query touching `Listing`, `Reservation`, `NightFact`, `PaceSnapshot`,
  `CalendarRate`, `DailyAgg`, or `SyncRun` MUST filter by `tenantId` (see
  `scripts/test-tenant-isolation.ts`).
- Do not touch `src/lib/sync/pace.ts`, the pace queries in `src/lib/reports/service.ts`, or
  anything in `src/lib/hostaway/**`. Do not re-introduce AirROI.
- Do not route anything through `settings.localEvents`; read events via
  `eventAdjustmentForDate` only.
- Keep changes additive; do not change the 30-day window gating or the pending-only posture.
- Owner preference: one fix per commit where practical, so individual rollback is easy.

## Green gate (all must pass before the work is done)

```
npm run typecheck
npm run lint -- --max-warnings=0
npm run test:tenant-isolation
```

Plus unit tests covering: the min clamp (including floorUnknown fallback), the event shield
(a +50% event night is blocked), the cumulative cap, the occupancy-scaled trigger, and the
multi-unit booked/revenueAtRisk logic. Extend the existing observe test files rather than
inventing a new harness.

## Finish

Report what changed, the test evidence, and the commit list. Then ask Mark explicitly:
**deploy to the live webapp or keep local?** Deployment means the Next.js webapp AND the
`signals-worker` service on Railway (project `bubbly-quietude`) run the new code – a worker
started before the change keeps running stale code until restarted. If this is an autonomous
or overnight run and Mark cannot answer, do NOT auto-deploy: leave the change local and put a
clear "TO DEPLOY" block at the top of your summary with exact copy-pasteable steps. If Mark
says deploy, follow the standing deploy & self-heal protocol in CLAUDE.md (backup tags first,
green gate, baseline health check, push, restart worker, verify, bounded self-heal, report).
