# Build run 01 — Suggestion safety gates (2026-07-03, overnight)

Prompt: `reviews/observe-learn-2026-07/BUILD-PROMPTS/01-suggestion-safety-gates.md`
Branch: `feat/observe-learn-fixes-2026-07` · starting commit `9529135`.

## TO DEPLOY (nothing deployed by this run — Mark was asleep)

This run changed code and added one migration. To ship:

1. Merge/push `feat/observe-learn-fixes-2026-07` to `main` per the standing deploy protocol (backup tags first).
2. Apply the pending migration to prod (NEVER `migrate dev`):
   `DATABASE_URL="$DATABASE_PUBLIC_URL" npx prisma migrate deploy`
   (adds nullable `observation_windows.last_suggestion_run` JSONB — additive, no backfill needed).
3. Restart the `signals-worker` service on Railway (project `bubbly-quietude`) so the 05:30 observe job runs the gated generator; redeploy the `Signals` web service for the readout routes.
4. Verify: next observe run logs `suggestions=` per tenant; `GET /api/observe/readout?format=text` shows the `blocked` counts and listing names.

No new env vars. No prod writes were made by this run (local dev DB only).

## What changed (one gate per commit)

| Commit | Change |
|---|---|
| `37a9740` | Min-price floor clamp on proposed drops. Resolution: latest `EngineSnapshot.min` → pricing-settings `minimumPriceOverride` (property scope) → lowest `rate_states` rate over trailing 180d → else clamp skipped + `detail.floorUnknown`. Clamped-to-≥-current-rate drops are suppressed (blocked `min_floor`). |
| `7f48d1e` | Event shield: candidate nights resolved via the shared `eventAdjustmentForDate`; sources are the trial-events file (Fleadh 2026) plus any `localEvents` already in pricing settings (read-only; portfolio/group scope applied tenant-wide — over-blocking is the safe direction). Positive-adjustment nights blocked (`event`). Exported `tenantNameSlug` from `trial-tenants.ts` for the lookup. |
| `0890fe8` | No compounding: nights with an approved/applied suggestion (same tenant/listing/date, any clientKey) blocked (`already_actioned`); prior non-pending drops created in the trailing 14d totalling ≥ 25% for a night blocked (`cumulative_cap`). |
| `407fb15` | Occupancy calibration: curve fill × tenant trailing-365d final occupancy for matching DOW (from `NightFact`, unit-capped, tenant-filtered) before the `RISK_FILL_THRESHOLD` comparison; drop size + confidence derive from the scaled fill; reason keeps raw and scaled values. |
| `8f7f5b9` | Multi-unit (`unitCount ≥ 2`): booked only when occupied units ≥ unitCount; `revenueAtRisk = rate × unsold units` (per-listing v1, no `group:` pooling). |
| `2574d2b` | Blocked-counts persistence: new nullable `observation_windows.last_suggestion_run` JSONB (migration `20260703210000_observation_window_last_suggestion_run`); readout renders "Blocked by safety gates: N (reason n …)". |
| `0064395` | Readout suggestions table shows `Listing.name` (tenant-filtered join), id fallback. |

All logic lives in the pure exported functions in `src/lib/observe/suggestions.ts`
(`judgeNightForSuggestion` / `buildSuggestionDrafts`), DB wiring in
`generateSuggestionsForClient`; readout changes in `src/lib/observe/readout.ts`.
The 30-day window gating and pending-only posture are untouched.

## Test evidence (full gate green)

- `npm run typecheck` — exit 0
- `npm run lint -- --max-warnings=0` — exit 0
- `npm run test:tenant-isolation` — "Tenant isolation check passed", exit 0
- `npm run test:observe` — 93 tests, 93 pass, 0 fail (suggestions.test.ts grew 5 → 15 tests: min clamp incl. floorUnknown + fractional floor, +50% event night blocked, negative adjustment not blocked, actioned-night skip, cumulative cap at/under 25%, occupancy-scaled trigger with raw value kept in reason, multi-unit booked/revenueAtRisk; readout.test.ts 3 → 5: blocked line + name fallback)
- Local runtime smoke against the dev DB (all 6 tenants): generator + readout ran clean end to end; Little Feather produced `blocked={"min_floor":10}` (floors engaging for real), 100% of readout rows carried listing names, blocked counts persisted and read back.

## Notes for auditors

- Migration was created by hand and applied via `prisma db execute` + `migrate resolve --applied` because the LOCAL dev DB has pre-existing drift that makes `prisma migrate dev` demand a destructive reset. The migration SQL is a single additive `ALTER TABLE ... ADD COLUMN`. Prod apply is a normal `migrate deploy`.
- Cumulative cap counts ALL non-pending prior suggestions (including rejected) per the prompt's wording — worth a sanity look: four rejected 7% drops in 14 days will mute a night.
- Group/portfolio-scope `localEvents` are applied tenant-wide by the shield (deliberately conservative for a drop suppressor); property-scope events apply per listing.
- DOW occupancy denominator uses currently-active listings × 365d; listings added mid-year understate occupancy → fewer suggestions (safe direction), noted in the code comment.
- `GenerateSuggestionsResult` gained `blocked`; `ObserveRunResult.suggestions` in `observe-service.ts` (prompt 02/04 territory) was deliberately left untouched — the wider return is structurally assignable.
