# Build prompt 06 – Learner weekly report, readable by Mark

Copy-paste this whole file into a fresh Claude Code session at the `signals` repo root.

## Context (self-contained; assume no memory of prior sessions)

The observe-and-learn system (`src/lib/observe/**`) runs a daily 05:30 Europe/London job and a
weekly settle (Mon 06:00) per tenant. A July 2026 review and overnight build
(`reviews/observe-learn-2026-07/`) added shadow suggestions with ghost scoring, a learning
ledger with null-reasons, per-tenant health, safety-gate blocked counters, and honest regret
figures. Mark's feedback, verbatim: "it's been difficult to observe the findings - I need
something readable for me each week in the learner weekly task report."

Mark is a non-technical Airbnb host. He prefers host language over jargon and cuts
marketing-style filler aggressively. The existing key-gated readout
(`src/lib/observe/readout.ts`, `/api/observe/readout`) is an engineer's view; this prompt adds
the owner's view.

Existing infrastructure to reuse, not rebuild:
- Weekly settle path: `runWeeklySettleForTenant` in `src/lib/observe/observe-service.ts`
  (fired Mon 06:00 Europe/London by the observe worker).
- Email: Resend via the existing email lib used by `day30-runner.ts` (env `RESEND_API_KEY`,
  `TRIAL_REPORT_EMAIL_FROM`, `TRIAL_REPORT_EMAIL_TO` are already set in prod), with the
  `.email-sent` marker-file guard pattern to prevent duplicate sends.
- Report artefacts directory: `observe-reports/`.

## Task

Work on the branch you are told to use. Build ONE weekly email, "Signals learner – weekly
report", generated after all tenants' weekly settles complete (one email covering every
client, not one per client), plus the same content written to
`observe-reports/learner-weekly-<date>.html` and `.json`.

Content, in this order, ALL in plain host language (a bullet is one plain sentence; every
number carries its n; no internal jargon - say "nights", "bookings", "price drops", never
"NightFact", "regret", "rung", "tenantId"):

1. **Headline box:** one line per client: is the learner healthy for this client (ran this
   week, data flowing), how many days until it starts suggesting (or "suggesting since
   <date>"), and the single most useful thing learned so far.
2. **"What we would have done this week, and what actually happened"** per client - the shadow
   calibration evidence: how many nights the system would have flagged for a drop, how many of
   those booked anyway with no drop, at what average rate versus what the system would have
   dropped to, and how many expired empty. Plain example the review set as the bar: "Of 120
   nights the system would have dropped, 68 booked anyway at full rate." If the scorer has not
   settled enough nights yet, say exactly that and when it will.
3. **Safety gates:** how many would-be suggestions were blocked this week and why, in words
   (event week, already at minimum price, already dropped recently). This is a trust metric -
   show it working.
4. **What the learner is still blind to,** per client, from the learning ledger's null-reasons,
   as one plain sentence each (e.g. "We cannot yet see engine price moves for X because no
   engine key is connected"). Include any client that did not run this week, prominently.
5. **Coming up:** graduation dates, event windows inside the next 60 days (via
   `eventAdjustmentForDate`), and anything needing a decision from Mark.

Rules:
- Generated on the weekly settle only; `.email-sent` guard keyed by ISO week; failure to email
  must not fail the settle (log, retry next week, artefacts still written).
- HTML must be readable on a phone (single column, no wide tables; the biggest numbers as
  short sentences, not grids).
- Reuse the data already persisted by the daily runs (profiles, ledger, scored suggestions,
  blocked counters). This prompt adds NO new learning and NO new tables (if a small view
  helper is needed, put it in `src/lib/observe/weekly-report.ts` with a pure, unit-tested
  core).
- The email never contains keys, tenant ids, or listing ids - listing NAMES and client names
  only.

## Constraints (house rules, non-negotiable)

- Every Prisma query touching `Listing`, `Reservation`, `NightFact`, `PaceSnapshot`,
  `CalendarRate`, `DailyAgg`, or `SyncRun` MUST filter by `tenantId`.
- Do not touch `src/lib/sync/pace.ts`, pace queries in `src/lib/reports/service.ts`, or
  `src/lib/hostaway/**`. No AirROI.
- UK English, no em dashes (en dashes fine), no emoji bullets, no marketing filler.
- One fix per commit where practical.

## Green gate (all must pass)

```
npm run typecheck
npm run lint -- --max-warnings=0
npm run test:tenant-isolation
npm run test:observe
```

Plus unit tests covering: the plain-language renderer on fixture data (including the
"not enough data yet" states), the ISO-week email guard, and that a client with no run this
week appears prominently rather than silently disappearing.

## Finish

Report what changed, the test evidence, and the commit list, and render one full example email
from local fixture data into `observe-reports/` so Mark can see the format before the first
real send.
