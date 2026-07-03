> **Update 2026-07-04:** everything below was subsequently built, independently audited (SAFE, three auditors) and **deployed live** (prod `7500a9e`, then `9e71e9f` docs). TO DEPLOY blocks below are historical. See DECISIONS.md entry 2026-07-04.

# Build run 06 - Learner weekly report, readable by Mark

Prompt: `reviews/observe-learn-2026-07/BUILD-PROMPTS/06-weekly-readable-report.md`
Branch: `feat/observe-learn-fixes-2026-07` · Starting commit: `498754d` · Date: 2026-07-03/04 (overnight, autonomous)

## TO DEPLOY (nothing deployed by this run - Mark was asleep)

Local branch only; nothing pushed, nothing deployed, no prod access. Ships with
the rest of this branch under the standing deploy protocol. Once the worker
restarts on the new code, the first real email fires after the next Monday
06:00 Europe/London settle completes for every tenant. No migration exists.

**TO REVIEW first:** the example email rendered from fixtures at
`observe-reports/learner-weekly-example-2026-07-06.html` (JSON alongside).
This is the format Mark judges - open it on a phone.

## What was built (one fix per commit)

| Commit | Change |
|---|---|
| `df13694` | `src/lib/observe/weekly-report.ts` + 16 unit tests wired into `test:observe`. One weekly email, "Signals learner – weekly report", covering every client in plain host language: (1) headline box per client - healthy (ran this week, data flowing), days until suggesting or "suggesting since <date>", and the single most useful thing learned so far (ghost-scoring evidence preferred, then lead times, then day-of-week strength, each with its count); (2) "what we would have done this week, and what actually happened" from the ghost scorer's settled nights (booked-anyway count, average realised £ vs the £ it would have dropped to, empties, cancellations), with an explicit not-enough-data state that says when results will first appear (first Monday after the earliest flagged stay settles); (3) safety-gate holds in words from the persisted blocked counters; (4) blind spots translated from the learning ledger's null-reasons into one plain sentence each; (5) coming up - graduation dates, event windows in the next 60 days via the shared `eventAdjustmentForDate`, and decisions needed (pending approvals). `resolveLocalEvents` exported from `suggestions.ts` for reuse. |
| `acb03c3` | Worker wiring: each tenant's settle records an ATTEMPT (success or failure, so one failing tenant cannot block the report forever); once every tenant has attempted this ISO week, the report generates once (week-keyed `.done` guard), writes `observe-reports/learner-weekly-<date>.html`/`.json`, and emails once (week-keyed `.email-sent` guard, same marker-file pattern as the day-30 runner). `maybeSendWeeklyLearnerReport` never throws; an email failure is logged, the artefacts survive, and the retry is next week's report. |
| `99459d9` | `scripts/render-weekly-report-example.ts` + committed example artefacts covering five client states: graduated with full evidence, mid-window (9 days to go), flagged-but-nothing-settled-yet, quiet week, and a paused client (not checked in 12 days) shown loudly in a red box, never silently absent. Two copy fixes found by reading the render: an em dash in the no-blind-spots line and headline capitalisation. |
| (this commit) | Build-run summary. |

## Design decisions

- **Trigger:** settle jobs run serialised (queue concurrency 1), all fired Mon
  06:00. Completion is tracked in `learner-weekly-<week>.settles.json`
  (attempts, not successes) rather than a DB table - the prompt forbids new
  tables, and the `.email-sent` file-guard pattern already exists. Duplicate or
  re-fired settles in the same ISO week hit the `.done`/`.email-sent` guards.
- **"Blocked this week" honesty:** the daily runs persist only the LATEST
  generation's blocked counters (`ObservationWindow.lastSuggestionRun`), so the
  email says "in the latest daily check (<date>)" instead of pretending to sum
  a week. Reuses persisted data only, per the prompt.
- **No jargon/no ids:** renderer test bans `tenantId`, `NightFact`, `regret`,
  `rung`, `clientKey`, `listingId`, em dashes and `<table` (single column,
  phone-first). Client names only; the report needed no listing names.
- **Email:** reuses `sendDailyReportEmail` (Resend) with
  `includeBuildLog: false` - the weekly report must not carry engineering
  notes.

## Test evidence (full gate green at HEAD)

- `npm run typecheck` - exit 0
- `npm run lint -- --max-warnings=0` - exit 0
- `npm run test:tenant-isolation` - "Tenant isolation check passed."
- `npm run test:observe` - **183/183 pass** (167 at this run's baseline; +16 new
  `weekly-report.test.ts`: ISO week key incl. year boundaries, next-Monday and
  GB date helpers, all-tenants-settled set logic, weekly outcome windowing and
  averages, first-results-expected dates, null-reason translations carry no
  jargon, most-useful picker order and fallback, event-window grouping via
  `eventAdjustmentForDate`, graduated/observing headline states, exact
  not-enough-data sentences, not-run client prominent in data and HTML,
  windowless client marked never checked, renderer hygiene, runner
  waits-for-all/generates-once/email-guard, email failure non-fatal +
  next-week retry.)
- `npm run test:observe-schedule` - 6/6 pass

## Notes for auditors

- The trigger records settle ATTEMPTS: if `runWeeklySettleForTenant` throws,
  the report still counts that tenant as attempted and the client shows up as
  unhealthy in the report itself. The settle error is re-thrown afterwards, so
  BullMQ still sees the failure.
- The report generation loops tenants sequentially and reads: observation
  windows, client profiles, learning ledger, suggestions (scored/pending), and
  pricing settings via `resolveLocalEvents` - all tenant-scoped; no query on
  the CLAUDE.md-listed tables lacks a `tenantId` filter.
- Pre-existing issue noticed, NOT fixed (out of scope, predates this branch at
  `dc21974`): `src/lib/email/daily-report-email.ts` hard-codes `REPO_ROOT` to a
  deleted `.claude/worktrees/strange-spence-7704a8` path, so the day-30 email's
  BUILD-LOG embed silently never loads. The weekly report is unaffected
  (`includeBuildLog: false`).
- Pre-existing untracked files (`.claude/`, `RELIABILITY-FINDINGS.md`,
  `trial-reports/`) were present before this run and left alone.
