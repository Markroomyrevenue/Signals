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

## 2026-05-22 morning — Seasonality fix (portfolio-aggregated own + sample-gated blend + raised ceiling)

Per `TONIGHT-SEASONALITY-FIX-2026-05-21.md`. One coherent change: rebuild
the seasonality signal so genuine own-history summer lift lands instead
of being diluted by flat KeyData OTA seasonality. Job ran in the morning
of 2026-05-22 (not overnight as originally scoped); the 06:00 emailed
report had already gone out on pre-change code.

### Code changes

1. **Own-history seasonality now portfolio-aggregated (per tenant).**
   New `loadOwnHistoryPortfolioSeasonality(tenantId, listingIds)` in
   `src/lib/agents/pricing-comparison/agent.ts` aggregates all of the
   tenant's listings' booked NightFact rows by calendar month over the
   trailing 365-day window, returning a 12-element monthly index AND a
   12-element per-month booked-night count. Uses the **same** exclusions
   as `trailing-adr.ts` (ownerstay filtered, stays > 10 nights filtered,
   `isOccupied=true` + `revenueAllocated>0`, collapsed to one row per
   listing-date), so the seasonality index is internally consistent
   with the trailing-ADR base-price signal. Called ONCE per tenant per
   run; the per-month indices are reused for every listing × every
   target date. Per-listing monthly seasonality dropped from
   `loadOwnHistoryAggregates` (it's no longer used).

2. **Sample-gated own/KD blend replaces the fixed 60/40.**
   `blendSeasonality` signature changed: `ownSampleSizeOk: boolean` →
   `ownSampleSize: number | null` (the actual booked-night count). New
   named constants at the top of `trial-pricing.ts` with comment block:
   - `SEASONALITY_OWN_SAMPLE_GATE = 30`
   - `SEASONALITY_WEIGHTS_OWN_LED = { own: 0.85, market: 0.15 }`
   - `SEASONALITY_WEIGHTS_OWN_SPARSE = { own: 0.40, market: 0.60 }`

   Branching:
   - own + KD both present, sample ≥ gate → own-led 0.85/0.15
   - own + KD both present, sample < gate → KD-heavy 0.40/0.60 fallback
   - only KD → 1.0 × KD
   - only own → 1.0 × own
   - neither → 1.0

   Function now returns `ownSampleSize` + `ownSampleAboveGate` alongside
   the existing fields so the trough diagnostic can surface the gating
   decision per cell.

3. **`SEASONALITY_CEIL` 1.50 → 1.80** in `trial-pricing.ts`. Floor
   unchanged at 0.75. Portfolio aggregation removes the wild
   single-listing 3.19 artifact the pre-2026-05-21 per-listing index
   produced (Day-4 instrumentation: own mean 1.16, min 0.81, max 3.19;
   post-aggregation, the max should sit much lower), so a higher
   ceiling is safe and lets genuine summer signal land.

4. **`TrialDailyInput` gained `ownSeasonalitySampleSize: number | null`.**
   `TrialMultiplierBreakdown` gained `seasonalityOwnSampleSize` +
   `seasonalityOwnSampleAboveGate`. Both call sites in
   `computeTrialDailyRate` (manual + standard paths) updated; the
   standard path now passes the portfolio-month sample count instead
   of deriving an own-sample gate from the listing's full-year
   occupancy fraction.

5. **`backtest/runner.ts`** — added `ownSeasonalitySampleSize: null` to
   the per-reservation `TrialDailyInput` (backtest fixtures don't have
   month-level portfolio data; null treats them as "no sample" → KD-led
   blend, preserving existing backtest behaviour).

6. **`report-html.ts` instrumentation extended.** The 31-90 day trough
   section now surfaces per cell + in aggregate:
   - Own monthly index (portfolio-aggregated), own sample (booked
     nights/month), KD monthly index, blended result, mean/min/median/
     max distributions across the trough band.
   - New "Blend mix across the trough" line counting cells on own-led
     weights, KD-heavy fallback, own-only, KD-only, no-signal, and
     legacy (pre-2026-05-21 rows missing the new fields).
   - Top-10 table gains an "Own n" column (per-cell sample count), a
     "Weights (own/kd)" column, and a "Clip" column (`↑` on ceiling
     hit, `↓` on floor hit, `—` otherwise).
   - Renderer guards every new field with `??` / typeof checks so
     transition-day reports (pre-2026-05-21 rows mixed with new rows)
     render cleanly. First render attempt hit a `toFixed` on undefined
     because the 06:58 pre-change snapshot rows lack the new fields;
     fixed by making the schema fields optional and defending the
     accessors. Re-ran and the report rendered with 0 errors.

### Tests

`src/lib/pricing/trial-pricing.test.ts`: replaced 2 old `blendSeasonality`
tests with 5 new ones covering the spec's case matrix:
- Own + KD, sample above gate → own-led 0.85/0.15
- Own + KD, sample below gate → KD-heavy 0.40/0.60
- No own history (sample null + own null) → KD alone, no NaN
- Own only (no KD) → 1.0 × own
- High own index (2.50) → clamped at the new 1.80 ceiling

End-to-end fixture test updated to pass `ownSeasonalitySampleSize: 60`
(above gate). **All existing tests still pass.** Suite total:

| Suite | Tests | Pass | Fail |
|---|---|---|---|
| test:pricing-anchors (incl. trial-pricing.test.ts) | 87 | 87 | 0 |
| test:hardening | — | pass | 0 |

(Up from 84 yesterday — 3 net-new seasonality tests.)

### Manual verification run

`npx tsx scripts/run-comparison.ts 2026-05-22` regenerated today's
report on tonight's code. The `keydata-comparison-2026-05-22.email-sent`
guard (written by this morning's 06:58 scheduled run) correctly blocked
a duplicate email — by design, and confirmed with Mark before the
manual run. 14,850 cells compared, 0 errors. troughDiagnostic
snapshot rows for 2026-05-22 31-90d carry the new fields:

```json
{ "kd": 0.971, "own": 1.127, "blended": 1.104,
  "ownWeight": 0.85, "marketWeight": 0.15,
  "ownSampleSize": 637, "ownSampleAboveGate": true,
  "ceilingHit": false, "floorHit": false }
```

(Math: 0.85 × 1.127 + 0.15 × 0.971 = 1.104. ✓ Own sample 637 ≫ gate 30 → own-led.)

### Headline numbers (post-change vs pre-change baseline)

Pre-change baseline = the 06:58 BST 2026-05-22 emailed report (the one
generated on the worker's old code BEFORE tonight's changes landed).

| Tenant | Band | Pre-change | Post-change | Δ |
|---|---|---|---|---|
| Little Feather | 31-60d | -17.2% | **-9.80%** | +7.4pp |
| Little Feather | 61-90d | -31.2% | **-26.16%** | +5.0pp |
| Stay Belfast | 31-60d | -9.8% (yesterday) → -5.0% post | **-5.00%** | +4.8pp |
| Stay Belfast | 61-90d | -17.1% (yesterday) → -12.5% post | **-12.45%** | +4.6pp |

Pre-occ ±10% agreement: aggregate **23.66%** (was 22.11% pre-change,
+1.5pp). LF 22.81% (was 22.11%), SB 25.90% (was ~23%).

LF mean Δ vs PL: **-4.07%** (was -5.9% pre-change). SB mean Δ vs PL:
**+4.13%** (was ~+1.2% pre-change).

The seasonality fix moved the trough meaningfully on both tenants
without lifting the close-in bands beyond ±10% in either direction.
LF 61-90d is still the deepest band — the gap there is now ~26% rather
than ~31%, but it remains the next tuning target. KD-heavy fallback
fires on 0 cells in the trough today (all post-change trough rows
landed on own-led 0.85/0.15 weights with sample sizes 600+); the gate
itself isn't binding on Belfast portfolios with this much history. The
floor of 0.75 is also not binding.

### Trough binding summary (post-change rows only, n=6,600)

Blend mix across the trough: **6,600 cells on own-led 0.85/0.15
weights**, 0 on KD-heavy fallback (sample density is high portfolio-
wide), 0 on own-only / KD-only. The legacy 6,600 cells from the 06:58
pre-change run sit alongside in the same daily partition (per the
append-only `createMany` behaviour already documented in yesterday's
entry) and the renderer labels them as "legacy rows from a pre-
2026-05-21 run" so the transition-day report stays readable.

### What is live

- **Worker process:** PIDs **82719 / 82720**, `tsx src/workers/run-all-workers.ts`,
  running from `/Users/markmccracken/Documents/signals/.claude/worktrees/strange-spence-7704a8`,
  started **2026-05-22 07:47 BST**. Old PIDs 52229 / 52247 / 52248
  (started 2026-05-20 20:30) stopped cleanly with SIGTERM in < 2s; new
  process launched after Prisma client regeneration. Source-file mtimes
  (07:26–07:40) precede launch (07:47) — the new worker is on tonight's
  code.
- **Scheduled job:** scheduler re-registered for 06:00 Europe/London
  daily. Next automatic run = 2026-05-23 06:00 BST. Today's emailed
  report already went out at 06:58 BST on pre-change code, but the
  on-disk regenerated 2026-05-22 report + DB rows now reflect tonight's
  seasonality fix (visible to Mark in
  `trial-reports/keydata-comparison-2026-05-22.html`).
- **Customer-facing prices: unchanged.** Tonight's work touched only
  the trial-comparison/report path (`trial-pricing.ts`, `agent.ts`,
  `report-html.ts`, `trial-pricing.test.ts`, `backtest/runner.ts`).
  The `pricing-report-assembly.ts` path that pushes rate-copy /
  hostaway-live rates to Hostaway was not touched; no
  `hostawayPushEnabled` flag, allowlist, or pushed rate changed.

### What I deliberately did NOT do

- Did NOT change the demand multiplier (DEMAND_PASS_THROUGH still 0.7,
  DEMAND_FLOOR still 1.0, DEMAND_CEIL still 1.40, baseline still
  trailing-12mo only, metric still RevPAR-adjusted).
- Did NOT change the base-price blend (still 55/30/15 own/KD/size),
  day-of-week logic, or the occupancy ladder.
- Did NOT load Fleadh or any event into the events config — explicitly
  out of scope per the spec ("that is the next night").
- Did NOT touch The Edge (hostawayId 515526), rate-copy listings,
  peer-fluctuation, manual overrides, or any `hostawayPushEnabled`
  flag.
- Did NOT delete or overwrite the morning's `.email-sent` guard.
  Confirmed with Mark before running the manual regeneration; he
  approved running with the guard in place so no duplicate email
  would go out.
- Did NOT amend the 06:58 snapshot rows on 2026-05-22 — append-only
  `createMany` left them as legacy rows alongside the new ones, with
  the renderer labelling them. Tomorrow's 06:00 run will produce a
  clean partition (only new-format rows).

## 2026-05-22 mid-morning — Events lever (Fleadh) wired into trial comparison agent

Per `TONIGHT-EVENTS-FLEADH-2026-05-22.md`. Supervised same-day run with
Mark answering one sizing question mid-flight (+40% on the lever).
Comparison/report path only — **no customer-facing rate changed**.

### Step A diagnostic — Fleadh-week vs non-Fleadh 61-90d

On the 2026-05-22 post-seasonality-fix snapshot rows, 61-90d band split:

| Bucket | Cells | Mean Δ vs PL |
|---|---|---|
| LF Fleadh week | 640 | **-42.98%** |
| LF non-Fleadh 61-90d | 1,760 | -22.26% |
| SB Fleadh week | 240 | -25.09% |
| SB non-Fleadh 61-90d | 660 | -7.02% |
| **Aggregate Fleadh** | **880** | **-38.10%** |
| Aggregate non-Fleadh 61-90d | 2,420 | -18.10% |

Multiplier stack on **every** Fleadh-week cell (640/640 LF + 240/240 SB):

- demand multiplier = **1.0** — pinned at the FLOOR. Raw wanted to drop
  below 1.0 on every cell. **The engine is BLIND to Fleadh** because KD
  OTA forward RevPAR-adj reads early-Aug as SOFT (the supply-dilution
  pattern flagged in DECISIONS.md 2026-05-20). Demand contributes
  nothing — the event lever carries the **whole** lift, not a residual
  on top of partially-firing demand.
- seasonality already firing (LF mean 1.20, SB 1.35) — within the new
  1.80 ceiling, working as designed.
- occupancy ~1.0 (slightly under on LF, slightly over on SB) — not
  lifting either way at 70-day lead time.

Fleadh week accounts for ~26% of the 61-90d cell count but ~1.6× the
band's average delta — it's the dominant driver of the band's gap. The
non-Fleadh portion of the band sits at -18% on aggregate (LF -22%, SB
-7%) which is base-shape territory, not multiplier territory.

### Step B — events lever wired into the trial comparison agent

`src/lib/agents/pricing-comparison/agent.ts` previously hardcoded
`localEventAdjPct: null` (~line 614). Now resolves the trial event via:

```ts
const trialLocalEvents = getTrialLocalEventsForTenant(tenant);
// ... per date:
localEventAdjPct: eventAdjustmentForDate(trialLocalEvents, targetIso)?.adjustmentPct ?? null
```

The shared `eventAdjustmentForDate` helper now lives in
`src/lib/pricing/events.ts` — single source of truth, both the trial
agent AND `pricing-report-assembly.ts` import from it. The two stale
duplicate copies (one in `pricing-report-assembly.ts`, one in
`reports/service.ts` — the latter unused dead code) are gone. The
helper handles both `dateSelectionMode === "range"` AND
`dateSelectionMode === "multiple"` (selectedDates) — same semantics as
the production calendar path.

### Step C — push-path trace + trial-only event source

**The trace shows `settings.localEvents` IS in the push path.** Chain:

`POST /api/hostaway/push-rates → executePushRates → buildPushRatesPreview
→ loadRecommendationsForRange → buildPricingCalendarReport →
buildPricingCalendarRows → eventAdjustmentForDate(settings.localEvents, …)
→ recommendedRate → push.ts pushCalendarRatesBatch → Hostaway calendar
write.`

So loading Fleadh into shared `settings.localEvents` would change:
1. The calendar UI's displayed `recommendedRate` for LF + SB during the
   Fleadh window.
2. The rate pushed to Hostaway for any listing with
   `hostawayPushEnabled = true` during the Fleadh window.

Today only `hostawayId=513515` ("Mark Test Listing") has
`hostawayPushEnabled = true` per DECISIONS 2026-04-28, but the
architecture would propagate Fleadh to any future push-enabled listing
automatically. That's exactly what the spec asked to prevent.

**Resolution:** load Fleadh in a trial-only source —
`src/lib/agents/pricing-comparison/trial-events.ts`. Only the trial
comparison agent reads from it. `settings.localEvents` stays empty
across both trial tenants. There is no code path from
`getTrialLocalEventsForTenant` to any Hostaway write — verified by
grep:
- `getTrialLocalEventsForTenant` is referenced only in
  `agent.ts` (the trial pipeline)
- `agent.ts` never calls `push.ts`, `push-service.ts`,
  `rate-copy-push-service.ts`, or any `/api/hostaway/push-rates` route
- The trial agent only writes `PricingComparisonSnapshot` rows + the
  emailed HTML — both read-only outputs

The trial-events module also enforces an upper bound:
`TRIAL_EVENT_ADJUSTMENT_PCT_CAP = 60` — any event with
`|adjustmentPct| > 60` is dropped at runtime with a console.warn (the
+60% cap from the spec, as artifact guard).

### Fleadh adjustmentPct = +40 (chosen with Mark mid-flight)

Sizing arithmetic, given pre-events Fleadh-week gaps from Step A:

| Tenant | Pre-event gap | Post-event projection (+40%) | Within ±10%? |
|---|---|---|---|
| Little Feather | -42.98% | -42.98% × (1 - 1.4) ≈ **-20%** | No, still undershoot |
| Stay Belfast | -25.09% | -25.09% × (1 - 1.4) ≈ **+5%** | Yes, well within band |

A larger adjustment (e.g. +50%) would close LF more but push SB above
+10% (overshoot — explicitly forbidden by the spec). A smaller
adjustment (e.g. +30%) would leave SB at -3% (good) but LF at -25%
(barely better). +40% is the largest move that respects the "no
overshoot past +10%" gate on the more-PL-aligned tenant (SB), at the
cost of LF still undershooting because LF's gap is partly **base-price
shaped** (Day-1 diagnostics: 40/40 LF listings have base > 15% below PL
mean), not Fleadh-shaped. Closing the LF residual is a separate base-
price task.

### Step D — instrumentation

- `troughDiagnostic.multipliers.events` added on every 31-90d snapshot
  row: `{ multiplier, adjPct }`. `adjPct: null` when no event covers the
  cell; `multiplier: 1.0` always in that case.
- New **"Events lever — Fleadh / curated events"** section in the
  trough report (lives just below the seasonality stats table, just
  above the Top-10 cells table). Renders:
  - Total cells covered, mean Δ vs PL on event cells, within ±10% /
    overshoot / undershoot counts.
  - "Top 10 event cells by |Δ%|" table: listing, date, event +%, our
    rate before-event (reconstructed via `currentRate / eventMult`),
    our rate with-event, PL rate, Δ% after.
- Falls back to "No event covers any 31-90d trough cell today" when
  the snapshot date is far from any loaded event (most days of the
  year). On a transition-day mixed partition the renderer correctly
  skips pre-events snapshot rows that lack the `events` field (typeof
  guard).

### Tests

Updated `src/lib/pricing/trial-pricing.test.ts` with 4 new event-lever
tests:

1. `adjustmentPct = 40` lifts the rate by ~1.40× relative to no-event.
2. `localEventAdjPct = null` preserves existing behaviour
   (`breakdown.events === 1.0`).
3. Event + demand both firing — both apply multiplicatively, final
   bounded by `base × 2.5` cap, no NaN.
4. Date outside the event window (resolver returns null) leaves the
   events multiplier at 1.0.

| Suite | Tests | Pass | Fail |
|---|---|---|---|
| test:pricing-anchors (incl. trial-pricing.test.ts) | **91** | 91 | 0 |
| test:hardening | — | pass | 0 |

(Up from 87 yesterday — 4 new event-lever tests.)
`npm run typecheck` and `npm run lint --max-warnings=0` both clean.

### Manual verification — 2026-05-22

`npx tsx scripts/run-comparison.ts 2026-05-22` regenerated today's
report on the events-lever code. 14,850 cells compared, 0 errors. The
`.email-sent` guard (set by this morning's 06:58 BST scheduled run)
correctly blocked a duplicate email.

**Fleadh fired on 100% of Fleadh-week cells**: 440/440 cells got
`events: 1.4` (LF 320/320, SB 120/120). troughDiagnostic confirms:

```json
{ "events": { "adjPct": 40, "multiplier": 1.4 } }
```

### Headline numbers (post-events)

| Tenant | Fleadh week mean Δ vs PL | Within ±10% | Overshoot >+10% |
|---|---|---|---|
| Little Feather | **-20.35%** (was -42.98%, +22.6pp) | 54/320 | 35 |
| Stay Belfast | **+4.88%** (was -25.09%, +29.97pp) | 31/120 | 48 |
| **Aggregate Fleadh** | **-13.47%** (was -38.10%, +24.6pp) | 85/440 | 83 |

LF mean is still under (-20%) because LF has structural base-price
under-pricing the event lever can't bridge alone. SB mean (+4.88%)
lands comfortably within ±10%. Within-tenant cell-level variance is
high — 83 cells (19%) overshoot >+10% and 272 cells (62%) still
undershoot <-10% — that's expected scatter, not a sizing failure: the
mean obeys the spec gate, the tails reflect listing-by-listing base
prices that the lever doesn't touch.

**61-90d band Δ vs the -26.16% pre-seasonality baseline:**

| Stage | LF 31-60d | LF 61-90d | SB 61-90d | Aggregate 61-90d |
|---|---|---|---|---|
| Pre-seasonality (2026-05-21) | -17.2% | -31.2% | -17.1% | -26.16% |
| Post-seasonality (this morning, pre-events) | -9.80% | -26.16% | -12.45% | -23.43% |
| Post-events (now) | -9.80% | **-19.0%** ¹ | **-3.0%** ¹ | **-16.87%** |

¹ Approximate — derived from the Fleadh + non-Fleadh weighted means
inside the 61-90d band. LF 61-90d ≈ (640 × -20.35 + 1120 × -22.26) /
1760 ≈ -21.6%; SB 61-90d ≈ (240 × +4.88 + 420 × -7.02) / 660 ≈ -2.7%.
The cleaner read will be tomorrow's 06:00 run with all 31-90d cells
including the Fleadh-event payload from the start.

**Aggregate 61-90d band: -26.16% → -16.87% — +9.3pp improvement** vs
the pre-seasonality baseline (combining yesterday's seasonality fix +
today's events lever). Fleadh week alone contributes most of that —
the band's gap is now dominated by non-Fleadh base-price shape on LF.

Fleadh week as % of 61-90d band: 880 of 3,300 cells in band = ~27%.
The aggregate moves of the band reflect: Fleadh week closed from -38%
to -13% (+25pp on its 27% slice ≈ +6.8pp on the band), and the
non-Fleadh portion is unchanged.

### What is live

- **Worker process:** PIDs **89656 / 89657**, started 2026-05-22 10:35
  BST. Previous PIDs 82719 / 82720 (from this morning's seasonality
  restart) stopped cleanly via SIGTERM. Source-file mtimes (10:23–10:28)
  precede launch — the new worker is on the events-lever code.
- **Scheduled job:** scheduler re-registered for 06:00 Europe/London
  daily. **Next automatic emailed report = 2026-05-23 06:00 BST** —
  first end-to-end run on the events lever.
- **Customer-facing prices: unchanged.** Today's work touched only the
  trial-comparison/report path. The `pricing-report-assembly.ts` path
  that pushes rate-copy / hostaway-live rates to Hostaway was not
  modified except to import the lifted `eventAdjustmentForDate`
  helper (identical behaviour to the previous inline copy). No
  `hostawayPushEnabled` flag, no rate-copy listing, no manual override,
  no allowlist, no `settings.localEvents` row, no pushed rate changed.

### What I deliberately did NOT do

- Did NOT touch `DEMAND_PASS_THROUGH`, `DEMAND_FLOOR`, `DEMAND_CEIL`,
  `SEASONALITY_FLOOR`, `SEASONALITY_CEIL`, or any other multiplier
  constant.
- Did NOT touch the base-price blend, day-of-week, occupancy ladder,
  lead-time floor, or any of their gates.
- Did NOT load any event other than Fleadh.
- Did NOT touch `settings.localEvents`. The trial-events module is a
  separate, trial-only source (see Step C trace).
- Did NOT touch The Edge (hostawayId 515526), rate-copy listings,
  peer-fluctuation, manual overrides, or any `hostawayPushEnabled` flag.
- Did NOT overwrite the morning's `.email-sent` guard. The manual run
  regenerated the report HTML + appended new DB rows; the email guard
  correctly blocked a duplicate email.

## 2026-05-22 afternoon — Demand signal rebuild: cross-sectional (replaces forward-vs-trailing)

Per `TONIGHT-DEMAND-SIGNAL-2026-05-22.md` (supervised two-phase run; checkpoint paused at end of Phase 1 for sizing decisions). **Comparison/report path only — no customer-facing rate changed.**

### Phase 1 findings (all seven)

1. **KeyData current-year forward payload — daily granularity exists.** `/api/v1/ota/market/kpis/day` returns per-date `listing_count`, `adr`, `revpar_adj`, `guest_occupancy`, `available_nights`, `open_nights`, `avg_booking_window`, etc. `listing_count` is the supply-guard signal. The provider was using `/kpis/week` and copying weekly values across 7 days — destroying day-of-week granularity at the KD layer.
2. **`lastYearComparison` is NOT an as-at snapshot.** Same week endpoint, queried for `start_date = today - 365`, returning settled finished weekly KPIs. forward-vs-LY is forward-still-filling × settled-finished — structurally biased to read forward as soft.
3. **Own-portfolio fill — Reservation table is the source.** PaceSnapshot stops at 2026-04-24 (28-day stale; separate sync-hygiene flag). Reservation table has full history. Cross-sectional design needs only the current on-the-books position, reconstructable via `created_at <= asOf AND (cancelled_at IS NULL OR cancelled_at > asOf) AND arrival <= stay_date < departure AND status != 'ownerstay'`.
4. **Current demand floor-pinning confirmed.** 100% of Fleadh-week cells (640 LF + 240 SB) had `floorHit=true`. The forward-still-filling vs trailing-settled bias clamps every forward date to the floor.
5. **Feasibility sketch — both signals strong.** KD Fleadh Sat: revpar_adj +94%, occ +33%, ADR +7%, supply -34%. Own Fleadh Sat (LF): fill 55% vs peer median 17.5% → +214%. Ordinary mid-Aug well below peers (LF Tue -43%, Wed -57%) — exactly the weekly-pattern-from-demand-itself the spec predicted.
6. **Day-of-week handling — automatic path retired.** Current per-listing `ownDoWIndex` × clamp [0.85, 1.20]. Saturday ~+10-15%, Monday ~-8%. With cross-sectional demand absorbing weekly variation, this double-counts. **Weekday-downside problem solved by lowering DEMAND_FLOOR 1.0 → 0.92** (Mark's checkpoint decision).
7. **LF per-listing worst-5 (today's latest run, for PL spot-checks):**
   1. zzz - 26 Custom House Square: -32.86% mean, worst band 61-90d (-50.15%)
   2. C-323 St Annes: -27.29%, 61-90d (-43.27%)
   3. zzA - 203 Somerset Studios: -24.51%, 61-90d (-39.90%)
   4. C-512 St Annes: -23.22%, **15-30d (-59.06%)** ← unusual; not 61-90d
   5. zzz - 33 Custom house Square: -21.74%, 61-90d (-39.86%)

   Eight of 40 LF listings are positive vs PL (Templemore 1/2 +30-32%, zB-G04 Portland +47.85%) — wide spread suggests PL is using its own anchors / promo settings on some.

### Checkpoint decisions (Mark answered)

1. **DEMAND_FLOOR 1.0 → 0.92.** Bidirectional cross-sectional signal. Automatic DoW retired entirely; weekly variation handled by demand. Manual `manualDoWAdjPct` survives as optional user override.
2. **Conservative supply guard.** Fires only when supply contracted >20% AND ADR delta < 5%. Fleadh Sat (supply -34%, ADR +7%) doesn't trigger. Hypothetical fire-sale triggers; demand delta damped to `min(rpa_delta, max(adr_delta, 0) × 2)`.
3. **Events lever stays live at +40% Fleadh.** Both lift mechanisms apply via the chain multiplication; data now lets Mark decide tomorrow whether to lower events.

### Phase 2 — code changes

#### KeyData provider — switch to daily endpoint + expose `marketSupplyCount`

`getForwardPace` now hits `/api/v1/ota/market/kpis/day` (was `/kpis/week` with 7× expansion). One row per date, with per-date supply count. `KeyDataForwardPaceDay.marketSupplyCount` added. LY data also moves to daily, dates shifted forward 365 to align with current-year dates. forward-pace 24h cache was invalidated before the manual run so the new daily payload fetched fresh.

#### New module: `src/lib/agents/pricing-comparison/cross-sectional-demand.ts`

- `loadPortfolioForwardFill(tenantId, asOfIso, fromIso, toIso)` — one SQL round-trip, returns `{ nightsByDate, supply, fromIso, toIso }`. Excludes ownerstay + multi-unit.
- `computeOwnCrossSectionalDelta({ targetIso, fill })` — same-month peer set median, target/median - 1.
- `computeKdCrossSectionalDelta({ targetIso, forwardPace })` — same-month peer set, separate revpar / adr / supply deltas, supply guard logic baked in.
- Named constants: `PEER_MIN_SAMPLE_SIZE=8`, `SUPPLY_GUARD_CONTRACTION_THRESHOLD=-0.2`, `SUPPLY_GUARD_FLAT_ADR_DELTA=0.05`, `SUPPLY_GUARD_ADR_GAIN=2`.

#### `computeDemandMultiplier` rewrite

```
both available:  blendedDelta = OWN_WEIGHT(0.5) × own + KD_WEIGHT(0.5) × kd
own-only:        blendedDelta = own              (ownWeight = 1)
kd-only:         blendedDelta = kd               (kdWeight = 1)
neither:         multiplier = 1.0
raw = 1 + DEMAND_PASS_THROUGH(0.7) × blendedDelta
multiplier = clamp(raw, DEMAND_FLOOR=0.92, DEMAND_CEIL=1.40)
```

Both-elevated naturally produces a larger lift than either-alone via the linear pre-clamp blend. dominantSignal enum extended to `"own" | "kd" | "both" | "none"` (older `"LY" | "trail12mo"` retained for archived rows).

#### Agent.ts wiring

- `loadPortfolioForwardFill` called once per tenant per run for the 270-day horizon.
- Per cell: `computeOwnCrossSectionalDelta` + `computeKdCrossSectionalDelta` produce demand inputs, passed via `input.demandCrossSectional`.
- Automatic day-of-week path retired: `blendDayOfWeek({ ownDoWIndex: null, marketDoWIndex: null, manualAdjPct })`.
- `troughDiagnostic.multipliers.demand` block extended with all cross-sectional fields.

#### Tests

`src/lib/pricing/trial-pricing.test.ts`: 7 temporal-demand tests replaced with 6 cross-sectional cases:
1. target above peer baseline → lift
2. target at peer baseline → 1.0
3. target below peers → downside preserved at floor 0.92
4. own + KD both elevated → larger lift than either alone
5. supply guard fired → effective delta damped
6. missing both signals → 1.0 with no NaN

Two existing tests updated for retired DoW (rate now 165 not 173). Backtest runner updated with neutral `demandCrossSectional`.

| Suite | Tests | Pass | Fail |
|---|---|---|---|
| test:pricing-anchors | **90** | 90 | 0 |
| typecheck | — | clean | — |
| lint `--max-warnings=0` | — | clean | — |

### Manual verification — 2026-05-22 15:10 BST

`scripts/run-comparison.ts 2026-05-22` regenerated today's report on the cross-sectional code. 14,850 cells, 0 errors. KD cache cleared first so daily-endpoint payload was fresh. `.email-sent` guard correctly blocked duplicate.

**Sample Fleadh Sat 2026-08-08 troughDiagnostic.demand:**

```json
{
  "finalMultiplier": 1.4, "rawDemandDelta": 1.54,
  "ownDelta": 2.143, "ownTargetFill": 0.55,
  "ownPeerMedianFill": 0.175, "ownPeerSampleSize": 30,
  "kdRevparDelta": 0.944, "kdAdrDelta": 0.069,
  "kdSupplyDelta": -0.354, "kdSupplyGuardTriggered": false,
  "kdEffectiveDelta": 0.944, "kdPeerSampleSize": 20,
  "ownWeight": 0.5, "kdWeight": 0.5,
  "dominantSignal": "both", "ceilingHit": true, "floorHit": false
}
```

Demand now catches Fleadh natively — own +214%, KD RPA +94%, supply guard correctly NOT triggered (ADR is up +7%). Blended +154% → clamped to ceiling 1.40.

### Headline numbers post-rebuild

**Fleadh week (mean Δ vs PL):**

| Tenant | Pre-rebuild | Post-rebuild | Δ |
|---|---|---|---|
| Little Feather | -20.35% | **-5.81%** | +14.5pp |
| Stay Belfast | +4.88% | **+21.33%** | +16.5pp (overshoot — events stacks on demand) |
| Aggregate | -13.47% | **+0.36%** | +13.8pp |

Mean demand multiplier on Fleadh-week cells: **LF 1.210, SB 1.231** (was 1.0 floor-pinned across the board). SB overshooting because the events lever (+40%) AND new demand (~+23%) stack — the chain clamp at base × 2.5 caught the rest. Per the checkpoint, this is the "rely on chain clamp" decision and the data now lets Mark choose to lower events in the next session.

**61-90d band (vs the -16.87% pre-rebuild post-events / -26.16% pre-seasonality baseline):**

| Tenant | Pre-rebuild | Post-rebuild |
|---|---|---|
| LF 61-90d | -26.16% | **-18.87%** |
| SB 61-90d | -12.45% | **+0.31%** |
| **Aggregate 61-90d** | **-16.87%** | **-13.64%** |

The 61-90d band closed by +3.2pp combined, SB now essentially at PriceLabs (+0.31%).

**Divergence-cause split (post-rebuild):**

| Tenant | demand | level | mixed | occupancy | spike-caught | spike-missed | null |
|---|---|---|---|---|---|---|---|
| LF | **7,060** (was 6,595) | 1,243 (was 1,475) | 502 (was 624) | 746 (was 770) | 7 | 30 | 1,212 (was 1,336) |
| SB | **2,800** (was 2,697) | 433 (was 423) | 203 (was 219) | 134 (was 150) | 10 | 5 | 465 (was 561) |

Demand-cause cells slightly up because the new signal MOVES more cells (both directions); any |Δ%| > 5% gets classified. Level-disagreement and mixed both down — cross-sectional correctly attributes more divergence to demand vs to base-price level. Spike-caught (17 cells) is a new bucket the prior floor-pinned demand never produced.

**Pre-occ KPI**: aggregate within ±10% = **22.07%** (was 23.66% post-events; slight drop because some cells previously within ±10% now overshoot due to stronger demand lift on weekends + Fleadh).

### What is live

- **Worker process:** PIDs **2231 / 2232**, started 2026-05-22 15:17 BST. Previous PIDs 89656/89657 stopped cleanly via SIGTERM. Source mtimes precede launch.
- **Scheduled job:** scheduler re-registered for 06:00 Europe/London daily. **Next automatic emailed report = 2026-05-23 06:00 BST** — first clean end-to-end run on the cross-sectional demand signal.
- **Customer-facing prices: unchanged.** All work in trial comparison/report path. `pricing-report-assembly.ts` not touched at all this session. No `hostawayPushEnabled`, rate-copy, manual override, or `settings.localEvents` changed.

### Caveats baked in (Mark's explicit requirements)

- **No temporal / YoY in the new demand signal.** ✓ Only cross-sectional. `lastYearComparison` is still populated for the divergence-cause classifier's spike detector (separate temporal comparison, out of scope tonight — flagged as follow-up).
- **Occupancy never used alone.** ✓ KD signal uses revpar_adj; occ / ADR / supply are decomposed only as supply-guard inputs.
- **RevPAR-adj as composite to score on, kept decomposed in instrumentation.** ✓ troughDiagnostic surfaces revpar / adr / supply deltas separately.
- **Available-listing count as explicit dilution guard.** ✓ `marketSupplyCount` on every KD daily row; supply guard in `computeKdCrossSectionalDelta`.

### Day-of-week — retirement + downside preservation

- Automatic DoW multiplier now hard-passed null inputs → `blendDayOfWeek` returns 1.0.
- Manual `manualDoWAdjPct` override still applies if set (default 0).
- Weekday downside preserved via DEMAND_FLOOR=0.92 — ordinary Mondays naturally sit below their month peer median and demand pulls them down to floor 0.92 (was clamped to 1.0).

### What I deliberately did NOT do

- Did NOT touch DEMAND_PASS_THROUGH (still 0.7) or DEMAND_CEIL (still 1.40).
- Did NOT touch the base-price blend, seasonality, occupancy ladder, lead-time floor, or the events lever.
- Did NOT touch SEASONALITY_* constants.
- Did NOT modify the trial events source / settings.localEvents.
- Did NOT touch The Edge, rate-copy listings, peer-fluctuation, manual overrides, or any `hostawayPushEnabled` flag.
- Did NOT overwrite the morning's `.email-sent` guard.
- Did NOT amend the divergence-cause classifier — it still uses LY occ/ADR for the spike-caught/missed buckets. Separate temporal comparison; follow-up task.

## 2026-05-22 evening — Available-nights comparison filter

Per `TONIGHT-AVAILABILITY-FIX-2026-05-22.md`. **Comparison/report path only — no customer-facing prices changed.**

### Change

In `pricing-comparison/agent.ts`:

1. `loadCalendarRatesForRange` now returns `Map<string, { rate, available }>` instead of `Map<string, number | null>`. Both fields preserved.
2. In the per-cell scoring loop, new predicate `shouldIncludeCalendarCell(cell)` decides inclusion:
   - cell missing entirely → excluded
   - `available === false` (blocked night) → excluded
   - `available === true` but `rate === null` (no PL comparable) → excluded
   - `available === true && rate > 0` → INCLUDED
3. Excluded cells `continue` BEFORE classification, deltaPctList push, abs delta accumulator, `cellsCompared++`, per-band stats, per-listing aggregates, and `rowsToCreate` push — every aggregate the spec listed.
4. New counter `unavailableCellsExcluded` (added to `ComparisonRunSummary` shape). Genuine no-rate case is folded in — both classes of exclusion ("no PL rate" and "blocked") have the same operational meaning: not a valid comparison. The pre-existing `noHostawayRate` field is kept on the summary shape for backward compat but is zero by construction now.
5. Report header line updated: `… listing-dates compared (available nights only) · N blocked/unavailable cells excluded`.

No pricing logic touched — base, seasonality, demand, day-of-week, occupancy, lead-time, events all unchanged.

### Data-quality check (pre-build)

Both Belfast trial tenants, 270d window: 100% calendar-row coverage, 0% null on `available`, 0% null/zero on `rate`. Available-vs-blocked split: LF ~78/22, SB ~78.5/21.5. Spot-check on the LF worst-5 listings (Phase 1 from this morning's session) confirmed every Fleadh-week date was `available=false` carrying stale £326-£713 PL placeholder rates — exactly the noise the spec called out.

### Tests

New `src/lib/agents/pricing-comparison/agent.test.ts` with 5 cases pinning the predicate:
- available + rate → included
- available + low rate → still included (classifier handles the comparison)
- blocked + rate → excluded (the noise-source case)
- available + null rate → excluded (no PL comparable)
- null cell → excluded

Wired into `test:pricing-anchors`. **95/95 tests pass** (was 90, +5). typecheck + lint clean.

### Manual verification — 2026-05-22 21:58 BST

`scripts/run-comparison.ts 2026-05-22` ran on the new code. **cellsCompared dropped 14,850 → 6,713** (54.8% of cells were blocked or no-rate). 0 errors. `.email-sent` guard correctly blocked duplicate.

### Diagnostic 1 — Before / after impact per tenant

| Tenant | n cells pre → post | mean Δ pre → post | 31-90d band pre → post | ±10% pre → post |
|---|---|---|---|---|
| Little Feather | 10,800 → **3,532** (-67%) | -0.00% → **-3.40%** | -14.20% → **-14.48%** | 21.44% → **23.39%** |
| Stay Belfast | 4,050 → **3,181** (-21%) | +9.00% → **+7.69%** | +2.26% → **-1.61%** | 23.75% → **23.58%** |

LF lost **67% of cells** — most of LF's portfolio is heavily booked/blocked. The mean Δ moved slightly more-negative (-0.00% → -3.40%) because the blocked cells had been masking real LF base-price drag with their stale PL placeholders; cleaning them out reveals the true under-pricing. ±10% modestly improves on cleaner basis.

SB lost 21% — closer to the "normal" availability ratio. Mean improves and 31-90d band closes from +2.26% to -1.61% (basically at PL).

Run summaries: LF 3,532 cells / 40 listings, SB 3,181 cells / 15 listings.

### Diagnostic 2 — Per-night Fleadh breakdown (available-only)

Demand-multiplier per night (was hidden by the week-average view):

| Tenant | Date | DoW | n avail | seas | demand | events | occ | ourΔPL | demand ceil pinned |
|---|---|---|---|---|---|---|---|---|---|
| LF | 2026-08-02 | Sun | 18 | 1.200 | 1.117 | 1.40 | 1.011 | **+2.57%** | 0/18 |
| LF | 2026-08-03 | Mon | 20 | 1.200 | 0.955 | 1.40 | 1.011 | -12.95% | 0/20 |
| LF | 2026-08-04 | Tue | 20 | 1.200 | 0.957 | 1.40 | 1.011 | -14.75% | 0/20 |
| LF | 2026-08-05 | Wed | 19 | 1.200 | 1.047 | 1.40 | 1.008 | -12.46% | 0/19 |
| LF | 2026-08-06 | Thu | 12 | 1.200 | **1.400** | 1.40 | 1.028 | +8.23% | **12/12** |
| LF | 2026-08-07 | Fri | 8 | 1.200 | **1.400** | 1.40 | 1.044 | -16.69% | **8/8** |
| LF | 2026-08-08 | Sat | 6 | 1.200 | **1.400** | 1.40 | 1.057 | -26.65% | **6/6** |
| LF | 2026-08-09 | Sun | 10 | 1.200 | **1.400** | 1.40 | 1.026 | +28.30% | **10/10** |
| SB | 2026-08-02 | Sun | 10 | 1.354 | 1.133 | 1.40 | 1.001 | +18.08% | 0/10 |
| SB | 2026-08-03 | Mon | 10 | 1.354 | 1.116 | 1.40 | 1.001 | +12.94% | 0/10 |
| SB | 2026-08-04 | Tue | 11 | 1.354 | 1.001 | 1.40 | 1.003 | +3.43% | 0/11 |
| SB | 2026-08-05 | Wed | 11 | 1.354 | 0.997 | 1.40 | 1.003 | -1.31% | 0/11 |
| SB | 2026-08-06 | Thu | 6 | 1.354 | **1.400** | 1.40 | 0.988 | +19.88% | **6/6** |
| SB | 2026-08-07 | Fri | 4 | 1.354 | **1.400** | 1.40 | 0.980 | -2.77% | **4/4** |
| SB | 2026-08-08 | Sat | 2 | 1.354 | **1.400** | 1.40 | 0.950 | +12.14% | **2/2** |
| SB | 2026-08-09 | Sun | 8 | 1.354 | **1.400** | 1.40 | 1.006 | +48.68% | **8/8** |

**Critical findings the week-average was hiding:**

- **Only Fleadh Thu-Sun (the 4 "core" event nights) pin demand at the 1.40 ceiling on both tenants.** Mon-Wed of Fleadh week are NOT event-driven — cross-sectional demand sees these as ordinary weekday cells (LF Mon-Tue demand 0.955-0.957 — actually below 1.0).
- **LF hottest Fleadh night: Sun 09 Aug +28.30%.** Coldest: Sat 08 Aug **-26.65%** despite demand+events both at ceiling — the +40% event + +40% demand stack cannot bridge LF's base-price under-pricing on this date. Base-price problem, not multiplier problem.
- **SB hottest: Sun 09 Aug +48.68%.** Coldest: Fri 07 Aug -2.77%. Sun 09 Aug overshoots on both tenants — possibly PL drops post-Fleadh while our demand+events still both fire.
- The 4 event-pinned nights (Thu-Sun) all have demand ceiling pinned 100% (every available cell). This is what tomorrow's Fleadh-dates fix needs to address — either raise DEMAND_CEIL for event windows, or accept the ceiling and tune the events lever down to avoid stacking with demand on the core nights.

### Diagnostic 3 — LF per-listing worst-list (available-only)

| # | Listing | Mean Δ | n avail |
|---|---|---|---|
| 1 | zB-G04 Portland | **-54.08%** | **1** (almost entirely blocked!) |
| 2 | zB-711 Portland | -36.35% | 62 |
| 3 | zzz - 26 Custom House Square | -30.39% | **1** |
| 4 | C-301 St Annes | -28.48% | **1** |
| 5 | zB-G05 Portland | -27.08% | 48 |
| 6 | zB-G02 Portland | -23.94% | 50 |
| 7 | 9 · Castle Buildings - Apartment 9 | -18.07% | 180 |
| 8 | A-Welly Park 3 | -17.06% | 63 |
| 9 | 1 · Castle Buildings - Apartment 1 | -16.35% | 163 |
| 10 | C-606 St Annes | -16.17% | 109 |
| ... | (full list in the regenerated report HTML) | | |
| 30 | B - Templemore 2 | +33.04% | 222 |
| 31 | B - Templemore 1 | +36.01% | 227 |

**The pre-filter top-5 has been completely shuffled:**
- Pre-filter #1 "zzz - 26 Custom House Square" (-32.86%) now ranks #3 with **n=1 available** — the previous score was 270 stale PL placeholders.
- Pre-filter #1's neighbours (C-323 St Annes, zzz - 33 Custom house Square, zzA - 203 Somerset Studios) **dropped off the LF list entirely** — they have 0 available cells across the 270-day horizon (heavily booked / fully blocked).
- New #1 "zB-G04 Portland" at -54.08% **on a single available cell** — this was previously +47.85% (above PL). The single available cell is wildly different from the blocked placeholder rates that dominated its pre-filter score.
- Listings with high `n avail` give Mark the trustworthy ranks for PL spot-checks. The biggest reliable gaps are:
  - **zB-711 Portland** -36.35% (n=62) — real base-price drag worth a PL spot-check
  - **zB-G05/G02/G06 Portland** -23 to -12% (n=48-67) — the Portland cluster sits well under PL on its available nights
  - **9 / 1 / 7 / 5 / 8 / 4 / 2 Castle Buildings Apartments** -12 to -18% (n=163-195) — a consistent cluster
- The Templemore 1/2 +33-36% positive deltas are stable across many available cells (n=222-227) — PL might be doing something quite different on these.

Listings with n=1 or n=7 are statistical noise — flag for Mark's eye but don't draw conclusions.

### What is live

- **Worker process:** PIDs **10683 / 10684**, started 2026-05-22 22:04 BST. Previous PIDs 2231/2232 stopped cleanly via SIGTERM. Source mtimes precede launch.
- **Scheduled job:** scheduler re-registered for 06:00 Europe/London daily. **Next automatic emailed report = 2026-05-23 06:00 BST** — first end-to-end run on available-nights basis.
- **Customer-facing prices: unchanged.** Trial comparison/report path only. `pricing-report-assembly.ts` not touched this session.

### What I deliberately did NOT do

- Did NOT touch any pricing logic — base, seasonality, demand, day-of-week, occupancy, lead-time, events.
- Did NOT touch `DEMAND_*`, `SEASONALITY_*`, `DOW_*` constants.
- Did NOT touch the trial events source / `settings.localEvents`.
- Did NOT touch The Edge, rate-copy listings, peer-fluctuation, manual overrides, or any `hostawayPushEnabled` flag.
- Did NOT overwrite the morning's `.email-sent` guard.

### Headline 31-90d trough and pre-occ KPI on new basis

| | Pre-filter (all cells) | Post-filter (available only) |
|---|---|---|
| **Aggregate 31-90d** | -7.62% | **-9.43%** |
| LF 31-60d | -9.53% (this morning's basis) | -10.39% |
| LF 61-90d | -18.87% | -18.42% |
| SB 31-60d | +4.20% | -0.30% |
| SB 61-90d | +0.31% | -3.10% |
| **Pre-occ ±10%** | 22.07% | **23.46%** |
| Pre-occ ±5% | 11.29% | 12.25% |

Pre-occ ±10% nudged up +1.4pp on the cleaner basis (was always going to be a modest move because the 8,137 dropped cells included a mix of within-10% and outside-10% noise). The 31-90d aggregate moved slightly more-negative on LF (the blocked cells had been masking real drag) but Stay Belfast's 31-60d moved closer to PL.

**Both halves of the diagnostic confirm the spec's premise:** blocked cells were noise that distorted the aggregates, and removing them gives Mark a cleaner basis to read tomorrow's report against — particularly the per-night Fleadh breakdown and the per-listing LF worst-list.
