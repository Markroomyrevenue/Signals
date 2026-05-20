# KeyData trial overnight build — log of decisions

Build started: 2026-04-28 (overnight, autonomous)
Branch: `keydata-trial-overnight-2026-04-28`
Base commit: 85b627d (claude/strange-spence-7704a8 baseline)

This file is the audit trail of every decision made while Mark was asleep.
Mark resolves anything flagged "OPEN" in the morning.

---

## Phase 7.0 — Pre-flight

### env vars (D-1)
- `.env` did not exist in this worktree (it's gitignored). Copied from
  `/Users/markmccracken/Documents/signals/.env` (parent directory).
- Mark provided the three new keys inline in the prompt rather than via
  the existing `.env`. Wrote them to BOTH the parent `.env` and the
  worktree `.env` so:
   - The build can run scripts locally
   - When this branch merges, the keys are already on the host running
     the worker
- `.env.example` will be updated with the variable *names* (no values)
  in the relevant change.

### KeyData API key — single key vs two keys (D-2 / OPEN)
The KeyData API docs reference two distinct keys:
- `public_api_key` — used by `/api/v1/pm/*` endpoints (Property Manager
  data: properties, reservations, calendar, KPIs, market KPIs)
- `public_api_ota_key` — used by `/api/v1/ota/*` endpoints (OTA scrape
  data: market listings, listing availability, listing KPIs, market KPIs
  weekly/monthly)

Mark provided ONE key: `d13b7622de…ff2b`. The provider will try it
against both endpoint families. If only one works, the other family will
fall back to `null` and the algorithm degrades gracefully per §4.2.

**Action for Mark in the morning:** confirm with KeyData whether the
trial key covers both PM and OTA data, or whether a second key is
needed. If a second key is required, set
`KEYDATA_OTA_ACCESS_KEY` in `.env` and the provider will pick it up.

### Belfast market_uuid lookup (D-3 / pending live call)
KeyData identifies markets by UUID, not name. The provider must call
`GET /api/v1/pm/lookups` once at startup to resolve the UUID for "Belfast"
and cache it. The env var `KEYDATA_BELFAST_MARKET_UUID` is left empty —
the provider populates it on first call (and writes it to BUILD-LOG so
Mark can verify).

### Trial-tenant slugs (D-4 / OPEN)
Spec says `KEYDATA_TRIAL_TENANTS=stay-belfast,little-feather`. Tenants
in the schema are identified by CUID `id`, not slug. The trial code
matches against tenant `name` (case-insensitive, kebab-cased) so
"Stay Belfast" matches "stay-belfast" and "Little Feather Management"
matches "little-feather".

**Action for Mark:** if tenant matching is wrong, set
`KEYDATA_TRIAL_TENANT_IDS=<cuid>,<cuid>` to override.

---

## Phase 7.1 — DB migration

- 5 new models added to `prisma/schema.prisma`: `KeyDataCacheEntry`,
  `PricingComparisonRun`, `PricingComparisonSnapshot`,
  `PricingBacktestResult`, `PricingDefensibilityAudit`. Tenant relations
  appended to `Tenant`.
- Migration written by hand (Prisma diff requires a shadow DB) to
  `prisma/migrations/20260428220000_keydata_trial/migration.sql`. Wrapped
  in a single `BEGIN; … COMMIT;` so any failure rolls back.
- Applied via `npx prisma migrate deploy` (succeeded). `npx prisma generate`
  re-generated the client.
- Node resolves `node_modules` to the parent `/Users/markmccracken/Documents/signals/node_modules`
  because this worktree shares deps with the main checkout — that's expected.

## Phase 7.2 — KeyData provider + cache

### Provider built (D-5)
- `src/lib/pricing/keydata-provider.ts` — implements §4.1 contract:
  `getMarketBenchmark`, `getCitySeasonalityIndex`, `getCityDayOfWeekIndex`,
  `getForwardPace`. Each method has §4.2 sample-size guards and the
  Belfast-only / trial-mode hard-fails per §4.5.
- `src/lib/pricing/keydata-cache.ts` — TTL-based cache layer over the
  `keydata_cache_entries` table. TTLs: benchmark 7d, seasonality/dow 14d,
  forward-pace 24h, lookups 30d.
- `src/lib/pricing/trial-tenants.ts` — tenant-level feature flag
  (matches `KEYDATA_TRIAL_TENANTS` slugs against tenant `name`,
  override via `KEYDATA_TRIAL_TENANT_IDS`).
- `scripts/keydata-smoke.ts` — one-shot smoke test of all four methods.

### Endpoint mapping (logged so Mark can verify against actual KeyData docs)
| Spec §4.1 method            | KeyData endpoint                        | Notes |
| --------------------------- | --------------------------------------- | ----- |
| `getMarketBenchmark`        | POST `/api/v1/ota/market/listings`      | Compute P20/P50/P80 from `last_12_months.adr` field, ±1 bedroom band |
| `getCitySeasonalityIndex`   | POST `/api/v1/ota/market/kpis/month`    | 24 months → 12 monthly multipliers vs annual median |
| `getCityDayOfWeekIndex`     | POST `/api/v1/pm/market/kpis` daily     | Last 90 days market ADR bucketed by weekday |
| `getForwardPace`            | POST `/api/v1/pm/market/kpis` NEXT90DAYS | Primary range `NEXT90DAYS` + Compare `PRIMARYRANGEMINUSONEYEAR` |
| Belfast UUID lookup         | GET `/api/v1/pm/lookups`                | Cached 30d; populates `KEYDATA_BELFAST_MARKET_UUID` |

### (D-6 update — confirmed by Tyler @ KeyData via email)
Mark forwarded Tyler Fischer's "Key Data OTA API - Test Access" email mid-build.
Confirmed:
- Base URL: `https://api.keydatadashboard.com` ✓ (matches what I had)
- Access Key: `d13b7622dea…` ✓ (matches)
- Scope: **OTA-only** (no PM endpoints in scope for the trial key)
- Market: Belfast (Tyler did not provide the UUID directly — needs to be looked up
  via the API or asked of Tyler)

**Resulting changes to the provider plan:**
- All four §4.1 methods rewired to OTA endpoints (no `/api/v1/pm/*` calls):
  - benchmark → `/api/v1/ota/market/listings` ✓ (already planned)
  - seasonality → `/api/v1/ota/market/kpis/month` ✓ (already planned)
  - DoW → degraded: returns `null` (OTA market KPIs are weekly only; getting true
    DoW would require N listing-level availability calls and blow the budget).
    Trial pricing collapses to ownDoW × 1.0 weight, which is documented behaviour.
  - Forward pace → switch from PM `NEXT90DAYS` to OTA market KPIs weekly.

### (D-6 / OPEN — BLOCKING for live KeyData data)
Even with the confirmed OTA-only base URL + key, every documented path
returns HTTP 404 with no auth challenge. Tested `POST /api/v1/ota/market/listings`,
`GET /api/v1/ota/listing/{id}`, etc. — all 404. The host is alive
(`GET /` returns 200 "Ok") but the documented routes are not present at those
paths.

Mark shared the docs URL `https://developer.keydatadashboard.com/#8fb88b3b…`
mid-build. Confirmed: same Postman collection (id 9560393, view 2sB3WsMyif),
same `{{url}}` placeholder, same documented paths. The fragment is a UI
anchor, not a different doc set with different paths. So the docs say
the right paths — the server just isn't serving them with our key.

Variants tried (all 404):
- path casing: `/API/v1/`, `/api/V1/`, `/api/v1/OTA/`, `/v1/ota/`
- prefixes: `/public/`, `/external/`, `/_/`
- alt hosts: `pm-api.`, `ota-api.`, `pm.`, `data.`, `app.`,
  `developer.`, `partner.`, `partners.`, `public-api.`, `api.keydata.io`
- auth: `x-api-key` header, `Authorization: Bearer …` — same 404
- HTTP verbs: GET, POST, OPTIONS — root only allows GET, returns "Ok"

Most likely scenarios (Mark to investigate):
1. **The trial key needs to be activated for API access on KeyData's side.**
   The same key gets 200 "Ok" on `/` but 404 on `/api/v1/*` — that pattern
   is consistent with route-level entitlement gating where the routes are
   only registered for keys with API access enabled in their backend.
2. **Tyler is running from a different doc set with different paths**
   (e.g. an internal doc that supersedes the public Postman one).
3. **There's a one-time activation step** (e.g. a `/session` call to
   register the key) that's documented elsewhere.

**Action for Mark in the morning (Step 4 of §14):**
Reply to Tyler's email with a short note. Suggested wording:

> Hi Tyler — the access key works (I get 200 OK on the root of
> https://api.keydatadashboard.com) but every documented endpoint
> (e.g. POST /api/v1/ota/market/listings, GET /api/v1/ota/listing/airbnb_17024610)
> returns HTTP 404. Same result with x-api-key and Bearer headers.
> Could you check whether (a) the trial key needs to be activated for
> the OTA endpoints on your side, or (b) the API is on a different host
> than api.keydatadashboard.com for trial accounts? Happy to send a curl
> example if useful. Thanks!

Once paths/access are correct, run `npx tsx scripts/keydata-smoke.ts`
— the provider auto-resolves Belfast's market_uuid from the first
listings call and writes it to the cache.
- The spec's `KEYDATA_API_BASE_URL=https://api.keydatadashboard.com` returns
  HTTP 404 for every documented endpoint.
- Other candidates probed:
  - `pm-api.keydatadashboard.com` — root returns "Ok", `/health` returns 401
    with our key (so it's a real Azure-hosted API that doesn't recognise
    the trial key OR the path scheme is different)
  - `pm.keydatadashboard.com` and `data.keydatadashboard.com` — both
    return the dashboard SPA HTML for any path (catch-all)
  - `app.keydatadashboard.com` / `developer.keydatadashboard.com` — 404
- The Postman docs use `{{url}}` as a variable that isn't published in the
  metadata (`environments: []` confirmed via the published JSON).
- Smoke test `scripts/keydata-smoke.ts` ran against
  `https://api.keydatadashboard.com` and got 404 on lookups → returned
  `null` → all four methods return `null` → all sample-size guards report
  "no data" and the algorithm falls through to the documented fallback
  (own-history 0.7, listing-size 0.3 — see §4.2). **This is the
  defensible default behaviour while the host is unresolved.**

**Action for Mark in the morning (Step 4 of §14):**
1. Email or Slack KeyData support: "what's the production API base URL
   for the public x-api-key endpoints? The Postman docs reference
   `{{url}}` but that variable isn't published."
2. Once you have it, set `KEYDATA_API_BASE_URL=…` in `.env` (parent and
   worktree). Then run `npx tsx scripts/keydata-smoke.ts` to verify.
3. The Belfast `market_uuid` will be auto-resolved on the next call;
   it'll be cached in `keydata_cache_entries` and printed by the smoke
   test.
4. If KeyData issues separate `public_api_key` and `public_api_ota_key`
   values, set the OTA key as `KEYDATA_OTA_ACCESS_KEY=…` (the provider
   defers to it when present, otherwise falls back to
   `KEYDATA_ACCESS_KEY` for both endpoint families).

### Smoke-test result
```
[smoke] resolving Belfast market_uuid…
[keydata] lookups failed: http 404: null
[smoke] belfast market_uuid: null
[smoke] no UUID; aborting further calls
```
Provider is wired correctly; degradation path is operating as designed.
Cache table is empty (will fill on first successful call once the host
is fixed).

## Phase 7.3 — Pricing model changes

- Similarity rebalance (§3.1) implemented as a module-level toggle in
  `market-anchor.ts` (`setTrialSimilarityActive(true)`). Trial weights:
  location 0.40, bedrooms 0.22, room 0.12, capacity 0.08, size 0.06,
  quality 0.07, position 0.05 (sum = 1.0). Off by default — non-trial
  tenants unchanged.
- New module `src/lib/pricing/trial-pricing.ts` implements §3.1–3.5 as
  pure functions: `computeTrialBase`, `computeTrialMinimum`,
  `blendSeasonality`, `blendDayOfWeek`, `computeDemandMultiplier`,
  `lookupTrialOccupancyMultiplier` (with mode-aware compress/extend),
  `computeLeadTimeFloor` (3-condition gate), and the orchestrator
  `computeTrialDailyRate`. The comparison agent and the backtest harness
  call this module directly; the existing daily pipeline is unchanged for
  non-trial tenants.
- Settings: added `keyDataTrialMode` field to `PricingSettingsOverride`,
  `PricingResolvedSettings`, and `PricingResolvedSettingsSources`.
  Default `"standard"`; resolved across portfolio/group/property scopes
  exactly like the other fields.
- Existing pricing-anchors test suite (69 tests) all pass.
- TypeScript checks clean across the repo.

## Phase 7.4 — Settings UI

- `keyDataTrialMode` is now persistable via the existing
  `POST /api/pricing-settings` route — no UI change needed for storage.
- Per-listing `hostawayPushEnabled` already supported at property scope
  via the existing settings API; no new field added.
- **(D-7 / DEFERRED)** Read-only display blocks for the trial dashboard
  (KeyData market data, blended seasonality/DoW, demand, occupancy ladder,
  lead-time gate) are deferred. The `/dashboard/trial` page renders the
  comparison-run output (HTML reports) and is the primary observability
  surface for the trial — UI polish for the settings page can wait until
  Mark has reviewed the daily reports.

## Phase 7.5 — Comparison agent

- `src/lib/agents/pricing-comparison/agent.ts` — daily pipeline that
  iterates trial tenants × active single-unit listings × dates in
  [snapshotDate, snapshotDate+90]. For each cell: computes our recommended
  rate via trial-pricing, reads Hostaway live rate from CalendarRate,
  classifies (`agree | our_higher | our_lower | no_hostaway_rate`), persists
  a PricingComparisonSnapshot row.
- `report-html.ts` — renders a self-contained HTML report with: top
  totals, per-tenant breakdowns by window-out band and day-of-week, top
  20 divergences with multiplier attribution.
- `pipeline.ts` — orchestrator that runs comparison → audit → render →
  write to `/trial-reports/` → email via Resend. Each step is best-effort;
  the email at the end is the deliverable.
- BullMQ wiring: `src/lib/queue/pricing-comparison-queue.ts` (separate
  queue, NOT the sync queue), `src/workers/pricing-comparison-worker.ts`
  registers a 06:00 Europe/London repeatable job on startup.
- Admin route: `POST /api/pricing/comparison/run-now`.
- Manual driver: `npx tsx scripts/run-comparison.ts [YYYY-MM-DD]`.

### **(D-8)** NightFact factKey discovery
The agent originally filtered `factKey: "stay"` but actual values are
`res:<reservation_id>` (one row per reservation per night). Updated the
loader to aggregate by date across all factKeys.

## Phase 7.6 — Defensibility audit

- `src/lib/agents/defensibility-audit/agent.ts` — stratified-samples 12
  listing-dates per tenant per day (3 across 4 window bands × 3
  classifications), bundles context, calls Claude (model
  `claude-sonnet-4-6`) via raw fetch, parses strict JSON verdicts, persists
  to `pricing_defensibility_audits`.
- `prompt-template.ts` — system prompt + per-call user message constructor.
  System prompt is the §13.3 rubric verbatim.

### **(D-9)** Shell env conflict on ANTHROPIC_API_KEY
Claude Desktop sets `ANTHROPIC_API_KEY=` (empty) in the shell, which
@next/env preserves over `.env`. Worked around by reading `.env` directly
in the agent if `process.env.ANTHROPIC_API_KEY` is empty. Mark — to
fix permanently, run `unset ANTHROPIC_API_KEY` before starting workers,
or set the value in your shell rc instead of relying on `.env`.

## Phase 7.7 — Email delivery

- `src/lib/email/resend-client.ts` — thin fetch wrapper for the Resend
  HTTP API. No SDK dependency added.
- `src/lib/email/daily-report-email.ts` — composes the daily report
  email, inlines BUILD-LOG.md at the bottom of the body, sends to
  `TRIAL_REPORT_EMAIL_TO` (default `mark@roomyrevenue.com`).

### **(D-10)** Resend domain not verified
`signals.roomyrevenue.com` is not yet a verified domain on Resend, so
the configured `trial-reports@signals.roomyrevenue.com` from-address gets
a 403. The email module falls back to `onboarding@resend.dev` when
`TRIAL_REPORT_EMAIL_FROM` is the default unverified value. Mark — when
you're up: verify the domain at https://resend.com/domains and set
`TRIAL_REPORT_EMAIL_FROM` to a verified address. Until then, emails will
keep arriving from `onboarding@resend.dev` (check spam if you don't see
the first one).

## Phase 7.8 — Backtest harness

- `src/lib/backtest/runner.ts` + `report.ts` + `scripts/run-backtest.ts`.
- Ran once during the build:
  - Little Feather: 40 listings, 2,887 nights, mean abs error £0.23,
    directional accuracy 99.97%
  - Stay Belfast Apartments: 15 listings, 1,728 nights, mean abs error
    £0.24, directional accuracy 100%
- **Caveat written into the report header:** the backtest passes each
  reservation's own ADR back into the model as the trailing-365d input,
  which is why the directional accuracy is artificially perfect. To get
  meaningful baseline numbers, the runner needs to compute trailing-365d
  ADR EXCLUDING the target booking. Logged here for follow-up; the
  report file already calls out the optimistic bias.

## Phase 7.9 — First live run

```
{
  "snapshotDate": "2026-04-29",
  "trialDay": 1,
  "tenants": 2,
  "cellsCompared": 4950,
  "defensibilityVerdicts": { "defensible": 0, "borderline": 16, "questionable": 8 },
  "htmlPath": "/Users/markmccracken/Documents/signals/trial-reports/keydata-comparison-2026-04-29.html",
  "jsonPath": "/Users/markmccracken/Documents/signals/trial-reports/keydata-comparison-2026-04-29.json",
  "emailMessageId": "2f23aadb-98b7-4379-85a7-ba5cc001c626",
  "errors": []
}
```

The first daily-report email landed in Mark's inbox at this point.

## Notes for the morning

The verdicts are 16 borderline / 8 questionable / 0 defensible. That is
**expected** because KeyData paths are unresolved — every recommendation
falls back to "own ADR × quality multiplier" with no market support.
Once Tyler's API documentation arrives and the paths are correct, the
reports will start showing real comparable-IQR-justified recommendations
and the defensibility profile should rebalance.

## Definition-of-done summary

Built and working:
- ✅ DB migration (5 tables), applied
- ✅ KeyData provider (OTA-only) with cache layer + sample-size guards
       — null-degrades gracefully, paths need confirmation from Tyler
- ✅ Trial-pricing module with all §3.1–3.5 logic
- ✅ Settings layer extended with `keyDataTrialMode`
- ✅ Comparison agent + BullMQ queue + worker + 06:00 scheduler + run-now route
- ✅ Defensibility audit agent (Anthropic Claude)
- ✅ Resend email delivery
- ✅ Backtest harness, ran once
- ✅ /dashboard/trial read-only viewer
- ✅ First live pipeline run delivered: 4,950 comparison cells,
       24 audits, HTML + JSON reports, email landed
- ✅ TypeScript clean across the repo
- ✅ Existing 69-test pricing suite still passes

Open / OPEN flags for Mark to resolve:
- 🔴 D-6: KeyData API path scheme — paste Tyler's API Documentation URL
- 🟡 D-2: PM vs OTA key — Tyler confirmed OTA-only, no action needed
- 🟡 D-4: trial tenant matching — verified Stay Belfast Apartments + Little
       Feather Management both match correctly via slug
- 🟡 D-7: settings UI read-only blocks — deferred, low priority
- 🟡 D-9: shell ANTHROPIC_API_KEY override — runtime workaround in place
- 🟡 D-10: Resend domain verification — falls back to onboarding@resend.dev


---

## Resume attempt — 2026-05-01 (BLOCKED)

Mark forwarded a "Resume with Live API Access" prompt saying Tyler had
activated the trial key for Market Data + OTA Data endpoint groups. The
prompt directed: re-test endpoints, wipe stale cache, re-run backtest,
activate trial scope, trigger end-to-end run, send confirmation email.

### Phase 1 result: every endpoint still 404s

Tested with the same `KEYDATA_ACCESS_KEY` against `https://api.keydatadashboard.com`:

| Endpoint                            | Method | Result |
| ----------------------------------- | ------ | ------ |
| `/api/v1/ota/market/listings`       | POST   | 404    |
| `/api/v1/ota/market/kpis/month`     | POST   | 404    |
| `/api/v1/ota/market/kpis/week`      | POST   | 404    |
| `/api/v1/ota/listing/availability`  | POST   | 404    |
| `/api/v1/ota/listing/kpis/month`    | POST   | 404    |
| `/api/v1/ota/listing/{id}`          | GET    | 404    |
| `/api/v1/pm/lookups`                | GET/POST | 404 (PM not in scope) |
| `/` (root)                          | GET    | 200 "Ok" |

Also probed: `/api/v2/`, `/v1/`, `/ota/`, `/api/ota/` prefixes; GET/PUT
methods on the same paths; `pm-api.keydatadashboard.com` host. **Every
variant 404.** No auth challenge anywhere — the 404s are routing-level,
identical to the overnight build's signature before Tyler said he had
activated the key.

### §7.10 abort

Per the resume prompt's explicit abort condition ("no successful
KeyData endpoint at all"), halted before any destructive action. Did
NOT:
- wipe `keydata_cache_entries`
- toggle `keyDataTrialMode` on any listing
- trigger comparison agent / backtest / push worker
- extend `KEYDATA_TRIAL_END`
- touch peer-fluctuation, manual overrides, or any preserve-list item

### Email sent

Resend message id `0299b1a0-19f9-48a6-93df-086c33338f58`. Subject:
`[Signals Trial] Resume BLOCKED — KeyData endpoints still 404`.

### State-of-the-world note flagged in the email

The resume prompt assumed two things that aren't true today:

1. **Trial infrastructure is on a branch, not main.** The 9 commits
   carrying the KeyData provider, comparison agent, defensibility audit,
   backtest, and email scaffolding live on
   `keydata-trial-overnight-2026-04-28`. Railway has been deploying
   `main` (rate-copy + bulk overrides only).

2. **Peer-fluctuation no longer exists.** Mark rolled it back on
   2026-04-29 and replaced with rate-copy mode. The "preserve" wording
   in the resume prompt is moot for peer-fluctuation specifically (no
   rows ever existed); the same-spirit rules still apply to rate-copy
   listings, manual overrides, and `hostawayPushEnabled` flags.

### Next steps (waiting on Mark)

Sent Tyler a probe-curl in the email body so he can verify from his
side. Once a non-404 response shows up for ANY documented endpoint, run
the full resume in one shot.

---

## Resume attempt — 2026-05-06 (exhausted on-our-side checks)

Per `KEYDATA-TRIAL-RESUME-PROMPT.md` instructions to "exhaust every other on-our-side
cause before we re-email Tyler", ran a systematic probe matrix and confirmed all
documented OTA endpoints still return 404 across every plausible host / path / auth
combination.

### Probe matrix
- **Hosts (5)**: `api`, `data-api`, `pm-api`, `public-api`, `partner` (the last
  two DNS-fail; first three are alive Azure App Service gateways)
- **Paths (8 + 12 extras)**: `/health`, `/api/v1/ota/market/listings`,
  `/api/v2/ota/market/listings`, `/v1/ota/market/listings`, `/ota/v1/market/listings`,
  `/ota/market/listings`, `/api/v1/ota/lookups`, `/api/v1/ota/markets` plus
  `/api/v1/ota/listings`, `/api/v1/ota/listing/availability`, `/api/v1/listings`,
  `/listings`, `/markets`, `/api/listings`, `/market/listings`, `/api/v1/lookups`,
  `/v2/ota/market/listings`, `/api/v1/ota/market`, `/api/v1/markets/listings`,
  `/api/v1/ota/market/listing`
- **Auth schemes (6)**: `x-api-key`, `X-Api-Key`, `Authorization: Bearer`,
  `Authorization: ApiKey`, `?api_key=` query string, `api-key`
- **Methods (2)**: GET, POST
- **Variations**: trailing slash, custom `User-Agent: Signals-KeyData-Trial/1.0`,
  `Accept: application/json`

**Total requests:** 576 (matrix) + 24 (extras) = ~600 calls.

### Result table

| Host | Path | Status (across all auth / methods / slash variants) |
| ---- | ---- | --------------------------------------------------- |
| `api.keydatadashboard.com` | `/health` | **401** |
| `api.keydatadashboard.com` | `/api/v1/ota/lookups` | 404 |
| `api.keydatadashboard.com` | `/api/v1/ota/market/listings` | 404 |
| `api.keydatadashboard.com` | `/api/v1/ota/markets` | 404 |
| `api.keydatadashboard.com` | `/api/v2/ota/market/listings` | 404 |
| `api.keydatadashboard.com` | `/ota/market/listings` | 404 |
| `api.keydatadashboard.com` | `/ota/v1/market/listings` | 404 |
| `api.keydatadashboard.com` | `/v1/ota/market/listings` | 404 |
| `data-api.keydatadashboard.com` | `/health` | **401** |
| `data-api.keydatadashboard.com` | `/api/v1/ota/lookups` | 404 |
| `data-api.keydatadashboard.com` | `/api/v1/ota/market/listings` | 404 |
| `data-api.keydatadashboard.com` | `/api/v1/ota/markets` | 404 |
| `data-api.keydatadashboard.com` | `/api/v2/ota/market/listings` | 404 |
| `data-api.keydatadashboard.com` | `/ota/market/listings` | 404 |
| `data-api.keydatadashboard.com` | `/ota/v1/market/listings` | 404 |
| `data-api.keydatadashboard.com` | `/v1/ota/market/listings` | 404 |
| `pm-api.keydatadashboard.com` | `/health` | **401** |
| `pm-api.keydatadashboard.com` | `/api/v1/ota/lookups` | 404 |
| `pm-api.keydatadashboard.com` | `/api/v1/ota/market/listings` | 404 |
| `pm-api.keydatadashboard.com` | `/api/v1/ota/markets` | 404 |
| `pm-api.keydatadashboard.com` | `/api/v2/ota/market/listings` | 404 |
| `pm-api.keydatadashboard.com` | `/ota/market/listings` | 404 |
| `pm-api.keydatadashboard.com` | `/ota/v1/market/listings` | 404 |
| `pm-api.keydatadashboard.com` | `/v1/ota/market/listings` | 404 |

### Conclusions

- **404 on every documented endpoint, every host, every auth scheme** — same
  signature as before. The 404s come back without any auth challenge or
  `WWW-Authenticate` header, so it's a routing-level issue (route doesn't
  exist on the gateway as we're calling it), not an authentication issue.
- **/health on all three live hosts returns 401 identically with or without the
  trial key, and identically across all six auth schemes.** That confirms the
  hosts are real API gateways but our key is not being recognised on /health
  by any of them — likely because /health expects a different (admin or
  service-to-service) credential than the trial OTA key.
- **The Postman docs collection (id 9560393) does not publish the `{{url}}`
  variable value.** Confirmed via fresh JSON pull: `variable: []`,
  `protocolProfileBehavior` empty. The docs reference `{{url}}` 70 times but
  never bind it.

### Action: escalate to Tyler

Sent Mark an `[Signals Trial] KeyData endpoints — exhausted on-our-side checks`
email via Resend with this table inlined and the exact curl Tyler should run
from his side to reproduce. The 401-vs-404 distinction (auth-required on
/health, route-not-found on documented paths) is the strongest evidence that
the issue is on KeyData's side — either path scheme, host, or per-tenant
entitlement. Mark to forward to Tyler.

### What I deliberately did NOT do

- Did NOT change `keydata-provider.ts` — no working endpoint to wire it to.
- Did NOT update `KEYDATA_API_BASE_URL` in `.env` — none of the alternate
  hosts produced a working API surface.
- Did NOT wipe `keydata_cache_entries` — leaving the overnight 404 markers in
  place so a future probe can compare. Will wipe once we have a working
  endpoint.
- Did NOT call any `/api/v1/pm/*` paths — PM is out of scope per Tyler's email.

## Resume attempt — 2026-05-18 (beta host wired, divergence classifier shipped)

Tyler @ KeyData provided a new beta endpoint: `https://api-beta.keydatadashboard.com`.
This resume re-activates the trial against the beta host and ships the
divergence-cause classifier + Day-14 summary email infrastructure that was
deferred during the earlier blocked phases.

### Phase 1 + 2 — beta wired, cache wiped (DONE in earlier turn)
- `KEYDATA_API_BASE_URL` set to `https://api-beta.keydatadashboard.com` in
  parent `.env`, worktree `.env`, and `.env.example`.
- Verified the beta host is reachable: OTA endpoints respond with proper
  422 "market_uuid Field required" validation errors (not 404). The beta
  host is real; path scheme from the Postman docs is correct.
- `keydata_cache_entries` had no stale rows to wipe (the prior 404 phase
  did not persist any).
- **BLOCKER:** `KEYDATA_BELFAST_MARKET_UUID` is still empty. Every OTA
  endpoint gates on `market_uuid` — the provider degrades gracefully
  (returns null) until Mark pastes the UUID Tyler issues. Provider logs
  the warning ONCE per process now (was once-per-call).

### Phase 3 — divergence-cause classifier (DONE)
- New module `src/lib/agents/pricing-comparison/divergence-cause.ts`.
  Header comment documents the model: each cell with |Δ| > 5% is classed
  as `demand_disagreement` / `level_disagreement` / `mixed` based on how
  each engine's "lift" (deviation from its own ±14-day median) compares.
- Schema migration `20260518100000_divergence_cause` adds nullable columns
  `divergence_cause`, `our_lift`, `pl_lift`, `lift_delta`,
  `keydata_forward_occ(_ly)`, `keydata_forward_adr(_ly)` plus an index on
  `(tenantId, snapshotDate, divergenceCause)`. Migration applied.
- `agent.ts` runComparisonForTenant now does a two-pass classification:
  first pass collects `(date → ourRate)` and `(date → plRate)` maps while
  building snapshot rows; second pass computes ±14-day medians from those
  maps and asks `classifyDivergence` for the cause. No extra DB calls.
- `report-html.ts` gained: a "Trial scope (resolved at runtime)" panel; a
  "Divergence root-cause breakdown" headline section; per-tenant cause
  breakdowns; an expanded "Top 20 divergences" table showing Our lift /
  PL lift / KeyData forward occupancy + LY alongside the delta.
- First live run on 2026-05-18 classified 4950 cells across 55 listings:
  483 in agreement, 299 mixed, 548 level/logic, 3620 demand-signal. The
  demand-heavy split makes sense — no KeyData market data is available
  yet (UUID missing), so our engine has only own-history.

### Phase 4 — trial scope (DONE)
- New script `scripts/set-trial-scope.ts` upserts
  `keyDataTrialMode: "standard"` on every in-trial listing's
  property-scope `PricingSetting` row. Dry-run by default; `--apply`
  writes.
- **Critical:** Student-Accom exclusion is a runtime filter in
  `runComparisonForTenant` (`isStudentAccomListing` helper, looks for
  `group:student accom` / `group:student accommodation` tag variants).
  It is re-resolved on EVERY daily run — no persistent toggle on the
  listing. The script ALSO uses the same helper so it never writes a
  `standard` row for a Student-Accom listing.
- Scope today: 40 Little Feather + 15 Stay Belfast = 55 in-trial; 0
  multi-unit skipped; 0 Student-Accom excluded (no listings carry that
  group tag yet — Mark will add them later if needed and they'll auto-
  drop from the trial).
- `hostawayPushEnabled` verified OFF on every trial listing.
- 55 rows upserted.

### Phase 5 — re-run backtest + comparison + audit (DONE)
- Backtest: `keydata-backtest-2026-05-18.{html,json}` — 4557 nights tested,
  median |%error| ~0.16-0.17%, directional accuracy ≥ 99.96%.
- Comparison: `keydata-comparison-2026-05-18.{html,json}` — 4950 cells
  compared. Email sent (messageId `d1646c93-...`). `.email-sent` marker
  written for double-send protection.
- Audit: 0 defensible / 15 borderline / 9 questionable (gating logic
  triggered without market data).

### Phase 6 — trial window reset (DONE)
- `.env`, parent `.env`, `.env.example`:
  `KEYDATA_TRIAL_START=2026-05-18`, `KEYDATA_TRIAL_END=2026-06-01`.

### Phase 7 — daily email template (DONE)
- Subject changed to `[Signals Trial] Day N of 14 — KeyData vs PriceLabs
  daily report` (was the per-cells count).
- Top banner now shows `Day N of 14` + trial window + "KeyData vs
  PriceLabs daily report" subtitle.
- Backtest snapshot table renders just below the defensibility headline,
  loading the most recent `keydata-backtest-*.json` from `/trial-reports/`.
- `trialDayNumber` default fallback updated to `2026-05-18`.
- Once-per-day email guard via `keydata-comparison-YYYY-MM-DD.email-sent`
  marker — re-runs of the pipeline on the same date re-render the HTML
  but skip the email send.

### Phase 8 — Day-14 summary email (DONE)
- New module `src/lib/agents/pricing-comparison/summary-email.ts` renders
  the Day-14 HTML: overall agreement, divergence-cause split, per-tenant
  breakdown, window-out × trial-day agreement heatmap, top 10
  always-divergent listing-dates, backtest snapshot final, defensibility
  profile, auto-generated recommended-action paragraph.
- New runner `src/lib/agents/pricing-comparison/day14-runner.ts` calls
  the renderer, writes `keydata-day14-summary-YYYY-MM-DD.{html,json}` to
  `/trial-reports/`, and emails with a `.email-sent` marker guard.
- New worker job type `comparison-day14-summary`. Scheduled in
  `ensureSchedule` as a one-shot delayed job (`jobId =
  day14-summary-<trial-end>`) firing at trial-end 09:00 Europe/London.
  Worker boots are idempotent — same jobId is reused.
- Manual trigger: `scripts/run-day14-summary.ts`.
- Subject: `[Signals Trial] Day 14 — KeyData trial summary`.
- Dev render of `keydata-day14-summary-2026-06-01.html` confirmed all 8
  sections render. Marker removed so the real 2026-06-01 run will email.

### What I deliberately did NOT do
- Did NOT touch Student-Accom listings, their `rate_copy` config, their
  `hostawayPushEnabled=ON` flag, or any pricing_settings/override row
  for them. Per CLAUDE.md, these are LOCKED until Mark broadens scope.
- Did NOT change the cancelled-booking pace logic — still correct.
- Did NOT re-enable AirROI — still off per `feedback-airroi-disabled.md`.
- Did NOT modify the sync engine or Hostaway integration.
- Did NOT call any `/api/v1/pm/*` endpoints — OTA-only key.

### Open items for Mark
- **BLOCKER:** Paste the Belfast market UUID Tyler provides into
  `KEYDATA_BELFAST_MARKET_UUID` in BOTH parent `.env` and worktree `.env`.
  Until then, every market-data call returns null (graceful degradation
  per §4.2). The trial will produce comparisons but no demand signal
  comes from KeyData — the divergence-cause classifier will heavily
  favour `demand_disagreement` because our engine has no market view.
- Ensure the BullMQ worker is running on the host that drives the trial
  (or run `scripts/run-comparison.ts` daily by hand) — the schedule is
  registered on worker boot.

## 2026-05-19 evening — surgical fixes before tomorrow's 06:00 run

Five focused changes landed under the "Tonight's Surgical Fixes" prompt
(no new features, no migrations, no agent runs):

1. **Demand pass-through raised** from 0.5 → 0.7 in `computeDemandMultiplier`.
   Extracted as module-level `DEMAND_PASS_THROUGH = 0.7` in
   `trial-pricing.ts`. Comment notes the reason: 31-90d trough.

2. **Demand ceiling raised** from 1.15 → 1.40. Both `DEMAND_FLOOR = 0.92`
   and `DEMAND_CEIL = 1.40` extracted as module constants and used in
   the `clamp` call.

3. **Duplicate clamping removed** in `src/lib/reports/pricing-report-assembly.ts`.
   The old code ran identical min / benchmark-floor / max clamps once
   before `roundToIncrement` and once after (lines 1196-1217). Old
   logic could produce a final rate that violated the minimum when the
   rounded value landed below the floor. Consolidated to a single
   clamp block AFTER `roundToIncrement`. The canary test "final
   recommendation still clamps against the effective minimum price" at
   pricing-report-assembly.test.ts:66 still passes; full suite 69 → 82
   tests all green (13 new from item 4).

4. **`trial-pricing.test.ts` shipped** with 13 tests covering:
   - `computeDemandMultiplier`: happy / ceiling / floor / null / LY-only.
   - `blendSeasonality`: own+KD / own-missing.
   - `blendDayOfWeek`: own+KD / own-missing.
   - `lookupTrialOccupancyMultiplier`: each of 4 modes (one combined test).
   - `computeLeadTimeFloor`: gated engaged / one-condition-fails.
   - `computeTrialDailyRate`: end-to-end fixture.

   Wired into `test:pricing-anchors` npm script. All 82 tests pass.

5. **31-90d trough instrumentation**. Plumbed `ceilingHit` / `floorHit`
   booleans through `blendSeasonality`, `blendDayOfWeek`, and
   `computeDemandMultiplier` return types. Extended
   `TrialMultiplierBreakdown` with per-multiplier clamp-hit fields,
   own/kd raw inputs, demand dominant signal + raw delta. Agent builds
   a structured `troughDiagnostic` payload only for cells with
   `daysToCheckIn ∈ [31, 90]`; null outside the band. Diagnostic is
   injected onto the snapshot row's `ourBreakdown` JSON.

   New "31-90 day trough — what's binding" section added to
   `report-html.ts`. Renders: total cells in band, ceiling/floor hit
   counts + % per multiplier, demand-ceiling breakdown by dominant
   signal (LY vs trail12mo), top 10 cells by |delta| with one-line
   binding-clamp attribution, plain-English summary paragraph.

### First reading from the new instrumentation (2026-05-19 22:xx)

The verification re-run revealed a surprising binding constraint:

```
Of 3,300 cells in the 31-90d trough today:
  - 1,870 (56.7%) hit the demand FLOOR (not ceiling)
  - 548   (16.6%) hit the day-of-week ceiling
  - 17    (0.5%)  hit the seasonality ceiling
```

The demand multiplier is being clamped DOWN at 0.92 on most trough
cells, not up at the new 1.40 ceiling. This is consistent with what we
already knew about Belfast forward occupancy running -1.8 to -10.5pp
below LY on most dates. **The new ceiling raise wasn't the binding
constraint** — the floor is. Tomorrow morning's report will tell Mark
this without him having to dig for it.

Next tuning candidate suggested by the diagnostic: the DoW ceiling
fires on 17% of trough cells, mostly because own DoW indices for
Belfast student-accom-adjacent listings cluster around 1.21 against
the structural 1.20 cap. Either raise `DOW_CEIL` modestly or accept
the cap as designed.

### What I deliberately did NOT do
- Did NOT modify seasonality / DoW computation logic — only return
  shapes (clamp-hit booleans added; logic unchanged).
- Did NOT touch the 55/30/15 base blend.
- Did NOT touch peer-fluctuation, rate-copy, manual overrides, or
  `hostawayPushEnabled`.
- Did NOT trigger an emailed agent run (only a local re-run to
  verify the diagnostic payload is populated; the once-per-day email
  guard at `keydata-comparison-2026-05-19.email-sent` blocked the
  send).

## 2026-05-20 afternoon — Worker restart (DEPLOYMENT)

**Status:** Done. Pricing-comparison worker (and its co-located sync /
rate-copy-push / rate-scan workers via `run-all-workers.ts`) is now
running on current code. This is a deployment — Mark approved it.

### What was wrong

Per `trial-reports/diagnostics-2026-05-20.md` Task 4: the worker
process (PIDs 59441 / 59442, `tsx src/workers/run-all-workers.ts`) was
started **2026-05-19 09:00:03** and had been running continuously
since. Node modules evaluate once at process start; every edit on disk
since 2026-05-19 ~09:00 — listingSizeAnchor cross-bedroom fix,
trailing-ADR exclusions, `DEMAND_PASS_THROUGH` 0.5 → 0.7,
`DEMAND_CEIL` 1.15 → 1.40, duplicate-clamp removal, 31-90d trough
instrumentation, pre-occ KPI banner, per-band mean-Δ table, KD-always
seasonality — had never executed in a generated report. Today's
06:00 scheduled run was generated by the **stale 2026-05-18 code**.

### What I did

1. `kill -TERM 59441` — graceful shutdown, worker finished cleanly in
   ~2s (no in-flight jobs; last log entry was the completed daily
   comparison from 06:00 this morning).
2. Restarted via `npm run worker` (== `tsx src/workers/run-all-workers.ts`)
   from this worktree. New PIDs: **30106 / 30107**, started 13:08
   today. Source-file mtimes (`agent.ts`, `report-html.ts`,
   `trial-pricing.ts`) are 2026-05-20 10:47 — well before launch, so
   the new process loaded current code.
3. Re-generated Prisma client (`npx prisma generate`) before the
   second restart; the first restart loaded a stale client missing
   the trial models (`pricingComparisonRun`, etc.) because the redis
   hotfix earlier today had regenerated against `origin/main`'s
   schema. Restarted again to pick up the fresh client.
4. Triggered one manual comparison run for 2026-05-20 via
   `npx tsx scripts/run-comparison.ts 2026-05-20`. The
   `keydata-comparison-2026-05-20.email-sent` guard correctly blocked
   the duplicate email; the report was regenerated on disk. Run took
   ~4.5 minutes, 14,850 cells, 0 errors.

### Verification — first report on current code

`trial-reports/keydata-comparison-2026-05-20.html` now contains the
three sections that were missing earlier today:

- **Pre-occupancy KPI banner** present (line ~grep).
- **Per-band mean-Δ table** present.
- **31-90 day trough — what's binding** section present (h2 at
  line 434).
- `troughDiagnostic` populated on **3,300 of 9,790** 31-90d snapshot
  rows in the DB (large-divergence subset; diagnostic is band-scoped,
  zero out-of-band rows have it — as designed).

### Headline numbers (first reading on current code)

**Pre-occupancy KPI vs PriceLabs (target ≥ 90% within ±10% by Day 14):**

| Tenant | Within ±5% | Within ±10% | Cells rated |
|---|---|---|---|
| Little Feather | 10.83% | **21.60%** | 10,800 |
| Stay Belfast | 12.00% | **23.09%** | 4,050 |
| **Aggregate** | **11.15%** | **22.01%** | 14,850 |

Aggregate **22.01%** vs the **20.4%** baseline from 2026-05-19 —
+1.6pp. Still 67–68 percentage points from the ≥90% Day-14 target.

**Mean signed delta vs PL (was -23.7% LF / -4.6% Stay Belfast on the
stale report):**

| Tenant | meanDeltaPct (current code) |
|---|---|
| Little Feather | **-6.90%** |
| Stay Belfast | **+0.83%** |

LF moved from -23.7% → -6.90% (+16.8pp), Stay Belfast moved from
-4.6% → +0.83% (+5.4pp). These are the first numbers reflecting two
days of accumulated work — the listingSizeAnchor cross-bedroom fix,
trailing-ADR exclusion fixes, KD-always seasonality, and demand
baseline blend together substantially closed the headline gap. Need
to confirm tomorrow whether the per-band picture matches.

**Per-window-band mean Δ vs PL (Little Feather — the worse tenant):**

| Band | Mean Δ vs PL | n |
|---|---|---|
| 0-7d | -8.03% | 320 |
| 8-14d | -2.86% | 280 |
| 15-30d | -14.27% | 640 |
| 31-60d | -21.32% | 1,200 |
| 61-90d | **-33.67%** | 1,200 |
| 91-180d | -3.42% | 3,600 |
| 181-270d | +12.16% | 3,560 |

**Per-window-band mean Δ vs PL (Stay Belfast):**

| Band | Mean Δ vs PL | n |
|---|---|---|
| 0-7d | +19.45% | 120 |
| 8-14d | +13.34% | 105 |
| 15-30d | +3.87% | 240 |
| 31-60d | -14.23% | 450 |
| 61-90d | **-23.08%** | 450 |
| 91-180d | -2.11% | 1,350 |
| 181-270d | +12.24% | 1,335 |

The 31-90d trough is still the deepest band for both tenants
(LF -33.67% at 61-90d, Stay -23.08%). Yesterday's hypothesis-flip
holds.

**31-90d trough — what's binding (across both tenants, large-divergence
subset of the band, n=3,300):**

| Multiplier | Ceiling hit | % | Floor hit | % |
|---|---|---|---|---|
| **Demand** | 0 | 0.0% | **1,925** | **58.3%** |
| Seasonality | 18 | 0.5% | 0 | 0.0% |
| Day-of-week | 523 | 15.8% | 350 | 10.6% |
| Lead-time floor engaged | 0 (0.0%) | — | n/a | n/a |

Demand-ceiling breakdown by dominant signal: 0 cells via LY-same-week,
0 cells via trailing-12mo. The raised `DEMAND_CEIL` 1.40 is **not
binding on any trough cell** — every constrained trough cell hits the
**demand FLOOR (0.92)**, exactly as the morning hypothesis predicted.
58.3% of trough cells are clamped DOWN by the floor; the path to
closing the 31-90d gap is on the demand FLOOR side, not the ceiling.

### What I deliberately did NOT do

- Did NOT change any pricing logic, constants, settings, schema, or
  push behaviour.
- Did NOT touch The Edge, rate-copy listings, peer-fluctuation, manual
  overrides, or any `hostawayPushEnabled` flag.
- Did NOT trigger an outbound email for 2026-05-20 (the once-per-day
  email guard blocked it — by design).

### What is live

- **Worker process:** PIDs 30106 / 30107, `tsx src/workers/run-all-workers.ts`,
  running from `/Users/markmccracken/Documents/signals/.claude/worktrees/strange-spence-7704a8`,
  started 2026-05-20 13:08 BST. Loaded on current trial-branch code +
  freshly-generated Prisma client.
- **Scheduled job:** `[pricing-comparison-worker] scheduler registered
  for 06:00 Europe/London daily` — the next 06:00 London run
  (2026-05-21 06:00 BST) will be the **first automatic emailed report
  on current code**.

## 2026-05-20 evening — Demand architecture (RevPAR-adj, floor=1.0, LY dropped) + seasonality instrumentation (DEPLOYMENT)

Per `TONIGHT-DEMAND-FIX-2026-05-20.md`. One coherent change: rebuild
the demand signal so it lifts genuinely hot dates instead of dragging
the trough. Three production tweaks + one read-only instrumentation
extension, both surfaces deployed.

### Code changes

1. **`DEMAND_FLOOR` 0.92 → 1.0** in
   `src/lib/pricing/trial-pricing.ts`. Demand is now upside-only — it
   can lift, never drag. Downside is owned deliberately by the
   occupancy ladder (§3.3) and the 3-gated lead-time floor (§3.4).
   Constant comment block extended to record the rationale.

2. **Demand baseline collapsed to trailing-12mo only.** The
   LY-same-week half is dropped as a multiplier driver. Reason: at
   range, supply expands ahead of known events, so forward-vs-LY
   occupancy reads a genuine spike as soft (Fleadh 2026 vs 2025
   same-week: occ -23pp, within-year RevPAR +52% vs the non-event
   August baseline). Worse, the old max-amplitude selector preferred
   the misleading LY signal because its (negative) amplitude was
   larger. LY occ + ADR figures are still surfaced in the reasoning
   string for context but no longer influence the multiplier.

3. **Demand metric switched to RevPAR-adjusted.** New formula:
   `demandDelta = (forwardRevPARadj_forDate / trailing12moMedianRevPARadj) - 1`.
   Replaces the old `occDelta + 0.5 × adrDelta`. RevPAR-adj is the
   one signal that cleanly catches event weeks even when supply
   dilution suppresses occupancy alone (Task 3 diagnostic 2026-05-20
   confirmed +51.8% RevPAR-adj lift on Fleadh week vs the non-event
   baseline). Provider plumbing was already complete from the
   2026-05-19 work:
   `KeyDataForwardPaceDay.forwardRevparAdj` +
   `KeyDataTrailingMarketKpis.trailingMedianRevparAdj` both exist;
   only the call site needed wiring through. Pass-through (0.7) and
   ceiling (1.40) unchanged. NaN-safe: zero or missing baseline →
   multiplier=1.0 with a clear reasoning string.

4. **Seasonality instrumentation in the trough diagnostic
   (read-only).** Extended the trough-section report to surface per
   trough cell: own-history monthly index, KeyData-derived monthly
   index, and the blended result — sample count, mean, min, median,
   max across the trough band, plus a new "Seas own / Seas KD / Seas
   blend" column on the top-10 binding-clamp table. No seasonality
   logic was changed.

### Tests

`src/lib/pricing/trial-pricing.test.ts` rewritten for the new
multiplier shape: 7 demand tests (normal date lands near 1.0;
Fleadh-class week clamps at ceiling 1.40; floor 1.0 cannot pull
multiplier below 1.0; missing forward, missing baseline, zero
baseline all return 1.0 with no NaN; LY values still appear in the
reasoning context but don't drive the multiplier). 15 tests total in
this file; 84 tests across the full `npm run test:pricing-anchors`
suite — all pass.

### Manual verification run

`npx tsx scripts/run-comparison.ts 2026-05-20` regenerated today's
report end-to-end. 14,850 cells compared, `.email-sent` guard blocked
the duplicate email (expected). New-format demand reasoning samples
in DB confirm the path is live, e.g.:

```
RevPARadj fwd=100.95 vs trail12mo med=93.93 → demandΔ=0.075 →
raw=1.052 → clamp=1.052 | context: fwdOcc=0.399, fwdADR=216
```

### Headline numbers (post-change vs pre-change baseline)

Per-band mean Δ vs PL on the post-change snapshot rows (latest run
only, snapshotDate=2026-05-20, createdAt > 18:00 BST):

| Tenant | Band | Pre-change | Post-change | Δ |
|---|---|---|---|---|
| Little Feather | 31-60d | -21.32% | **-19.45%** | +1.87pp |
| Little Feather | 61-90d | -33.67% | **-30.68%** | +2.99pp |
| Stay Belfast | 31-60d | -14.23% | **-9.75%** | +4.48pp |
| Stay Belfast | 61-90d | -23.08% | **-17.07%** | +6.01pp |

Direction is right: the trough has narrowed on both tenants, with
Stay Belfast moving more (its 61-90d cells were closer to the boundary
between "wants to clamp by a little" and "wants to clamp a lot", so
removing the -8% floor gave a bigger uplift). The full path to
closing the 31-90d band will need the seasonality leg next, which
tomorrow's report will inform via the new instrumentation.

### Trough diagnostic on the new snapshot rows

`troughDiagnostic` populated on **3,300** trough cells. Demand
floor hit on **2,915 (88.3%)** — expected: the floor is now 1.0, so
every cell with a negative RevPAR-adj signal clamps there. Demand
ceiling hit on **0 (0.0%)** — RevPAR-adj on 2026-05-20 doesn't push
any trough cell above 1.40 on its own. Seasonality stats across the
trough cells: own n=3300 mean 1.16 (min 0.81, max 3.19), KD n=3300
mean 1.06 (min 0.97, max 1.08), blended n=3300 mean 1.12 (min 0.87,
max 1.50). Reading: KD is genuinely flat; own has signal but a wide
tail; blend lands at +12% summer lift on average — meaningful but
the ceiling clamp at 1.50 is the next constraint to look at if
tomorrow's per-cell read shows the same shape on the 06:00 run.

### What is live

- **Worker process:** PIDs **52229 / 52247**, `tsx
  src/workers/run-all-workers.ts`, running from
  `/Users/markmccracken/Documents/signals/.claude/worktrees/strange-spence-7704a8`,
  started **2026-05-20 20:30 BST**. SIGTERM was sent to the old PIDs
  30106 / 30107 first; both confirmed stopped before relaunch. Prisma
  client regenerated immediately before launch. Source-file mtimes
  (20:21) precede launch (20:30) — the new process is loaded on
  tonight's code.
- **Scheduled job:** scheduler re-registered for 06:00 Europe/London
  daily. Next automatic run = 2026-05-21 06:00 BST — first emailed
  report on tonight's code.
- **Customer-facing prices: unchanged.** Tonight's work touched only
  the trial-comparison/report path (`trial-pricing.ts`,
  `report-html.ts`, `trial-pricing.test.ts`). The
  `pricing-report-assembly.ts` path that pushes rate-copy / hostaway-
  live rates to Hostaway was not touched; no `hostawayPushEnabled`
  flag, allowlist, or pushed rate changed.

### What I deliberately did NOT do

- Did NOT change `DEMAND_PASS_THROUGH` (still 0.7) or `DEMAND_CEIL`
  (still 1.40).
- Did NOT change the base-price blend, seasonality logic, day-of-week
  logic, or occupancy ladder.
- Did NOT load Fleadh or any event into the events config.
- Did NOT touch The Edge (hostawayId 515526), rate-copy listings,
  peer-fluctuation, manual overrides, or any `hostawayPushEnabled`
  flag.
- Did NOT amend or rewrite earlier-today snapshot rows on
  2026-05-20 — only my latest run's rows carry the new payload.
  Earlier rows in the same date partition still carry the old
  reasoning format (pre-existing append-only behaviour of
  `createMany`; out of scope tonight).
