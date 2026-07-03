> **Update 2026-07-04:** everything below was subsequently built, independently audited (SAFE, three auditors) and **deployed live** (prod `7500a9e`, then `9e71e9f` docs). TO DEPLOY blocks below are historical. See DECISIONS.md entry 2026-07-04.

# Build run 03 — Suggestion history + shadow suggestions + ghost scoring

Prompt: `reviews/observe-learn-2026-07/BUILD-PROMPTS/03-suggestion-history-shadow-scoring.md`
Branch: `feat/observe-learn-fixes-2026-07` · Starting commit: `d19aee4` · Date: 2026-07-03 (overnight, autonomous)

## TO DEPLOY

Nothing here is live yet. This change is worth deploying promptly: **every day it is not
deployed is a day of calibration data lost** before the 2026-07-28 graduation decision.

1. No migration needed — the new `shadow` / `superseded` statuses are plain strings in the
   existing `suggestions.status` column, and scores live in the existing `detail` JSON column.
2. Push `main` (after merge) → Railway auto-deploys the `Signals` web service.
3. **Restart the `signals-worker` Railway service** — both the daily shadow generation and
   the weekly ghost scorer run in the worker; a stale worker keeps the old delete-and-regenerate
   code.
4. Verify: next daily observe log line shows `suggestions=<n> (shadow)` for ungraduated
   tenants; next Monday settle log shows `scored=<n> rechecked=<n>`; the key-gated readout
   (`/api/observe/readout?...`) gains "Calibration" and "Method agreement (experimental)"
   sections.

## What changed

1. **History preserved (`c142363`).** `generateSuggestionsForClient` no longer
   `deleteMany`s pending rows each run. Prior `pending`/`shadow` rows are marked
   `status = "superseded"` via `applySuggestionRegeneration` (new, unit-tested against a fake
   store). Human-actioned rows untouched. The anti-ratchet cumulative-cap guard now excludes
   `superseded`/`shadow` (they were never applied; counting them would wrongly ratchet-block).
   Readout + API still return pending only. Retention note: superseded rows older than 120
   days may be pruned by a follow-up job — not built, per the prompt.
2. **Shadow suggestions from day 1 (`2a80e4e`).** The daily observe run now generates
   suggestions for every tenant: graduated → `pending`, still-observing → `shadow`. Shadow
   rows never reach the readout pending list or the day-30 email; superseded daily
   (≤ ~50 rows/tenant/day growth).
3. **Ghost scorer (`ed38c56`).** New `src/lib/observe/suggestion-scoring.ts`, wired into
   `runWeeklySettleForTenant`. Every price suggestion whose stay date passed 2+ days ago
   (120-day lookback) and has no score gets `detail.score`: outcome
   (`booked_no_action` / `expired_empty` / `cancelled_after_booking`), `realisedRate` from
   `NightFact.revenueAllocated`, `realisedVsProposed`, `daysToBookingAfterSuggestion` from
   `Reservation.createdAt`, `rateMovedAfter` from `RateChange`. Booked outcomes are re-checked
   on later passes for late `cancelledAt` and flipped. Writes only `Suggestion.detail`.
4. **Calibration report (`ed61829`).** Readout section over the last 200 scored suggestions:
   plain-English headline ("Of 120 nights the system would have dropped, 68 booked anyway…"),
   plus buckets by suggested drop size and lead time, each with its `n`.
5. **Method agreement, experimental (`a474ceb`).** Last 90 days of stay dates: dropped
   (RateChange price drop ≥ 3%) AND flagged / flagged-not-dropped / dropped-not-flagged
   counts, explicitly labelled observational (attribution unsolved).

Nothing applies a price anywhere; the graduation gate and pending-only approval posture are
unchanged. No schema migration. `src/lib/sync/pace.ts`, report-service pace queries and
`src/lib/hostaway/**` untouched. All new queries tenant-scoped.

## Test evidence (full green gate, run at `a474ceb`)

- `npm run typecheck` — exit 0
- `npm run lint -- --max-warnings=0` — exit 0
- `npm run test:tenant-isolation` — "Tenant isolation check passed."
- `npm run test:observe` — 124/124 pass (102 at baseline; +22 new: supersession ×2 in
  `suggestions.test.ts`, scorer outcomes / cancellation re-check / parser / calibration
  bucketing ×15 in new `suggestion-scoring.test.ts`, readout calibration ×2 +
  method-agreement ×3 in `readout.test.ts`)
- `npm run test:observe-schedule` — 6/6 pass

## Commits

- `c142363` feat(observe): supersede prior suggestions instead of deleting them
- `2a80e4e` feat(observe): shadow suggestions from day 1 for ungraduated tenants
- `ed38c56` feat(observe): ghost scorer — settle real-world outcomes onto suggestion history
- `ed61829` feat(observe): calibration report in the readout — graduation evidence
- `a474ceb` feat(observe): method-agreement (experimental) section in the readout

## Notes for auditors

- The cumulative-cap guard change (`status: { notIn: ["pending", "shadow", "superseded"] }`)
  is load-bearing: without it, daily superseded history would count as "prior drops" and
  permanently block regenerated nights. Worth a second pair of eyes.
- `realisedRate` for multi-unit nights is the MEAN `revenueAllocated` across occupied facts
  (per-unit nightly rate, comparable to `proposedValue`), not the sum.
- The scorer treats an occupied fact with no linked reservation as a live booking (no
  `createdAt` available ⇒ `daysToBookingAfterSuggestion: null`).
- Method agreement uses ANY suggestion row (all statuses) as "flagged" — including
  superseded generations — since the question is "did the method ever flag this night".
- First scorer pass after deploy scores the whole 120-day lookback in one go (per-row
  `updateMany`); volume is bounded by rows existing post-deploy, so this is small at first.
- Pre-existing untracked files at session start (`.claude/`, `RELIABILITY-FINDINGS.md`,
  `trial-reports/`) were left untracked — they predate this run and are not part of it.
