# Build prompt 02 – Tenant-lifecycle-proof scheduling + learning starvation visibility

Copy-paste this whole file into a fresh Claude Code session at the `signals` repo root.

## Context (self-contained; assume no memory of prior sessions)

The observe-and-learn system (`src/lib/observe/**`) runs a daily 05:30 Europe/London job per
tenant via BullMQ repeatables. A July 2026 review (`reviews/observe-learn-2026-07/REVIEW.md`,
agent file `05-live-data-audit.md`) found two operational failure classes, both live in prod:

1. **Boot-only scheduling.** `ensureObserveSchedules` registers one repeatable per tenant only
   at worker boot (`src/workers/observe-worker.ts`, around lines 67-99, called once in
   `startWorker`). On 2026-07-03 two tenants (Escape Ordinary, Demo Property Manager) were
   deleted and recreated with new ids AFTER the last worker boot. Result: the queue holds
   repeatables for two dead tenant ids that throw `observe: tenant <id> not found`
   (`src/lib/observe/observe-service.ts` ~line 110) every morning, while the two new tenants
   are silently unobserved until someone restarts the worker. Failures go only to worker logs;
   the readout builds from `observation_windows`, so an absent tenant is invisible in the very
   tool meant to show system state.
2. **Silent learning starvation.** Prod `daily_aggs` has 0 rows, which makes learning #4
   (pricing power) null for every client, and this survived six green runs unnoticed because a
   null learning and a computed learning look identical in the logs. Similarly, fee drag is
   computed on the weekly settle and overwritten with null by the next daily run.

## Task

Work on a branch off `main`.

1. **Run-time tenant reconciliation.** Replace boot-only registration with one of (choose the
   simpler that fits the existing BullMQ patterns in this repo):
   - a single daily dispatcher repeatable that enumerates `tenant.findMany` at run time and
     enqueues one observe job per tenant; or
   - a reconcile step at the top of each scheduled run window that prunes repeatables whose
     tenantId no longer resolves and adds repeatables for tenants that lack one (the
     prune-before-re-add pattern already exists in `ensureObserveSchedules`; reuse it).
   Either way: a job whose tenantId no longer resolves must log a clear warning and remove its
   own schedule rather than throwing daily forever.
2. **Per-tenant health in the readout.** Persist a last-success timestamp per tenant per run
   (a small tenant-scoped table or a field on `ObservationWindow`), and render in the readout
   (`src/lib/observe/readout.ts`): every tenant in the estate (from `tenants`, not from
   `observation_windows`), its last successful run, and a visible warning line for any tenant
   with no completed run in 48h or no observation window at all.
3. **Learning ledger with null-reasons.** Add an append-only tenant-scoped table (suggested:
   `ObserveLearningLedger`: tenantId, runAt, learning key, sampleCount, nullReason nullable,
   `@@index([tenantId, runAt])`). Have `computeClientLearnings`
   (`src/lib/observe/learnings.ts`, ~lines 252-279) and the profile writer record, per run and
   per learning (#1-#7): the sample count it used, or why it produced nothing (e.g.
   `daily_aggs empty`, `no engine snapshots`, `no engine changes`). Render a starvation matrix
   in the readout: per client per learning, days since the last non-null value.
4. **Do not fix the learnings themselves here** (separate prompts cover regret, pricing power
   etc.). This prompt is about making starvation visible and scheduling resilient.

## Constraints (house rules, non-negotiable)

- Every new Prisma query touching `Listing`, `Reservation`, `NightFact`, `PaceSnapshot`,
  `CalendarRate`, `DailyAgg`, or `SyncRun` MUST filter by `tenantId`; new tables get
  `@@index([tenantId, ...])` (see `scripts/test-tenant-isolation.ts`).
- New Prisma model means a migration: write it, but NEVER run `prisma migrate dev` against
  prod; prod migrations are applied manually via `DATABASE_PUBLIC_URL` + `prisma migrate
  deploy` per CLAUDE.md.
- Do not touch `src/lib/sync/pace.ts`, pace queries in `src/lib/reports/service.ts`, or
  anything in `src/lib/hostaway/**`. No AirROI.
- Owner preference: one fix per commit where practical.

## Green gate (all must pass)

```
npm run typecheck
npm run lint -- --max-warnings=0
npm run test:tenant-isolation
```

Plus unit tests covering: reconcile adds a schedule for a new tenant and prunes a dead one;
the ledger writes a nullReason when a learning's source is empty; the readout lists a tenant
that has no window.

## Finish

Report what changed, the test evidence, and the commit list. Then ask Mark explicitly:
**deploy to the live webapp or keep local?** Note for Mark: this change only takes effect once
the `signals-worker` Railway service restarts (that restart is also what re-enrols the two
currently unobserved tenants; their 30-day observation clocks start from that restart). If
this is an autonomous or overnight run and Mark cannot answer, do NOT auto-deploy: leave the
change local with a "TO DEPLOY" block at the top of your summary, including the migration step
(`prisma migrate deploy` via `DATABASE_PUBLIC_URL`) and the worker restart. If Mark says
deploy, follow the standing deploy & self-heal protocol in CLAUDE.md end to end.
