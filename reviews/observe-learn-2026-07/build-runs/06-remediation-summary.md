> **Update 2026-07-04:** everything below was subsequently built, independently audited (SAFE, three auditors) and **deployed live** (prod `7500a9e`, then `9e71e9f` docs). TO DEPLOY blocks below are historical. See DECISIONS.md entry 2026-07-04.

# Build run 06 - Remediation: ghost scorer owner-block exclusion (F1)

Run date: 2026-07-03 (overnight, autonomous). Branch: `feat/observe-learn-fixes-2026-07`.
Source: finding F1 in `reviews/observe-learn-2026-07/BUILD-AUDIT-behaviour.md`.

## What was fixed

The ghost scorer (`src/lib/observe/suggestion-scoring.ts`) counted any occupied
`NightFact` as a booking, so owner blocks (`status = "ownerstay"`, 8,234 rows in
prod) and near-zero-revenue artefact rows (`revenueAllocated <= 5`) scored as
`booked_no_action` with a realised rate near zero. That inflated the calibration
report's "booked anyway at full rate" share while dragging
`avgRealisedVsProposed` down. Prompts 04 and 05 already excluded these classes
(`learnings.ts`, `scripts/mine-drop-outcomes.ts`); the scorer now uses the same
convention, importing the shared `MIN_REAL_REVENUE` threshold from
`drop-outcomes.ts`.

Treatment chosen: a night occupied only by owner blocks or artefact rows is
neither booked at a real rate nor genuinely empty, so it is not forced into
either outcome. The scorer skips it with an explicit reason
(`non_revenue_occupancy`), persisted once under `Suggestion.detail.scoreSkip`
so the gap is auditable, and re-evaluates it on later passes in case a sync
correction supplies a real booking (a later real score removes the skip
marker). When a real booking sits alongside an owner-blocked unit
(multi-unit), the realised rate now averages over the real facts only.
Genuinely empty nights still score `expired_empty`; nothing else changed.
`ScoreSettledResult` gained a `skipped` count, surfaced in the weekly settle
log line.

## Evidence

- 4 new unit tests pin the exclusions (ownerstay skip, threshold boundary at 5,
  real-booking-plus-ownerstay rate, skip priority over a covering cancellation).
- Full gate green: typecheck, lint (0 warnings), tenant isolation passed,
  `test:observe` 167/167 (baseline 163), `test:observe-schedule` 6/6.

## Not deployed

Local branch only; nothing pushed or deployed. The fix ships with the rest of
this branch per the standing deploy protocol. Once the worker restarts on the
new code, previously mis-scored `booked_no_action` rows are NOT retroactively
corrected (a score already on `detail` is final except for the cancellation
re-check); the calibration report should be read from scores produced after
this fix, or the affected rows rescored deliberately.
