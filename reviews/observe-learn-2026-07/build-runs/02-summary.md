> **Update 2026-07-04:** everything below was subsequently built, independently audited (SAFE, three auditors) and **deployed live** (prod `7500a9e`, then `9e71e9f` docs). TO DEPLOY blocks below are historical. See DECISIONS.md entry 2026-07-04.

# Build run 02 — Tenant-lifecycle-proof scheduling + learning starvation visibility

Run date: 2026-07-04 (overnight, autonomous). Branch: `feat/observe-learn-fixes-2026-07`.
Starting commit: `8acffbba` (end of build run 01).

## TO DEPLOY (nothing was deployed; Mark's morning steps)

1. **Migration (before or with the deploy):** the new `observe_learning_ledger` table
   needs `20260704040000_observe_learning_ledger` applied to prod:
   `DATABASE_URL="$DATABASE_PUBLIC_URL" npx prisma migrate deploy`
   (NEVER `migrate dev` on prod). Applied to the LOCAL dev DB already.
2. **Restart the `signals-worker` Railway service.** This is the step that (a) puts the
   new reconcile/self-heal code live and (b) immediately re-enrols the two currently
   unobserved tenants (Escape Ordinary, Demo Property Manager — recreated with new ids
   after the last boot). Their 30-day observation clocks start from this restart.
   After this one restart, tenant churn no longer needs a worker restart: the new
   05:15 daily reconcile job picks up created/deleted tenants by itself.
3. Verify: worker logs should show
   `[observe] registered daily (05:30) + weekly settle (Mon 06:00) + reconcile (05:15)` on boot,
   and next morning `[observe] reconcile: N tenant(s), added X, pruned Y`. The two dead
   tenant ids stop throwing `tenant not found` (their schedules self-prune on first fire, or
   the boot prune-all clears them). The readout (`/api/observe/readout?...&format=text`)
   now ends with an `estate` block listing every tenant.

## What changed

### 1. Run-time tenant reconciliation (`6ba899b`)
- New single estate-wide repeatable `observe-reconcile` (05:15 Europe/London, before the
  05:30 runs): re-enumerates `tenant.findMany` at run time, enrols tenants missing a
  daily/settle schedule, prunes schedules whose tenant id no longer resolves or whose
  cron/tz drifted, and re-adds itself if pruned. Reuses the existing prune-before-re-add
  pattern.
- Dead-tenant self-heal in the worker's `processJob`: a job whose tenantId no longer
  resolves logs a clear warning, removes that tenant's own repeatables and returns a
  skip result — instead of throwing `observe: tenant <id> not found` daily forever.
- `ensureObserveSchedules` (boot) also registers the reconcile job; observe crons now
  come from one source of truth (`src/lib/observe/config.ts`).

### 2. Learning ledger with null-reasons (`0c44b41`)
- New append-only tenant-scoped Prisma model `ObserveLearningLedger`
  (`observe_learning_ledger`: tenantId, clientKey, runAt, learning, sampleCount,
  nullReason; `@@index([tenantId, runAt])` + `@@index([tenantId, learning, runAt])`).
- Every observe/settle run appends one row per learning #1–#7: the sample count used,
  or an explicit reason for producing nothing (`daily_aggs empty — no rows in trailing
  365d`, `no engine changes …`, `fewer than 10 reservations …`, `not computed on the
  daily run (weekly settle only)`).
- Learning #1 (pickup velocity) is recorded as `not wired` every run — visible, not
  silently absent. `net_realised` distinguishes "daily run never computes it" from an
  actually-empty reservation source, which makes the fee-drag daily-null-overwrite
  visible in the ledger (fixing the overwrite itself is out of scope per the prompt).
- Pure builder `buildLearningLedger` + thin `writeLearningLedger` (createMany), wired
  through `accumulateLearning` in `observe-service.ts`.

### 3. Estate health + starvation matrix in the readout (`41cb209`)
- `buildReadout` now also builds an `estate` block from the FULL tenant table (not from
  `observation_windows`): per tenant, last successful run
  (`ObservationWindow.lastRunAt`), day/status, and a red warning when a tenant has **no
  observation window at all** or **no completed run in 48h**.
- Learning-starvation matrix: per tenant per learning #1–#7, days since the last
  non-null ledger value (`never` when none; red when >7 days or never).
- Pure assemblers (`assembleEstateHealth`, `assembleStarvationMatrix`) are unit-tested;
  the estate data flows automatically through the key-gated JSON/`format=text` routes
  because they serialise `ReadoutData`.

## Not fixed here (deliberately, per prompt §4)

The learnings themselves (regret definition, pricing power on empty `daily_aggs`, the
fee-drag weekly/daily overwrite, pickup velocity wiring) are covered by other prompts.
This run only makes their starvation visible and the scheduling resilient.

## Test evidence (full green gate, all exit 0)

- `npm run typecheck` — clean.
- `npm run lint -- --max-warnings=0` — clean.
- `npm run test:tenant-isolation` — "Tenant isolation check passed."
- `npm run test:observe` — 102 pass / 0 fail (was 97 at run start; new: 4 ledger tests
  in `learnings.test.ts`, 5 estate/starvation tests in `readout.test.ts`; suite list in
  `package.json` updated to include `learnings.test.ts`).
- `npm run test:observe-schedule` — 6 pass / 0 fail (new: reconcile enrols new tenant +
  prunes dead one; drifted cron replaced + missing reconcile re-added; per-tenant
  schedule removal; boot ensure now ends with 2×tenants + 1 reconcile repeatables).
- Smoke test against the local dev DB (Little Feather tenant): 7 ledger rows written
  with correct sampleCounts/nullReasons (`engine_reaction` → "no engine changes …",
  `net_realised` → "weekly settle only"); readout estate lists all 6 local tenants "ok"
  (all local windows ran within 48h — verified in Postgres); HTML contains the estate
  section and starvation matrix.

## Commits

- `6ba899b` feat(observe): run-time tenant reconciliation — daily reconcile job + dead-tenant self-heal
- `0c44b41` feat(observe): learning ledger — per-run sample counts + null-reasons for learnings #1-#7
- `41cb209` feat(observe): estate health + learning-starvation matrix in the readout

## Notes for auditors

- The estate queries in `buildReadout` are deliberately cross-tenant (`tenant.findMany`,
  `observationWindow.findMany`, ledger groupBy). The readout is the internal
  system-state tool and never client-facing; none of the CLAUDE.md-protected tables
  are queried without a tenant filter. `test:tenant-isolation` passes.
- Migration was applied to the local dev DB via `prisma db execute` +
  `prisma migrate resolve --applied` (the dev DB has pre-existing drift, so
  `migrate dev` demands a destructive reset — avoided). Prod applies it normally via
  `prisma migrate deploy`.
- `ObservationWindow.lastRunAt` (stamped by `advanceObservationWindow` at the end of
  each run) is used as the "last successful run" timestamp rather than a new field —
  it is written after capture/controls/learning complete. Post-graduation suggestion
  generation runs after the stamp; a suggestions-only failure would not show as a
  stale run. Acceptable for the 48h liveness warning; flagging for awareness.
- Pre-existing untracked files (`.claude/`, `RELIABILITY-FINDINGS.md`,
  `trial-reports/`) were present before this run started and were left untouched.
