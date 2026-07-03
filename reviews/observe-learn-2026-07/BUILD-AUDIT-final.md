# Independent build audit (final): scorer F1 fix + learner weekly report

Auditor: independent adversarial session, no context from the build agents.
Date: 2026-07-03. Branch: `feat/observe-learn-fixes-2026-07`.
Scope: everything after the already-audited base `c9b35e6`
(`git log c9b35e6..HEAD` = `d301f73`, `498754d`, `df13694`, `acb03c3`, `99459d9`, `7500a9e`).
Nothing was committed, pushed, deployed or modified by this audit; the only file
written is this one. All DB exercises ran against the local dev Postgres
(Docker `hostaway-postgres`, `DATABASE_URL` host `localhost:5432`), never prod.

## Verdict: SAFE to ship (no blockers; four non-blocking findings below)

## 1. Green gate, re-run independently at HEAD (`7500a9e`)

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint -- --max-warnings=0` | exit 0, no warnings |
| Tenant isolation | `npm run test:tenant-isolation` | exit 0, "Tenant isolation check passed." |
| Observe suite | `npm run test:observe` | exit 0, 183 tests, 183 pass, 0 fail |
| Schedule suite | `npm run test:observe-schedule` | exit 0, 6 pass |

## 2. Scorer fix (F1) proven on a live local DB, not just unit tests

Exercise: seeded a throwaway tenant + listing + four past-dated `price`
suggestions with matching `NightFact` rows, then ran the real
`scoreSettledSuggestions` (`src/lib/observe/suggestion-scoring.ts:381`) three
times. Results (tenant deleted afterwards; dev DB only):

- Night occupied only by `status = "ownerstay"` (revenue 0): NOT scored
  `booked_no_action`; left unscored with `detail.scoreSkip.reason =
  "non_revenue_occupancy"`. Pass 1: `skipped=2, scored=2,
  outcomes={booked_no_action:2, expired_empty:0, cancelled_after_booking:0}`.
- Night occupied only by a fact at revenue exactly 5 (`MIN_REAL_REVENUE`,
  `src/lib/observe/drop-outcomes.ts:37`, boundary is `<=`): also skipped.
- Real booking at revenue 200: scored `booked_no_action`, `realisedRate = 200`.
- Boundary fact at revenue 5.01: counts as a real booking (scored).
- Pass 2 (idempotency): `skipped=2, scored=0`; scored rows are not rescored and
  the skip marker is written once (`hasSkipMarker`, suggestion-scoring.ts:479).
- Pass 3 (sync correction): adding a real 180 booking alongside the owner block
  flipped the skipped night to `booked_no_action` with `realisedRate = 180`
  (real facts only, owner block excluded from the average) and removed the
  `scoreSkip` marker (`detailWithScore` drops it, suggestion-scoring.ts:470).

The pure function change (suggestion-scoring.ts:114-161) filters
`realLiveFacts` on `status !== "ownerstay" && revenueAllocated >
MIN_REAL_REVENUE`, matching the convention already used by `learnings.ts` and
`scripts/mine-drop-outcomes.ts`. Genuinely empty nights still score
`expired_empty`; the cancelled-after-booking path is unchanged. The settle log
line now carries `skipped=` (`observe-service.ts:252`). Writes are
`updateMany({ where: { id, tenantId } })` on `Suggestion.detail` only.
4 new unit tests pin the behaviour (`suggestion-scoring.test.ts`).

## 3. Weekly report vs its prompt (BUILD-PROMPTS/06-weekly-readable-report.md), item by item

- **One email covering all clients, weekly settle only:** the report fires only
  from the `kind === "settle"` branch of the observe worker
  (`src/workers/observe-worker.ts:88-119`); daily runs never touch it. Each
  tenant's settle records an attempt in `learner-weekly-<week>.settles.json`;
  generation happens once, after every tenant has attempted
  (`allTenantsSettled`, weekly-report.ts:75). Settle jobs run at queue
  `concurrency: 1` (observe-worker.ts:250), so the read-modify-write of the
  settles file is serialised.
- **ISO-week `.email-sent` guard, no double send:** proven live via the deps
  seam (`WeeklyReportDeps`) with a counting fake `sendEmail`: first full settle
  generated and emailed once (`msg-1`); a re-fired settle in the same ISO week
  returned `skipped=true` and the email count stayed at 1. Markers written:
  `learner-weekly-2026-W28.done` and `learner-weekly-2026-W28.email-sent`.
  `isoWeekKey` unit tests cover year boundaries; W28 for Monday 2026-07-06 is
  correct.
- **Email failure must not fail the settle:** proven live with a throwing
  `sendEmail`: `maybeSendWeeklyLearnerReport` returned normally,
  `errors=["email failed: resend down"]`, HTML + JSON artefacts and the `.done`
  marker were written, and no `.email-sent` marker exists, so the retry is next
  week's send (matches the prompt: "log, retry next week, artefacts still
  written"). The whole runner body is wrapped in try/catch and never throws
  (weekly-report.ts:780-854); the worker re-throws the original settle error
  AFTER the report attempt so BullMQ still sees a failed settle
  (observe-worker.ts:118).
- **Shadow-calibration numbers with n:** yes. Example: "Of 120 nights the
  system would have dropped the price on, 68 booked anyway with no drop, at an
  average of £95 a night against the £78 it would have dropped to." followed by
  "40 stayed empty and 12 were booked but later cancelled." The £ averages are
  over the 68 booked nights named in the same sentence. The headline evidence
  line carries both n and percentage: "Of the 300 nights it would have cut
  prices on so far, 164 (55%) booked anyway with no cut."
- **Blocked-gates section:** present, in words ("the price is already at its
  minimum", "the night is during an event and priced up on purpose", "the
  price has already been dropped recently", "a price drop was already approved
  for that night"), with counts per reason and the check date.
- **Blind spots from ledger null-reasons, including a client that did not
  run:** present. The fixture "Demo PM" (last checked 12 days before) appears
  in a red "Needs attention" alert at the top, in a red headline card, and
  leads its blind-spots card with "was not checked this week ... so its
  learning is paused". A client with no observation window at all renders
  "never checked" (unit-tested).
- **Graduation and event dates:** "Little Feather Management finishes its
  learning period and starts suggesting on 15 July 2026." Event windows come
  from the shared `eventAdjustmentForDate` (`upcomingEventWindows`,
  weekly-report.ts:602) over the next 60 days: "Fleadh Cheoil (2 August 2026
  to 9 August 2026) is priced up 40%, so no drops will be suggested for those
  nights." Decisions needed (pending approvals) are listed.
- **No keys / tenant ids / listing ids:** grep of both committed artefacts for
  `tenantId|listingId|clientKey|cm[a-z0-9]{20}` and for
  `NightFact|regret|rung` found nothing. The renderer test bans them too
  (weekly-report.test.ts:296-317). The `settles.json` file contains tenant ids
  but lives on the worker filesystem and is never emailed or rendered.
- **Phone-readable single column:** `max-width:560px`, cards, no `<table` (grep
  count 0), viewport meta present.
- **Host language:** I read every sentence of the rendered example. All numbers
  carry their n; the "not enough data yet" states are honest and specific
  ("The results checker has not settled any of Yo's House & Short Stay
  Harrogate's flagged nights yet. Each night is checked 2 days after the stay,
  so the first results should appear in the report on Monday 13 July 2026."
  which is arithmetically correct: earliest flagged stay 8 July + 2 days lag =
  10 July, next Monday 13 July). Two sentences are borderline, quoted in
  findings F3 and F4 below; nothing is incomprehensible to a non-technical
  host.

## 4. Example email rendered and read by this auditor

Re-ran `scripts/render-weekly-report-example.ts` from a clean directory: the
output is byte-identical to the committed
`observe-reports/learner-weekly-example-2026-07-06.html` and `.json`
("ARTEFACTS MATCH COMMITTED"). The report is genuinely good: the five fixture
states (graduated with evidence, mid-window, flagged-but-unsettled, quiet week,
paused client) each read as one or two plain sentences, the paused client is
loud, and the prompt's bar sentence ("Of 120 nights the system would have
dropped, 68 booked anyway") is met almost verbatim. Zero em dashes in the
rendered HTML and JSON (the title's dash is an en dash, which is allowed).

## 5. Constraints

- **tenantId filters:** every new query on guarded models carries one.
  Scorer: `nightFact.findMany` (suggestion-scoring.ts:428),
  `reservation.findMany` x3 (:433, :451, :461), `rateChange.findMany` (:445),
  `suggestion.updateMany` (:525, :540, :555). Weekly gather
  (weekly-report.ts:626-673): observation window and client profile via
  `tenantId_clientKey` unique keys, suggestions/ledger/pending counts filtered
  by `tenantId`, `resolveLocalEvents` (pre-existing, tenant-scoped) reused.
- **No hostaway / pace / AirROI touches:** `git diff --name-only c9b35e6..HEAD`
  matches nothing under `src/lib/hostaway`, `src/lib/sync/pace.ts`,
  `src/lib/reports/service.ts` or anything AirROI.
- **Read-only posture:** the only DB write in the whole range is
  `Suggestion.detail` in the scorer. The weekly report writes files only.
- **Em dashes:** none in the rendered report, the JSON artefact, or the two
  build-run docs (`06-summary.md`, `06-remediation-summary.md`). See finding F1
  for the exceptions in the committed prior-audit docs.
- **Working tree:** clean apart from the three pre-existing untracked paths
  (`.claude/`, `RELIABILITY-FINDINGS.md`, `trial-reports/`) that predate this
  branch's work.
- **Commits coherent:** six commits, each a single concern (prior-audit docs,
  scorer fix + its tests + its summary, report lib + tests, worker wiring,
  example artefacts, run summary), matching the one-fix-per-commit rule.

## Findings (none blocking)

- **F1 (style, docs):** `BUILD-AUDIT-behaviour.md` (34) and
  `BUILD-AUDIT-code.md` (54) contain em dashes, against the house rule. They
  are verbatim prior-audit reports committed at `d301f73`, and three commit
  subjects also carry em dashes. Everything the build itself wrote (code
  output, artefacts, 06 docs) is clean.
- **F2 (prompt deviation, documented and honest):** the prompt asked for
  blocked counts "this week"; the daily runs persist only the latest
  generation's counters (`ObservationWindow.lastSuggestionRun`), so the email
  says "in the latest daily check (<date>)" instead of pretending to sum a
  week. Correct call under the "reuse persisted data only, no new tables"
  rule, and stated plainly in `06-summary.md`. If Mark wants a true weekly sum
  it needs the counters persisted per run, a future change.
- **F3 (copy, quoted per the audit brief):** "No daily check has recorded
  safety-gate counts for Demo PM yet." The phrase "safety-gate counts" is the
  closest thing to jargon in the email; the section intro does explain gates,
  but "has not yet recorded how many drops were held back" would be plainer.
  Similarly the header label "Week 2026-W28" is an ISO week code a host would
  not use, though the generated date beside it rescues it.
- **F4 (copy):** the paused-client headline reads "NOT CHECKED this week (last
  checked 24 June 2026), learning is paused; suggesting since 19 June 2026",
  which slightly contradicts itself (paused yet "suggesting since"). "was
  suggesting from 19 June 2026" would be cleaner. Cosmetic only.
- **Note (pre-existing, out of range):** `06-summary.md` correctly flags that
  `src/lib/email/daily-report-email.ts` hard-codes a deleted worktree path for
  the day-30 BUILD-LOG embed; the weekly report is unaffected
  (`includeBuildLog: false`). Predates this branch.

## Not deployed

Nothing in this range has shipped; the branch is local. Deployment stays under
the standing deploy protocol (worker restart required, since both changes live
in worker-side code paths).
