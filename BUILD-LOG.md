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
paths. Most likely Tyler's "API Documentation" link in the email points to a
different doc set than the public Postman docs at developer.keydatadashboard.com
that I've been working from.

**Action for Mark in the morning (Step 4 of §14):**
Open Tyler's email and click the "API Documentation" link. Either:
1. Forward the actual URL of that doc page so I can resolve the correct paths, OR
2. Paste the GET/POST URLs for the OTA endpoints (especially "Listings by
   Market" and "Market KPIs Monthly") into a follow-up message and I'll
   update `src/lib/pricing/keydata-provider.ts` accordingly.

Once paths are correct, run `npx tsx scripts/keydata-smoke.ts` to verify.
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

