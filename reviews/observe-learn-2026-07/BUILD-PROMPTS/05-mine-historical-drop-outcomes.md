# Build prompt 05 – Mine the historical rate-change record for drop dose-response

Copy-paste this whole file into a fresh Claude Code session at the `signals` repo root.

## Context (self-contained; assume no memory of prior sessions)

The Signals rate scanner has been recording every detected price move per listing per
stay-date for months: prod holds ~554k `rate_changes` (~290k drops), ~134k `rate_states`,
~1.9k `booking_rate_contexts` (bookings linked to a rate change within 48h), plus full
occupancy outcomes in `night_facts` (with `lead_time_days` and `revenue_allocated`) and
`reservations` (with `created_at`, `cancelled_at`). A July 2026 review
(`reviews/observe-learn-2026-07/REVIEW.md`; measurement design in `02-causal-stats.md` §7)
found that the observe-and-learn system's drop sizing (5-25%, hand formula in
`src/lib/observe/suggestions.ts` ~line 76) encodes no data, while the question "when this
client drops X% at lead Y, how often does the night fill, at what realised rate, vs matched
un-dropped nights" is answerable TODAY from these tables. This prompt builds that
retrospective, read-only-on-prod analysis. It changes no live behaviour.

Two data hazards the review established, which this job must handle:
- **RMS noise floor:** the median detected price change is ~0.9% – daily engine wiggle, not a
  decision. Only |changePct| >= 3% counts as a drop event.
- **Per-date rows:** `rate_changes` are per stay-date; one human/RMS action shows up as a
  sweep of rows. Collapse to episodes before counting.

## Task

Work on a branch off `main`.

1. **Episode extraction.** A one-off job (script under `scripts/`, reusable as a lib function
   under `src/lib/observe/`) that, per tenant:
   - collapses `rate_changes` (lever `price`, changePct <= -0.03) into drop episodes:
     listing x detection window x contiguous stay-date span, with mean drop size and the
     lead time (days from detection to stay date) per affected night;
   - stratifies sampling across listings and across the full history (NOT most-recent-first;
     the review found the existing take-50-newest pattern covers 0.9% of drops on 9 listings).
2. **Outcome join.** For each episode-night: did the night end occupied (`night_facts`), at
   what `revenue_allocated`, booked how many days after the drop (`reservations.created_at`,
   via `booking_rate_contexts` where a link exists), later cancelled (`cancelled_at`)? Nights
   whose stay date has not passed are excluded (settled nights only).
3. **Within-listing matched comparison** (the honest counterfactual, per the statistician's
   design): for each treated night, match un-dropped nights of the SAME listing with the same
   day-of-week and lead-time bucket within +/-21 days of stay date, and compute fill-within-14d
   and realised-rate deltas, treated vs matched. Do not use the peer-ladder rung-3 machinery.
4. **Output.** Write a `DropOutcomeStat`-style summary keyed by
   (tenant, leadTimeBucket, dropSizeBand: 3-7% / 7-15% / 15%+, dateType weekday/weekend) with:
   episodes, treated nights, fill rate, matched-control fill rate, mean realised rate as % of
   pre-drop rate, cancellation rate, and each cell's `n`. Persist to a new tenant-scoped table
   OR emit as a JSON + markdown report under `observe-reports/` (prefer the report for v1;
   the table can come with the closed-loop build). The markdown must include the caveats:
   observational, selection-on-weakness (drops happen to weak nights, so uncorrected deltas
   are biased against drops), and the matching's limits.
5. **Run it** against the local dev database for correctness, and if prod read access is
   available in the environment (`DATABASE_PUBLIC_URL`, SELECT-only), run the read-only
   analysis against prod and include the real numbers in the report. NEVER write to prod:
   the persistence step targets the local/default database only; when running against prod,
   emit the report files only.

## Constraints (house rules, non-negotiable)

- Every Prisma/SQL query touching `Listing`, `Reservation`, `NightFact`, `PaceSnapshot`,
  `CalendarRate`, `DailyAgg`, or `SyncRun` MUST filter by `tenantId` (see
  `scripts/test-tenant-isolation.ts`).
- Prod access, if used, is strictly SELECT-only. No UPDATE/INSERT/DELETE/DDL against prod,
  never `prisma migrate` anything against prod.
- Do not touch `src/lib/sync/pace.ts`, pace queries in `src/lib/reports/service.ts`, or
  `src/lib/hostaway/**`. No AirROI. Do not change the suggestion engine in this prompt – this
  is evidence-gathering; a later change consumes it.
- Owner preference: one fix per commit where practical.

## Green gate (all must pass)

```
npm run typecheck
npm run lint -- --max-warnings=0
npm run test:tenant-isolation
```

Plus unit tests on the pure parts: episode collapsing (a 30-date sweep is one episode), the
3% noise filter, drop-size banding, and the matching key construction.

## Finish

Report: the episode counts per tenant, the headline dose-response table (or "insufficient
matched controls" per cell, honestly), where the report lives, and the commit list. Then ask
Mark explicitly: **deploy to the live webapp or keep local?** (This job is analysis-only; if
nothing web-facing changed, say so plainly and recommend keep local, but still ask – house
rule.) If this is an autonomous or overnight run and Mark cannot answer, do NOT auto-deploy:
leave a "TO DEPLOY / TO REVIEW" block at the top of your summary pointing at the report. If
Mark says deploy anything, follow the standing deploy & self-heal protocol in CLAUDE.md.
