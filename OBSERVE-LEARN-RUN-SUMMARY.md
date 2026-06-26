# Observe-and-Learn — overnight build run summary

**Branch:** `feat/observe-learn` (off `main`) · **4 commits** · **NOT pushed, NOT merged, NOT deployed.**
**Date:** 2026-06-26 (autonomous overnight run) · **Spec:** `SIGNALS-OBSERVE-LEARN-SPEC.md` (source of truth).

Built **Phases 1 → 4** in sequence and stopped. **Phase 5 (push) was deliberately NOT built.**
Everything is **additive and read-only**: 8 new tables, new modules under `src/lib/observe/**`,
a new queue + worker, and new key-gated routes. No existing table column, query, pricing path,
sync path, `src/lib/hostaway/**`, or screen was modified. AirROI stays disabled. No engine,
Hostaway, or Wheelhouse mutation anywhere.

> **Read me first if you only read one thing:** everything is **local on the `feat/observe-learn`
> branch**. To go live you apply one migration, set some env vars, and restart the workers —
> see the **TO-DEPLOY** block at the bottom. Until then it has **zero effect** on the running app.

---

## Green gate (final, all phases)

| Check | Result |
| --- | --- |
| `npm run typecheck` | ✅ clean (exit 0) |
| `npm run lint -- --max-warnings=0` | ✅ clean (exit 0) |
| `npm run test:tenant-isolation` | ✅ "Tenant isolation check passed." |
| `npm run test:observe` (unit, pure cores) | ✅ **81/81** pass |
| `npm run test:observe-schedule` (queue repeatables) | ✅ **3/3** pass |
| `npm run test:signals` (existing — regression check) | ✅ **36/36** pass (no regression) |

The migration was applied to the **local dev DB** (`hostaway_analytics`) and independently
**validated end-to-end on a throwaway shadow DB** (all 22 migrations apply from scratch — exactly
what Railway's `prisma migrate deploy` will do). The full loop was exercised against the dev DB
(see "Verified against real data" below).

### Additive-only proof

`git diff --stat main..feat/observe-learn` → **48 files changed, 5,604 insertions(+), 0 deletions(-)**.

Only **5 pre-existing tracked files** were touched, every one purely additive (0 deletions each):

| File | +lines | What was added |
| --- | --- | --- |
| `prisma/schema.prisma` | +212 | 8 new models + 7 back-relations on `Tenant`. `Listing` untouched. |
| `src/lib/queue/queues.ts` | +65 | `observe-learn` queue + 2 schedule helpers. |
| `src/workers/run-all-workers.ts` | +8 | additive import + `startObserveWorker()` call. |
| `package.json` | +4 | new test/script entries only. |
| `.env.example` | +36 | new env-var **names** (no values). |

Everything else is a **new file**. `prisma/schema.prisma` was restored from `main` and re-edited by
hand (no `prisma format`) specifically so the existing models keep **0 deletions** — `prisma format`
had cosmetically realigned unrelated models, which would have shown as deletions.

---

## What was built, per phase

### Phase 1 — Foundations (commit `2de60dd`)
- **Migration `20260626120000_add_observe_learn`**: `EngineSnapshot`, `EngineChange`,
  `ObservationWindow`, `PeerControl`, `ClientProfile`, `GlobalMethodology` (the single global,
  non-tenant doc), `Suggestion`, `PushLog`. Every tenant-scoped model has `tenantId` +
  `@@index([tenantId, …])` + `onDelete: Cascade`.
- **`PricingEngineAdapter` interface** (engine-agnostic core) + pure, fixture-tested mappers.
- **PriceLabs adapter** (verified: `GET /v1/listings`, `POST /v1/listing_prices`, header
  `X-API-Key`) and **Wheelhouse adapter** (built, **dormant**: `/ss_api/v1`, header
  `X-Integration-Api-Key`, read-only, 20 req/min backoff, multi-unit `unit_number` rows).
- **Registry** resolves tenant → engine → key from env / `OBSERVE_KEYS_FILE`, with segment-prefix
  matching; **Coorie Doon routes to `hostaway-scan`** (Wheelhouse key 401).
- **`scripts/observe-connectivity-check.ts`** prints engine / client / status / listing-count /
  levers — **never the key**.
- **Key safety**: `maskSecret` (reveals length only, never a character), `redactSecrets`,
  key-redacted HTTP errors. Engine calls are worker-side only.

### Phase 2 — Observation loop (commit `7236f74`)
- **EngineSnapshot capture + pure `diffEngineSnapshots` → EngineChange**, with pure
  `inferEngineChangeSource` (engine | owner | mark, spec §6).
- **`ObservationWindow` per client**, fresh 30-day clock on onboarding; pure `daysObserved` /
  `hasGraduated`; the loop stays **silent** until day 30.
- **Backfill** — read-only warm-start summary from `NightFact` / `PaceSnapshot` / `Reservation` /
  `RateChange`.
- **`observe-learn` queue + `observe-worker.ts`** (`startWorker`), additively imported into
  `run-all-workers.ts`. Daily **05:30** + weekly settle **Mon 06:00** Europe/London,
  **prune-before-re-add**. The schedule test asserts exactly the two repeatables per tenant.
- The Hostaway-side scan (RateState→RateChange + 48h attribution + rate-copy exclusion) keeps
  running as the existing rate-scan worker; the observe loop **reuses its output** rather than
  re-scanning. For Coorie Doon (`hostaway-scan`) that `RateChange` stream **is** the event log.
- Monthly rate-scan report retirement is a **Cowork-side action** (nothing in the repo schedules
  it); `/api/signals/monthly-summary` + its tables are left intact and dormant (spec §12).

### Phase 3 — Learning + controls (commit `ce1b614`)
- **Peer fallback ladder** (`peer-ladder.ts`): rung 1 primary peer / rung 2 thin / rung 3
  base-to-base elasticity, reusing `selectPortfolioPeerSetListingIds`, recording rung + confidence
  on each `PeerControl`. `attachControlsForRecentChanges` attaches a control to each recent
  price-drop.
- **The seven learnings** (`learnings-core.ts` pure + `learnings.ts` wrappers): pickup-velocity
  moved-vs-control, lead-time curves, regret (both directions), pricing power by date type, engine
  reaction, net realised rate, cancellation quality. **Learning #5 (engine reaction) is
  PriceLabs/Wheelhouse-only** — skipped gracefully for the Coorie Doon `hostaway-scan` fallback.
- **`ClientProfile`** (siloed, versioned) codifying divergences as explicit **client rules**
  (below-min short-window permission, empty-premium tolerance, engine-claws-back).
- **`GlobalMethodology`** — the single anonymised global doc. `anonymiseForGlobal` is a strict
  whitelist (ratios/labels only); **a required test asserts no `tenantId` / listing name / raw rate
  ever reaches it**. The merge is a pure running aggregate that learns **each engine separately**.

### Phase 4 — Graduation + gated suggestions (commit `2e7a4a0`)
- **Suggestions** (`suggestions.ts`): generated for graduated clients, **judged against the expected
  booking curve for each forward night's lead time** (pure `expectedCumulativeFill` +
  `judgeNightForSuggestion`), **ordered by revenue at risk**, capped, status **`pending`** — nothing
  applied. Replaces prior pending rows each run; preserves human-actioned ones.
- **Day-30 readout** (`readout.ts` + `day30-runner.ts`): learned strategy + first suggestions →
  JSON + HTML into `observe-reports/`, emailed via the existing lib with an **`.email-sent` marker
  guard** (mirrors `day14-runner.ts`). Fired once on the graduation edge by the worker. HTML-escapes
  client-controlled fields; never contains a key.
- **Key-gated routes** `GET /api/observe/readout` and `GET /api/observe/suggestions`
  (`OBSERVE_READOUT_KEY`, 404 when unset/mismatched — the `monthly-summary` pattern). No key in
  output.

---

## Connectivity-check output

**In this autonomous environment no engine keys were provisioned** (secrets discipline — keys are
never pulled into the run), so every client correctly falls back to the read-only `hostaway-scan`
path. This is itself a valid, graceful configuration:

```
• Escape Ordinary               engine=hostaway-scan (fallback)   status=OK (read-only live-rate scan)  listings=50
• Little Feather Management      engine=hostaway-scan (fallback)   status=OK (read-only live-rate scan)  listings=40
• Stay Belfast Apartments        engine=hostaway-scan (fallback)   status=OK (read-only live-rate scan)  listings=15
• Coorie Doon Stays              engine=hostaway-scan (fallback)   status=OK (read-only live-rate scan)  listings=43
• Yo's House/Short Stay Harrogate engine=hostaway-scan (fallback)  status=OK (read-only live-rate scan)  listings=32
• Avantio Demo                   engine=hostaway-scan (fallback)   status=OK (read-only live-rate scan)  listings=164
```

**Expected live output once the keys are in env (verified 2026-06-26, spec §2):**

| Client | Engine | Expected |
| --- | --- | --- |
| Escape Ordinary | PriceLabs | **200 OK — 54 listings** |
| Stay Belfast | PriceLabs | **200 OK — 26 listings** |
| Little Feather | PriceLabs | **200 OK — 48 listings** |
| **Coorie Doon** | Wheelhouse | **401 → dormant → routed to `hostaway-scan` fallback** |

> **Two name/number notes for Mark:**
> 1. **The PriceLabs listing counts (54/26/48) are the PriceLabs account scope** and intentionally
>    differ from the dev-DB Signals listing counts above (50/15/40) — they are different systems
>    (PriceLabs account vs the local Signals DB vs Railway prod).
> 2. **Actual tenant names differ from the spec's short names:** the DB has **"Coorie Doon Stays"**
>    (spec said "Corrie Doon"), **"Stay Belfast Apartments"**, **"Little Feather Management"**. The
>    registry matches by **segment-prefix** (longest wins), so `PRICELABS_KEY_STAY_BELFAST` resolves
>    "Stay Belfast Apartments" and `OBSERVE_ENGINE_COORIE_DOON` resolves "Coorie Doon Stays". The
>    `.env.example` block uses the correct **Coorie** spelling.

---

## Verified against real data (dev DB, then cleaned up)

- **Engine snapshot capture + diff**: a stub PriceLabs adapter at base 160→180 produced 2 snapshots
  and 1 `EngineChange` (lever `base_price`, source `engine` — timing matched).
- **Learnings** (Little Feather, real data): lead-time median **69 days**, fee drag **0.16%**,
  cancellation signal **`cheaper_cancel_more`**, divergence rule **`tolerates_empty_premium`** fired,
  `ClientProfile` written (rev 1 → 2), `GlobalMethodology` bootstrapped — **confirmed leak-free of
  `tenantId`** on real data.
- **Graduation**: forcing a 31-day-old window graduated the client, generated **50 suggestions**
  ordered by revenue at risk (top **£710**, timed-pct drops), the readout rendered, HTML/JSON wrote
  to `observe-reports/`, the email **failed gracefully** (no `RESEND_API_KEY` in this env → captured
  in `errors`, no `.email-sent` marker written so it retries), and the routes returned
  **404-without-key / 200-with-key** with **no key leak**.
- All test rows + report files created during verification were **deleted**; the dev DB observe
  tables are back to empty.

---

## Blockers / left incomplete (all expected, none blocking review)

1. **Engine keys not provisioned in this run** → connectivity shows the `hostaway-scan` fallback.
   Mark runs `npm run observe:connectivity` once the keys are in env to confirm the live 54/26/48 +
   the Coorie Doon 401.
2. **Wheelhouse / Coorie Doon key is 401** (re-tested 2026-06-26). The adapter is built but dormant;
   Coorie Doon runs on `hostaway-scan`. **Learning #5 (engine reaction) is unavailable for Coorie
   Doon** until a valid Wheelhouse *RM API read key* is supplied — then flip
   `OBSERVE_ENGINE_COORIE_DOON=wheelhouse` and it upgrades to engine-direct with no code change.
3. **Day-30 email needs `RESEND_API_KEY`** (already configured for the KeyData trial). Without it the
   readout still writes HTML/JSON to `observe-reports/`; the email retries next run.
4. **`scripts/audit-tenant-isolation.ts`** (a non-required *static* check) will flag the 2 new
   key-gated routes (no auth context) and `GlobalMethodology` (no `tenantId`). **Both are by design**
   — the routes 404 when `OBSERVE_READOUT_KEY` is unset (same posture as `monthly-summary`, the
   2026-06-01 precedent), and `GlobalMethodology` is the one deliberate global doc (spec §8). The
   **required** `npm run test:tenant-isolation` passes. One-line opt-ins exist if you want the static
   audit clean.
5. **Peer controls show 0 in dev** only because the dev DB has no recent rate-scanner `RateChange`
   price-drops to attach to. The mechanism is wired + unit-tested; it populates once the rate-scan
   worker logs drops in prod.
6. **Phase 5 (push) intentionally not built** — it requires a write key and is a deliberate,
   per-client, later switch.

---

## TO-DEPLOY (Mark's one-action morning task — nothing below has run in production)

Everything is on branch **`feat/observe-learn`**. Review the diff, then:

### 1. Merge the branch to `main` (main is the deploy branch)
```bash
cd /Users/markmccracken/Documents/signals
git checkout main
git merge --no-ff feat/observe-learn
git push origin main          # Railway auto-deploys main
```

### 2. Apply the migration on Railway (additive — creates 8 new tables, touches no existing data)
Run against the **Railway production database** (NOT `migrate dev` — use `migrate deploy`, which is
forward-only and never resets):
```bash
DATABASE_URL="<railway-prod-database-url>" npx prisma migrate deploy
```
This applies only `20260626120000_add_observe_learn`. It was validated end-to-end on a fresh shadow
DB. If Railway runs `prisma migrate deploy` automatically on deploy, this step is already covered —
confirm the migration appears as applied.

### 3. Set the env vars on the Railway **worker** service (names only — paste your real key values)
```
# Engine read keys (PriceLabs X-API-Key). Short names resolve the full tenant names.
PRICELABS_KEY_ESCAPE_ORDINARY=
PRICELABS_KEY_STAY_BELFAST=
PRICELABS_KEY_LITTLE_FEATHER=
# Wheelhouse (Coorie Doon) — currently 401; leave unset to use the hostaway-scan fallback.
WHEELHOUSE_KEY_COORIE_DOON=
# Engine routing pins (already the documented defaults in .env.example).
OBSERVE_ENGINE_ESCAPE_ORDINARY=pricelabs
OBSERVE_ENGINE_STAY_BELFAST=pricelabs
OBSERVE_ENGINE_LITTLE_FEATHER=pricelabs
OBSERVE_ENGINE_COORIE_DOON=hostaway-scan
# Key gate for the read-only readout + suggestions routes (any long random token).
OBSERVE_READOUT_KEY=
# (Optional) point at a plain-text KEY=value file instead of setting each key var:
# OBSERVE_KEYS_FILE=/path/to/keys.txt
```
`RESEND_API_KEY`, `TRIAL_REPORT_EMAIL_FROM`, `TRIAL_REPORT_EMAIL_TO` are already set from the trial —
the day-30 readout reuses them.

### 4. Restart the background workers so they run the new code (critical)
A worker started before the deploy keeps running **stale code** until restarted — the observe worker
won't exist and the schedules won't register until you do this. Restart the Railway **worker
service** (the one running `npm run worker` / `tsx src/workers/run-all-workers.ts`). On boot it will
log:
```
[run-all-workers] observe-learn worker started
[observe] registered daily (05:30) + weekly settle (Mon 06:00) Europe/London for N tenants (pruned 0 stale repeatable(s) first)
```

### 5. Verify it is live
```bash
# A) Connectivity (run from the worker service / a shell with the keys in env):
npm run observe:connectivity
#    → PriceLabs clients should read 200 OK with 54 / 26 / 48 listings;
#      Coorie Doon shows the hostaway-scan fallback (or 401 → fallback if a WH key is set).

# B) The key-gated route (replace <token> + <tenantId>):
curl "https://<your-app>/api/observe/readout?key=<token>"                  # → JSON list of clients + window state
curl "https://<your-app>/api/observe/suggestions?key=<token>&tenant=<id>"  # → 200 (empty until a client graduates)
#    Without ?key= both return 404 (by design).
```

### What happens after deploy (so there are no surprises)
- The loop runs **05:30 daily** + **Mon 06:00 settle** (Europe/London) per tenant and **stays silent
  for 30 days** per client — it captures snapshots, attaches controls, and builds each client's
  internal `ClientProfile` + the anonymised `GlobalMethodology`, but **proposes and pushes NOTHING**.
- Each client gets a **fresh 30-day clock** on its first run. On the day a client crosses **day 30**
  it graduates: it writes **pending `Suggestion` rows** (ordered by revenue at risk) and emails a
  **day-30 readout** once (guarded against double-send). **Nothing is ever applied** — push is the
  separate, off-by-default Phase 5.
- The existing rate-scan, rate-copy, sync, and pricing-comparison workers are unchanged.

---

## Commits on the branch
```
2e7a4a0  feat(observe): phase 4 — graduation + gated suggestions (day-30 readout, key-gated routes)
ce1b614  feat(observe): phase 3 — learning + controls (peer ladder, 7 learnings, profile, global)
7236f74  feat(observe): phase 2 — observation loop (snapshot/diff, window, backfill, queue+worker)
2de60dd  feat(observe): phase 1 — foundations (models, engine adapters, registry, connectivity check)
```
