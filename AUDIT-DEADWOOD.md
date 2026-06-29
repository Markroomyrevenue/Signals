# AUDIT-DEADWOOD.md — Agent 8 (dead-wood / cleanup discovery)

**Phase:** DISCOVERY ONLY. Nothing in this file has been deleted or edited. Every
row is a candidate for a *later* cleanup pass.

**Scope:** provably-unused code anywhere in the repo, including the Calendar tab
(dead-code removal is in scope even though Calendar metrics are not). AirROI first.

**Method:** manual import-chain tracing (grep over `src/`, `app/`, `scripts/`,
`package.json`, `.env*`) cross-checked against three static analysers run on
2026-06-29: `npx knip@6.23.0`, `npx ts-prune@0.10.3`, `npx depcheck@1.4.7`. All
three ran clean (exit 0). Tool caveats below.

**Excluded as known false positives / out of scope:**
- `.claude/worktrees/strange-spence-7704a8/**` — a stale git worktree; knip
  double-counts every file in it. Not the live tree. Ignored throughout.
- `scripts/audit/**` — the audit harness itself (per charter).
- Next.js entrypoints: `app/**/page.tsx|route.ts|layout.tsx|error.tsx|loading.tsx|robots.ts`,
  and worker entrypoints `src/workers/**` — these have no inbound imports by
  design and are NOT dead. knip/ts-prune flag them; all such flags discarded.
- The report builders in `src/lib/reports/service.ts` (`buildSalesReport`, etc.)
  — reached via `app/api/reports/**/route.ts`; not dead.
- `autoprefixer` / `postcss` — used by `postcss.config.js` (depcheck FP). KEEP.

**Tool reliability note:** `knip` was run with **no config**, so it reported 161
"unused files" and 175+ "unused exports" — the overwhelming majority are
route/page/worker entrypoints and cross-module type exports it can't resolve.
Only candidates I could independently confirm by grep appear below. `timeout`
is unavailable on this macOS host; tools were run un-timeboxed instead.

---

## Group A — AirROI (intentionally dead; remove)

`createMarketDataProvider()` in `src/lib/pricing/market-data-provider.ts:49-61`
returns `null` **unconditionally**. Its single caller,
`buildMarketPricingContexts()` (`src/lib/pricing/market-recommendations.ts:316`),
short-circuits to an empty `Map` the moment the client is null
(`market-recommendations.ts:320-322`). Therefore **every** AirROI code path below
the null-check is unreachable at runtime, and the only live thing the AirROI
files still provide is a set of **type aliases** (`AirRoi*`) re-exported through
`market-data-provider.ts` and consumed by `market-recommendations.ts`. The whole
chain — `airroi/client.ts` → `external-api-cache.ts` → `ExternalApiCache` Prisma
model — is dead together.

### A.1 — AirROI references (every remaining one), with safety call

| # | Location (file:line) | What it is | Safe to strip? |
|---|---|---|---|
| 1 | `src/lib/airroi/client.ts` (whole file, 305 lines) | `DefaultAirRoiClient`, `createAirRoiClient` — the real HTTP client | **HIGH** — zero inbound imports except `airroi/index.ts` (also dead). Confirmed by grep: nothing constructs it; `createMarketDataProvider` never calls it. |
| 2 | `src/lib/airroi/index.ts` (whole file) | barrel `export * from client/types` | **HIGH** — zero importers. `market-data-provider.ts` imports `@/lib/airroi/types` directly, not the barrel. ts-prune lists all its re-exports as unused. |
| 3 | `src/lib/airroi/types.ts` (whole file) | `AirRoi*` type definitions | **MEDIUM** — still *type-referenced* by `market-data-provider.ts:1-12` and (via aliases) `market-recommendations.ts:3-8`. Cannot delete until those two files are cleaned. Delete *with* them, not before. |
| 4 | `src/lib/external-api-cache.ts` (whole file) | `withExternalApiCache` + cache read/write | **HIGH** — sole caller is `airroi/client.ts:2,87`. Dies with the client. |
| 5 | `prisma/schema.prisma:64-79` — `model ExternalApiCache` (`external_api_cache` table) | DB-backed AirROI response cache | **KEEP / ASK** — only touched by `external-api-cache.ts`. Code is safe to remove, but dropping the table is a **migration** + the prod table may hold rows; defer to a deliberate migration step. |
| 6 | `src/lib/pricing/market-data-provider.ts` (whole file) | `MarketDataProvider` alias + `createMarketDataProvider()` factory (returns null) | **MEDIUM** — still imported by `market-recommendations.ts:2`. Its `Market*` type aliases are re-exported and used. Remove only as part of the market-recommendations decision (B-row below). The factory body itself is pure dead scaffolding. |
| 7 | `src/lib/features.ts:1-3` — `liveMarketRefreshEnabled()` | reads `ROOMY_ENABLE_LIVE_MARKET_REFRESH` | **KEEP / ASK** — still imported by `app/api/reports/pricing-calendar/route.ts:5` and `app/(dashboard)/dashboard/page.tsx:6`. It gates `allowLiveMarketRefresh`, which is threaded down to the (dead) provider. Functionally inert today (the flag only ever reaches a null-returning factory), but it is *wired into live route code*, so removing it touches the calendar route + dashboard page. Strip in the same pass that removes the provider. |
| 8 | `src/lib/env.ts:20-22` — `airroiBaseUrl`, `airroiApiKey`, `airroiCacheTtlDays` | env-config fields | **MEDIUM** — only read by `airroi/client.ts`. Dead once #1 goes. |
| 9 | `src/lib/external-api-cache.ts:7` — `type CacheProvider = "airroi"` | the only cache provider value | **HIGH** — dead with #4. |
| 10 | `CLAUDE.md` — "## AirROI is intentionally disabled" section (≈lines 67-77) | stale operational note | **MEDIUM (doc)** — the charter explicitly calls this out as stale and to be removed once AirROI is gone. Update/remove in the cleanup pass. |
| 11 | `src/lib/pricing/market-anchor.ts:725,737` — comments "no AirROI calls" | reassurance comments | **LOW (doc)** — harmless; update wording when AirROI naming disappears. |
| 12 | `docs/PRICING-WORKED-EXAMPLE.md:29,43,64` — "no AirROI calls" | doc prose | **LOW (doc)** — same. |
| 13 | `src/lib/pricing/market-recommendations.ts:3-8` — `MarketComparableListing as AirRoiComparableListing` etc. + body using `AirRoi*` types (lines 98-487) | the (unreachable) market-context builder | **KEEP / ASK** — see Group B. Large file kept as Key-Data scaffolding. |

### A.2 — AirROI env vars (note for Railway / secret hygiene)

| Location | Var(s) | Note |
|---|---|---|
| `.env.example:6-9` | `AIRROI_BASE_URL`, `AIRROI_API_KEY=[AIRROI_API_KEY]`, `AIRROI_CACHE_TTL_DAYS=14`, `ROOMY_ENABLE_LIVE_MARKET_REFRESH=false` | Placeholders shipped in the example file. Remove these 4 lines in cleanup. |
| `.env.local:1-2` | `AIRROI_BASE_URL`, **`AIRROI_API_KEY=8flzD…`** (a real-looking live key) | **FLAG:** a live AirROI secret is sitting in `.env.local` feeding intentionally-dead code. Recommend deleting the two lines and **rotating/revoking the key** with AirROI. `.env` (committed/base) has no AirROI vars. |
| `.env` | — | none present. |
| Railway | `MARKET_PROVIDER`, `ROOMY_ENABLE_LIVE_MARKET_REFRESH`, `AIRROI_*` | **Could not inspect Railway from here** (no Railway reach in this audit harness). ACTION FOR MARK: check the `Signals` + `signals-worker` services for any `AIRROI_*`, `MARKET_PROVIDER`, or `ROOMY_ENABLE_LIVE_MARKET_REFRESH` vars and unset them as part of the AirROI removal. |

> **AirROI reference count:** **~30 code/comment references across 11 files**
> (8 source files + 2 env files + 1 Prisma model), plus ~13 doc/markdown mentions
> in non-shipping `.md` files (`API-COST-MODEL.md`, `SHIP-SIGNALS.md`,
> `AGENT-STRATEGY.md`, `PLAN.md`, etc.) that are historical and out of app scope.

---

## Group B — Other dead code

### HIGH confidence (zero inbound refs, not an entrypoint, safe to delete)

| Path (+ symbol) | Why unused | Confidence |
|---|---|---|
| `src/lib/tenants/display-name.ts` — `isPlaceholderTenantName`, `resolveTenantDisplayName` (whole 72-line file) | **Zero inbound imports** anywhere in `src/`, `app/`, `scripts/`. Confirmed by grep (`tenants/display-name` → no hits) and ts-prune (both exports flagged). Not a route/worker. | HIGH |
| `app/components/client-setup.tsx` — `default export ClientSetup` (196 lines) | **Zero importers.** It is a component in `app/components/` (NOT a Next.js route — no `page.tsx`), and grep for `ClientSetup` finds no JSX usage or dynamic import. knip + ts-prune both flag it. | HIGH |
| `pptxgenjs` (package.json dependency) | **No source imports the npm package.** `src/lib/powerpoint.ts` loads PptxGenJS at *runtime* from the vendored browser script `public/vendor/pptxgen.min.js` (referenced at `app/components/revenue-dashboard.tsx:5039` via `libraryUrl`), never `import "pptxgenjs"`. depcheck + knip flag it. The vendored `.min.js` STAYS (it's the one actually used); only the npm dep is dead. | HIGH |
| `clsx` (package.json dependency) | **Zero source references.** grep for `clsx` returns nothing in `src/`/`app/`. depcheck + knip agree. | HIGH |
| `csv-parse` (package.json dependency) | **Zero source references.** grep finds nothing. depcheck + knip agree. | HIGH |
| `src/lib/external-api-cache.ts` | (also listed as AirROI A.4) sole caller is dead AirROI client. | HIGH |

### KEEP / ASK (plausibly reachable, replaced-but-retained, or risky to remove blind)

| Path (+ symbol) | Why flagged / why not high-confidence | Confidence |
|---|---|---|
| `src/lib/pricing/market-recommendations.ts` (whole file, esp. `buildMarketPricingContexts` body lines 320-500+) | Reached at runtime but **always returns an empty Map** because the provider is null. It's the Key-Data integration scaffold (CLAUDE.md/memory say Key Data replaces AirROI here). Still imported live by `src/lib/reports/service.ts:7,4785` and `pricing-report-assembly.ts:11`. Deleting changes a hot path — must be a deliberate decision, not dead-wood sweep. | KEEP / ASK |
| `prisma ExternalApiCache` model + `external_api_cache` table | Removing requires a migration and the prod table may have rows. Code-side safe; DB-side needs care. | KEEP / ASK |
| `src/lib/features.ts` `liveMarketRefreshEnabled()` | Wired into the live calendar route + dashboard page (2 importers). Inert in effect, but removal edits customer-facing route code. | KEEP / ASK |
| `ioredis` (package.json dependency) | grep finds **no direct `import "ioredis"` / `new Redis()`** — the queue layer (`src/lib/queue/connection.ts`) hands plain connection options to BullMQ. BUT `ioredis` is BullMQ's hard runtime peer dependency; removing the explicit pin could break the queue if BullMQ doesn't hoist it. Verify against BullMQ's deps before removing. | KEEP / ASK |
| Deprecated exports in `src/lib/pricing/trial-pricing.ts` (`@deprecated` markers at lines 352, 445, 447; "dead code" note 1056-1057) and `cross-sectional-demand.ts:393,514` | Authors marked them superseded but explicitly "kept for backward compat." Some are still referenced by tests / sibling modules (e.g. the `forwardRevparAdj` family is a *different*, still-live KeyData field — do not conflate). Needs per-symbol tracing before removal. | KEEP / ASK |
| `src/lib/backtest/runner.ts` + `src/lib/backtest/report.ts` | Only consumer is `scripts/run-backtest.ts`, which is **not** in any `package.json` script (only named in a doc comment in `send-build-complete-email.ts`). Dev/analysis tooling, not app-reachable — but may be intentionally-kept analysis scripts. | KEEP / ASK |
| One-off `scripts/*.ts` not wired into `package.json`: `_verify-cleanup.ts`, `_verify-cross-tenant-cleanup.ts`, `backfill-vat-rate.ts`, `diagnostics-2026-05-20.ts`, `keydata-smoke.ts`, `reset-roomy-pricing-settings.ts`, `run-backtest.ts`, `run-comparison.ts`, `run-day14-summary.ts`, `send-build-complete-email.ts`, `set-trial-scope.ts`, `snapshot-trial-final.ts` | Invoked manually via `tsx`, not by the app. Dated/one-off (e.g. `diagnostics-2026-05-20.ts`, `snapshot-trial-final.ts`) look spent; others are reusable ops tooling. Low value, low risk, but not app dead-code — owner's call which to prune. | KEEP / ASK |
| `app/api/admin/reset-and-sync-live/route.ts` (POST) | A destructive admin route with no UI caller found; reachable by direct POST (it's a Next.js route = entrypoint). NOT dead — flagging only so cleanup doesn't assume "no caller" = safe to drop. | KEEP / ASK |

### Notes on what is NOT dead (false-positive guard)
- `src/lib/business-review.ts`, `src/lib/powerpoint.ts`, `src/lib/login-rate-limit.ts`,
  `src/lib/metrics/**`, `src/lib/sync/pace.ts`, all `src/lib/observe/**`,
  `src/lib/signals/**` — flagged by knip's no-config run but each has a real
  inbound import (e.g. `powerpoint`/`business-review` ← `revenue-dashboard.tsx`).
  Kept off the removal list.
- `autoprefixer`, `postcss` — used by `postcss.config.js`. KEEP.
- `@next/env` (depcheck "missing") — provided transitively by Next; used in
  `src/lib/load-env.ts`. Not an issue.

---

## Summary (≤12 lines)

- **High-confidence removals: 6** — `src/lib/airroi/client.ts`,
  `src/lib/airroi/index.ts`, `src/lib/external-api-cache.ts`,
  `src/lib/tenants/display-name.ts`, `app/components/client-setup.tsx`, and the
  npm deps `pptxgenjs` + `clsx` + `csv-parse` (3 deps; AirROI `types.ts` /
  `market-data-provider.ts` are MEDIUM — delete *with* their consumers, not before).
- **AirROI reference count: ~30 code/comment refs across 11 files** (8 source +
  2 env files + 1 Prisma model), plus ~13 historical mentions in non-shipping docs.
- **Live secret flagged:** `.env.local` holds a real `AIRROI_API_KEY` feeding dead
  code → delete the line and rotate the key. `.env.example` has 4 stale `AIRROI_*`
  placeholder lines.
- **Riskiest keep/ask items:** (1) `market-recommendations.ts` — runtime-reached
  but always returns empty; the Key-Data scaffold, so don't sweep it as dead-wood;
  (2) dropping the `external_api_cache` table (migration + possible prod rows);
  (3) removing the explicit `ioredis` pin (BullMQ peer — verify first).
- **Could not inspect Railway env** from this harness — Mark must check
  `Signals`/`signals-worker` for `AIRROI_*` / `MARKET_PROVIDER` /
  `ROOMY_ENABLE_LIVE_MARKET_REFRESH` and unset them during AirROI removal.
- Nothing was deleted or edited; this is discovery only.
