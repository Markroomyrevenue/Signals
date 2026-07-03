# Build audit — code and constraints (independent, adversarial)

Auditor: independent session, no context from the build agents. Scope: everything after
commit `9529135` on `feat/observe-learn-fixes-2026-07` (28 commits, 36 files,
+11,917 / -246). Date: 2026-07-03/04 overnight. All claims below re-verified by
re-running commands or reading the code, not taken from the build-run summaries.

## Verdict: SHIP-SAFE (no blocking findings)

## 1. Green gate — re-run by this auditor, all green

| Check | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run lint -- --max-warnings=0` | exit 0 |
| `npm run test:tenant-isolation` | "Tenant isolation check passed.", exit 0 |
| `npm run test:observe` | 163 tests, 163 pass, 0 fail (includes the new `learnings.test.ts`, `suggestion-scoring.test.ts`, `drop-outcomes.test.ts` wired into the script) |
| `npm run test:observe-schedule` | 6 tests, 6 pass, 0 fail |

`package.json` change is the `test:observe` file-list extension only.

## 2. Contract check per prompt — every numbered item

### Prompt 01 — suggestion safety gates: ALL 7 IMPLEMENTED
1. Min floor — `resolveListingFloors` (`src/lib/observe/suggestions.ts:440-489`):
   latest `EngineSnapshot.min` → property-scope `minimumPriceOverride` → lowest
   `rate_states` rate trailing 180d → `detail.floorUnknown`. Clamp uses `Math.ceil`
   (never undercuts a fractional floor); clamped ≥ current rate suppresses the row
   (`min_floor`, suggestions.ts:202-217). Done.
2. Event shield — `resolveLocalEvents` + `eventAdjustmentForDate` (the shared helper,
   suggestions.ts:13, 697); positive adjustment blocks with reason `event`. Read-only:
   nothing writes `settings.localEvents`. Done.
3. No compounding — `already_actioned` skip for approved/applied nights (any clientKey,
   per-night safety) + 14d/25% `cumulative_cap` (`resolvePriorSuggestionGuards`,
   suggestions.ts:548-613). Done.
4. Occupancy scaling — `computeDowOccupancy` (suggestions.ts:501-538), trailing-365d
   final occupancy per DOW from `NightFact` (tenant-filtered, unit-capped); raw curve
   value kept in the reason string. Done.
5. Multi-unit — booked only when occupied units ≥ unitCount; `revenueAtRisk = rate ×
   unsold units` (suggestions.ts:683-703). Verified `NightFact` PK is
   `(tenantId, date, listingId, factKey)` so per-(listing,date) row counts are a valid
   occupied-units count. Done.
6. Blocked counter — counted per reason, persisted on
   `observation_windows.last_suggestion_run`, rendered as the readout trust line
   (readout.ts:474-484). Done.
7. Listing names — tenant-filtered join, id fallback (readout.ts:318-329). Done.

### Prompt 02 — scheduling + starvation: ALL IMPLEMENTED
1. Run-time reconciliation — single 05:15 `observe-reconcile` repeatable
   (`reconcileObserveSchedules`, `src/workers/observe-worker.ts:129-186`) enumerates
   `tenant.findMany` at run time, prunes dead/drifted repeatables, enrols missing
   tenants; dead-tenant self-heal in `processJob` prunes the throwing schedule and
   logs a warning instead of throwing daily (observe-worker.ts:70-83). Done.
2. Per-tenant health — estate section built from the FULL tenant table with an
   explicit warning for no-window or >48h-stale tenants
   (`assembleEstateHealth`, readout.ts:97-137). Uses existing
   `ObservationWindow.lastRunAt` (the prompt allowed "a field on ObservationWindow").
   Done.
3. Learning ledger — `ObserveLearningLedger` model + additive migration
   (`20260704040000`), `@@index([tenantId, runAt])` + `@@index([tenantId, learning,
   runAt])`, append-only `createMany`; `buildLearningLedger` records sample counts /
   null-reasons for #1–#7 including the "not wired" pickup-velocity gap and the
   daily-vs-settle `net_realised` distinction; starvation matrix rendered. Done.
4. Learnings themselves not fixed here — correct (prompt 04 did that).

### Prompt 03 — history + shadow + ghost scoring: ALL 5 IMPLEMENTED
1. Supersession — `applySuggestionRegeneration` marks prior pending+shadow
   `superseded`, never deletes; human-actioned rows untouched; readout + API still
   pending-only (`app/api/observe/suggestions/route.ts:34` defaults `status=pending`).
   Done.
2. Shadow from day 1 — every daily run generates; graduated → `pending`, observing →
   `shadow` (observe-service.ts). Shadow excluded from readout pending list and the
   day-30 email; retention note present (no pruning built, per prompt). Done.
3. Ghost scorer — `scoreSettledSuggestions` on the weekly settle: 2d settle lag, 120d
   lookback, three outcomes, `realisedRate`/`realisedVsProposed`,
   `daysToBookingAfterSuggestion`, `rateMovedAfter`, late-cancellation re-check
   flipping `booked_no_action` → `cancelled_after_booking`. Writes only
   `Suggestion.detail`. Done.
4. Calibration report — last 200 scored, plain-English headline, drop-size and
   lead-time buckets each with `n` (readout.ts:521-558). Done.
5. Method agreement — RateChange drops ≥ 3%, dropped∧flagged / flagged-only /
   dropped-only, labelled "experimental" + observational (readout.ts:501-514). Done.

### Prompt 04 — regret / rules / global: ALL 4 IMPLEMENTED
1. Settled-nights regret — `computeRegret` (learnings.ts) over trailing 90d settled
   nights; pace-YoY baseline read from `PaceSnapshot` READ-ONLY with a trailing-DOW
   `DailyAgg` fallback; `held_too_low` uses gross `accommodationFare / nights` vs the
   min in force near booking (`nearestMinAt`, not latest); ≤£5 nights excluded; owner
   blocks structurally excluded (blocks are `available=false`); `none` class restored
   via `classifyRegret`/`computeSettledRegret`; `heldTooLow` null (not 0) without min
   data. Done.
2. Rule guards — below-min rule requires non-null input, renamed
   `below_min_long_lead` with a description matching the long-lead trigger,
   `allowBelowMinInShortWindows` GONE (grep confirms no `allowBelowMin` anywhere in
   `src/`), emitted `observationOnly: true`; `tolerates_empty_premium` requires
   `baselineSource !== "none"`; every rule carries `n` + window. Done.
3. Global recompute-from-latest — `recomputeGlobalMethodology` on settle only, equal
   weight per client, per-field sample counts, `samples` = contributing clients,
   deleted-tenant ghosts evicted; `anonymiseForGlobal` untouched;
   `mergeGlobalMethodology` retained for tests only; daily runs no longer fold, so the
   global feeDrag daily-null overwrite is gone. Done.
4. Surfacing — regret rendered as {value, n, window, baseline} with explicit
   insufficient-data states; artefact-rule disappearance evidenced by the local
   before/after table in `build-runs/04-summary.md` (prod recompute correctly deferred
   to deploy). Done.

### Prompt 05 — drop dose-response mining: ALL 5 IMPLEMENTED
1. Episode extraction — `collapseDropEpisodes` (listing × scan × contiguous span),
   3% noise floor, `stratifiedSampleEpisodes` across full history (not newest-first).
2. Outcome join — settled nights only; occupied excludes `ownerstay` and ≤£5 rows;
   empty counted only when the calendar visibly showed the night still open.
3. Matched comparison — same listing, same DOW, ±21d, still-unbooked-at-lead; no
   peer-ladder machinery used.
4. Output — JSON + markdown under `observe-reports/` keyed
   (lead bucket, 3-7/7-15/15%+, weekday/weekend) with per-cell `n`, honest
   "insufficient matched controls" flags, and all the required caveats (observational,
   selection-on-weakness, matching limits) plus extra ones (denominator mismatch,
   history depth).
5. Run local + prod — both reports committed; prod run was `findMany`-only.

**Independent verification of the run-05 reconciliation claim:** I re-ran the SQL on
prod (SELECT-only): `count(DISTINCT (listing_id, date))` of settled qualifying drops =
Coorie 478 / Little Feather 306 / Stay Belfast 188 / Yo's 344 — exactly matching the
summary's treated+unknown-terminal+no-record arithmetic (443+6+29, 275+21+10,
161+11+16, 325+12+7).

## 3. Constraint sweep — CLEAN

- `git diff 9529135..HEAD -- src/lib/hostaway src/lib/sync/pace.ts
  src/lib/reports/service.ts src/lib/airroi` → **0 lines**. No AirROI
  reintroduction anywhere in the diff.
- `PaceSnapshot` is READ in the regret baseline only (learnings.ts, tenant-filtered);
  pace writing untouched.
- Every new Prisma query on guarded models carries `tenantId`:
  `calendarRate`/`nightFact`/`listing`/`reservation`/`dailyAgg`/`paceSnapshot` in
  suggestions.ts, suggestion-scoring.ts, learnings.ts, readout.ts, and the mining
  script — checked query by query. (Non-guarded `tenant`/`observationWindow`/
  `clientProfile`/`observeLearningLedger` estate queries in the readout and the global
  recompute are deliberately cross-tenant and documented as such — internal tool.)
- New model `ObserveLearningLedger`: `@@index([tenantId, runAt])` +
  `@@index([tenantId, learning, runAt])` ✓.
- Both migrations additive-only: one `ALTER TABLE ... ADD COLUMN` (nullable JSONB),
  one `CREATE TABLE` + indexes + FK. No drops/alters of existing tables.
- `settings.localEvents`: READ-only in `resolveLocalEvents`; date resolution goes
  through the shared `eventAdjustmentForDate`. Nothing writes it.
- 30-day gating and pending-only posture unchanged (`observation-window.ts` not in
  the diff; shadow rows never surface).
- `trial-tenants.ts` change is exporting `tenantNameSlug` only (needed for the trial
  events lookup). `trial-events.ts` and `events.ts` untouched.

## 4. House bug classes — CLEAN

- **BullMQ repeatable keying (2026-06-02 trap):** `ensureObserveSchedules` still
  prunes ALL observe repeatables before re-adding (boot); the new
  `reconcileObserveSchedules` prunes a drifted-cron/tz repeatable before the add loop
  re-adds it in the same pass, so a cron change can never leave a stale duplicate
  firing. `parseObserveJobName` checks the `observe-settle-` prefix before
  `observe-`, so settle jobs cannot be misparsed as daily. `RepeatableJob.pattern`/
  `.tz` fields verified present in the installed bullmq 5.44.
- **Full-replace settings clobber:** `lastSuggestionRun` is written via a scoped
  `observationWindow.updateMany` `data` field, not a row replace; no
  `pricing_settings` writes anywhere in the diff.
- **Append-only reads without dedupe:** the starvation matrix reads the ledger via
  `groupBy` `_max(runAt)` per (tenant, learning) — correct on an append-only table.
  Superseded suggestion history is read with per-key latest/`readScoreFromDetail`
  guards; the calibration set takes rows once (no double-count of a night per
  generation is *possible* — each superseded generation is a separate prediction and
  is deliberately scored separately; the report labels it "scored suggestions", not
  "distinct nights").
- **Daily overwriting weekly-settle fields:** the GLOBAL feeDrag overwrite is fixed
  (recompute on settle only). The per-client `profile.feeDragPct` is still overwritten
  with null by daily runs — acknowledged in build-run 02, out of scope per the
  prompts, and now VISIBLE via the ledger's "not computed on the daily run" reason.
  See non-blocking finding N2.
- **Secrets:** `git log -p 9529135..HEAD` swept for connection strings / keys /
  bearer tokens — only env-var *names* in the TO DEPLOY docs. The committed
  `observe-reports/` artefacts contain no credentials (grep clean) and their numbers
  reconcile against prod (section 2, prompt 05).

## 5. Prod safety — VERIFIED UNTOUCHED

SELECT-only checks against prod on 2026-07-03:
- `to_regclass('public.observe_learning_ledger')` → does not exist; no
  `last_suggestion_run` column on `observation_windows`; latest applied migration is
  `20260626120000_add_observe_learn`. **Neither new migration touched prod.**
- Prod `suggestions` table is empty; latest writes on `global_methodology`,
  `client_profiles`, `observation_windows` are all 2026-07-03 04:30 UTC — the normal
  05:30-London daily run, not a build agent.
- The mining script's prod mode is `findMany`-only against `DATABASE_PUBLIC_URL` and
  writes report files only.

Local dev DB: both migrations applied there (run 01 via `db execute` +
`migrate resolve --applied` because of pre-existing local drift — the SQL itself is
plainly additive; prod apply is a normal `migrate deploy`).

## 6. Non-blocking findings (list only — none block shipping)

- **N1 — cumulative cap counts rejected suggestions.** `resolvePriorSuggestionGuards`
  counts every non-pending/shadow/superseded drop toward the 14d/25% cap, including
  `rejected` rows a human explicitly declined (suggestions.ts:567-585). This matches
  the prompt's literal wording ("prior non-pending suggestions") and over-blocks in
  the safe direction, but four rejected 7% drops in 14 days will mute a night the
  human wanted left active. The build agent flagged this itself. Consider excluding
  `rejected` when the closed-loop build lands.
- **N2 — per-client `feeDragPct` still nulled daily.** Only the global doc was fixed
  (per prompt 04's scope). The client profile's fee drag is recomputed as null on
  every daily run, so the day-30 readout shows "—" for fee drag most of the week. The
  ledger now makes this visible; a one-line fix (preserve prior feeDrag on daily
  recompute) is a good follow-up.
- **N3 — readout estate section is cross-tenant by design.** Every tenant's name +
  run health is embedded in every tenant's readout HTML. Fine while the readout is an
  internal key-gated tool; if a per-client readout is ever shared with a client, the
  estate/starvation sections must be stripped first.
- **N4 — floor fallback can be weak.** The 180d lowest-observed-rate fallback adopts
  a deep promo rate as the floor if one existed. Recorded in `detail.floor` so it is
  reviewable, and it only exists where the engine/settings floors are absent.
- **N5 — `nearestMinAt` uses nearest-by-absolute-time.** A snapshot captured shortly
  AFTER a booking can win over one long before it. Vastly better than latest-min (the
  artefact the prompt killed, with a unit test proving the anachronistic case no
  longer flags), but "min in force at booking" would strictly be nearest-at-or-before.
- **N6 — estate "last successful run" advances before suggestion generation.**
  `advanceObservationWindow` (which sets `lastRunAt`) runs before
  `generateSuggestionsForClient` in `runObserveForTenant`, so a run failing in the
  suggestion step still reads as successful in estate health. The blocked-line
  timestamp (`lastSuggestionRun.generatedAt`) would go stale, which partially covers
  this.
- **N7 — summary nits.** Run-02 summary's starting commit `8acffbba` is a 9-char typo
  (actual `8acffbb`). Test counts in summaries (93/124/142) are point-in-time and
  consistent with the final 163.

## 7. Commit hygiene

28 commits, one-fix-per-commit largely respected (each safety gate, the reconcile, the
ledger, the estate view, supersession, shadow, scorer, calibration, agreement, regret,
rule guards, global recompute, readout surfacing, mining lib, runner, renderer fix,
reports, and five summaries are individually revertable). All five build-run summaries
carry TO DEPLOY blocks; nothing was auto-deployed; no build agent asked-and-deployed.

## 8. End state

Branch is green on the full gate, prod is untouched, all five prompt contracts are
fully implemented with no silent skips, all house constraints hold. The 2026-07-28
graduation output is strictly safer than before this build: gated + floor-clamped +
event-shielded suggestions, visible blocked counts, estate health, honest regret, and
real calibration evidence instead of a leap of faith.
