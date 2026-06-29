# Signals — Operational notes for Claude

This file captures the load-bearing constraints that are easy to break by
accident. Read it first before touching the sync engine, pricing logic, or
the AirROI integration.

## Required reading on session start

This file (`CLAUDE.md`) covers long-lived constraints. Before doing meaningful work, also read:

- `DECISIONS.md` at repo root — the shared strategic-decision log between Mark, the Cowork Claude assistant, and this agent. Append-only. New entries go to the bottom. Read it in full at session start; reference it when a decision feels surprising.
- `BUILD-LOG.md` at repo root — the autonomous-decision audit trail (Claude Code's own log). Reference when something in code looks unexpected or you need to understand why an earlier session made a particular call.

## Local vs live — always confirm deployment

Applying a change in the worktree or local checkout is **not** the same as it being live on the webapp. Quick patches have repeatedly been applied locally and never reached the running app because the deploy step was not explicitly requested.

**Rule:** any task that changes code or behaviour is not "done" until you have explicitly asked Mark whether the change should be **deployed to the live webapp** or **kept local**. Ask this every time — do not wait for Mark to remember to specify it.

- If Mark says deploy: carry it out, or — since Mark has little coding experience — give simple, ordered, copy-pasteable steps. "Deployed" means the Next.js webapp **and** the background workers are running the new code; a worker process started before the change keeps running stale code until restarted. State how Mark can verify it is live.
- If Mark says keep local: note it explicitly in your output so a later session knows the change has not shipped.
- On an autonomous / overnight run where Mark cannot answer in real time: do **not** auto-deploy. Leave the change local and put a clear "TO DEPLOY" block at the top of the run summary with exact steps, so deploying is a one-action morning task rather than a forgotten one.

## Sync window environment variables

The reservation backfill window controls how far back and forward the engine
asks Hostaway for reservations when there is no `last_sync_at` to anchor a
delta pull (i.e. first sync, re-add, or `forceFull: true`).

| Env var             | Default | Meaning                                              |
| ------------------- | ------- | ---------------------------------------------------- |
| `SYNC_DAYS_BACK`    | `730`   | Days before today to pull reservations from.         |
| `SYNC_DAYS_FORWARD` | `365`   | Days after today to pull reservations from.          |

Default back window is **730** days (two years): YoY pace comparisons
require the current 365 days plus the 365 days before that, so 730 is the
operational minimum. Defaults moved 800/540 → 365/365 on 2026-04-25, then
365 → 730 on 2026-04-26 once the YoY requirement was reasserted. If a
client needs more than 730 days of history, set the env var on their
service (e.g. `SYNC_DAYS_BACK=1095`) and trigger a re-sync — do not
change the defaults.

The calendar fetch window (`calendarBackDays: 90`, `calendarForwardDays:
365`) is unrelated and not env-overridable.

## Trial events lever (Fleadh)

The KeyData comparison agent reads its local events from a **trial-only**
source — `src/lib/agents/pricing-comparison/trial-events.ts` — NOT from
`settings.localEvents`. The trial source is invisible to
`pricing-report-assembly.ts` and the Hostaway push-service path, so
loading an event into it cannot change a single customer-facing rate.

The shared date-resolution helper is `eventAdjustmentForDate` in
`src/lib/pricing/events.ts` (one source of truth; both the trial agent
and the main pricing path import it). Future event tuning lives in
`trial-events.ts`; the cap on any single trial event's adjustment is
`TRIAL_EVENT_ADJUSTMENT_PCT_CAP` (currently 60%).

Fleadh Cheoil 2026 (Belfast, 2026-08-02 → 2026-08-09, +40%) was loaded
on 2026-05-22 — that constraint from earlier daily specs ("don't load
Fleadh — that is the next night") is now satisfied. Loading other
named events follows the same trial-only pattern; do **not** route them
through `settings.localEvents` unless the explicit goal is to change
customer-facing prices.

## AirROI is removed

The AirROI subsystem was deleted in the 2026-06-29 audit (it was already
runtime-dead — `market-data-provider.ts` returned `null` unconditionally and
only ever fed the Calendar part of the report). Gone: `src/lib/airroi/**`,
`src/lib/pricing/market-data-provider.ts`, `src/lib/external-api-cache.ts`, and
the `airroi*` fields in `env.ts`. **Do not** re-introduce AirROI — the Key Data
integration is the planned replacement. Pricing recommendations work without
external market signals, falling back to own-history + cached comparator data.

`src/lib/pricing/market-recommendations.ts` is **kept** (the Key Data scaffold);
it still short-circuits to an empty Map. The `AIRROI_*` /
`ROOMY_ENABLE_LIVE_MARKET_REFRESH` env vars on the Railway `Signals` +
`signals-worker` services are now dead — unset them and rotate the old
`AIRROI_API_KEY`. The `external_api_cache` Prisma model/table was left in place
(dropping it needs a deliberate migration).

## Hostaway public API + webhooks

The next milestone after this overnight review is to layer Hostaway's
public API + webhook integration on top of the existing pull-based sync.
**Do not pre-build for it.** Anything in `src/lib/hostaway/**` should
remain stable until that work officially starts.

## Cancelled-booking pace logic

`src/lib/sync/pace.ts` and the pace queries in `src/lib/reports/service.ts`
correctly attribute cancelled-then-rebooked nights to the snapshot date the
cancellation occurred on. Owner has confirmed this is working as expected;
**do not refactor it**.

## Multi-tenant isolation

Every Prisma query that touches `Listing`, `Reservation`, `NightFact`,
`PaceSnapshot`, `CalendarRate`, `DailyAgg`, or `SyncRun` MUST include a
`tenantId` filter. Indices in `prisma/schema.prisma` are all
`@@index([tenantId, ...])` for this reason. Any new query that omits the
tenant filter will return cross-tenant data — see the isolation test
`scripts/test-tenant-isolation.ts`.

## Pricing recommendation stability

The base price recommendation lives in `buildRecommendedBaseFromHistoryAndMarket`
at `src/lib/pricing/market-anchor.ts`. The header comment block on that function
describes the formula. Inputs are deterministic on the same data — if two
near-identical apartments produce different recommendations, suspect:
1. Different `pricing_settings` rows (per-listing override).
2. Different `historicalAnchorObservations` (different booking history).
3. Different cached comparable sets (location-derived, can drift).
4. Different `bedroomsNumber`/`personCapacity`/`roomType` on `Listing`.

Minimum price is always `roundToIncrement(base × 0.7)` — see the function
header for the full breakdown.

## Standing deploy & self-heal protocol (applies to EVERY change)

Any change that is meant to go live must follow this end-to-end. The goal: **solve
problems yourself and only come to Mark when you genuinely need him** (a secret, a
real decision, or access you don't have). **Never leave production in a broken or
half-deployed state** — the end state is always either the new version live and
healthy, or rolled back to the last known-good version and verified healthy.

**0. Safety net first.** Before changing anything: branch off `main`; tag the
current local tip (`backup/main-<task>`) and the **commit currently live in prod**
(`backup/prod-live` = current `origin/main`). The prod tag is the rollback target —
"exactly as before" means this commit. Write the rollback commands into a rollback
doc.

**1. Build + hard green gate (no deploy yet).** `npm run typecheck`,
`npm run lint -- --max-warnings=0`, `npm run test:tenant-isolation`, plus the tests
covering the change. If anything fails, fix it or restore `main` from the backup
tag and stop — do not push broken code.

**2. Capture a live baseline, then push.** Record prod health BEFORE deploying
(`curl` the prod URL `https://signals.roomyrevenue.com` root + a couple of routes,
status + that it renders the real app). Detect Railway reach (`railway whoami`).
Push `main` only after the gate is green (fast-forward; Railway auto-deploys).

**3. Activate + verify live.** Apply any pending migration with
`prisma migrate deploy` (NEVER `migrate dev` on prod). Restart the **worker**
service (`signals-worker`) so it runs new code — a web-only redeploy leaves the
worker on stale code. Health-check the live app against the baseline; confirm the
relevant worker log lines.

**4. Self-heal loop (bounded ~6 attempts / ~25 min), with explicit fixes:**
- New 5xx / missing-table / Prisma `P2021`/`P2022` → migration didn't apply → run
  `prisma migrate deploy` → re-check.
- Worker not registering its schedule / boot error → restart the worker, read logs →
  re-check.
- Still rolling out / transient 502 → wait 30–60s and retry within the cap.

**5. End state — one of exactly these, never a fourth:**
- New version live + healthy (matches baseline) + workers on new code → **done**.
- Healthy web, but an activation step needs access you lack (no Railway reach, a
  secret) → finish at healthy + hand Mark the precise remaining step(s). Do **not**
  spin.
- Can't reach healthy and can't fix it → **roll back prod**
  (`git push --force-with-lease origin backup/prod-live:main`, redeploy), verify
  health restored, then stop and report the single blocker.

**6. Report** the end state reached, evidence (baseline vs post-deploy health,
worker log lines), tags created, and the one-line local + production rollbacks.

Railway topology for the above: project `bubbly-quietude`; web service `Signals`,
worker `signals-worker`, plus Postgres + Redis; prod URL
`https://signals.roomyrevenue.com`. Migrations are **not** auto-applied on deploy
(apply manually via `DATABASE_PUBLIC_URL` + `prisma migrate deploy`).
