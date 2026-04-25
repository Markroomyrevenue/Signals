# Overnight Review Plan — 2026-04-25

Orchestrator: Claude (Opus 4.7).

## Context internalised
- Owner non-technical; clarity > cleverness; no new product features.
- AirROI is intentionally disabled in `src/lib/pricing/market-data-provider.ts` — keep it that way; **no AirROI API calls**.
- Hostaway public-API + webhooks is the next milestone but is **not pre-built** here.
- Cancelled-booking pace logic is correct — **do not touch**.
- Multi-tenant isolation must be airtight.
- Aesthetic: Airbnb-host clarity, explicit menu names, aggressive removal of marketing-style filler copy.
- Mobile must work at 380px (Chrome/Safari/iOS Safari/Android Chrome).
- Each fix lands as its own commit so the owner can roll back individually.

## Survey findings vs brief (deviations noted)

| Brief assumption | Reality | Adjustment |
|---|---|---|
| `SYNC_CONFIG` 800/540 days | `src/lib/sync/config.ts` has `reservationFallbackBackDays:800, reservationFallbackForwardDays:540` (these *are* the relevant constants). Calendar fetch is separately 90/365. | Subagent 1 changes the **reservation fallback** values to 365/365 and exposes `SYNC_DAYS_BACK` / `SYNC_DAYS_FORWARD`. Calendar fetch window is left alone. |
| `app/components/date-range-picker.tsx` "if not already" | Does not exist. | Subagent 3 creates it. |
| Standalone nav/sidebar | None — nav is inline inside `app/components/revenue-dashboard.tsx` (8770 lines). | Subagent 3 renames labels in that same file but does not rip out the structure. |
| `CLAUDE.md` exists at root | No `CLAUDE.md` anywhere. | Subagent 1 creates `CLAUDE.md` at repo root with the SYNC config + AirROI gate notes. |
| `src/lib/reports/**` for "signals" logic | Folder contains `service.ts`, `pricing-report-assembly.ts`, `pricing-domain.ts`, `schemas.ts`. Attention-task logic lives in `service.ts`. API route is `app/api/reports/attention-tasks/resolve/route.ts` (no top-level `route.ts`). | Subagent 5 works against `service.ts` + new `signal-suggestions.ts` + the `resolve` route. |
| Calendar code lives "in components and pages" | Already extracted to `app/components/revenue-dashboard/calendar-grid-panel.tsx`, `calendar-settings-panel.tsx`, `calendar-utils.ts`. Calendar API at `app/api/reports/pricing-calendar/`. | Subagent 4 stays inside that subdirectory + the API route. |

## Ownership boundaries inside `app/components/revenue-dashboard.tsx`
This 8770-line file is touched by three subagents. To minimise merge conflicts:
- **Subagent 3 (UI polish)** — owns: nav/menu labels, top-of-page headers, date-range filter UI, sync-progress UI, page-level layout for home/pace/reservations/sales/book-window/drilldown. **Avoid**: any block where `pricingCalendarReport` is rendered (that's the calendar) and any block where attention-tasks/signals are rendered (that's signals).
- **Subagent 4 (calendar)** — owns: calendar grid + popup + price-cell behaviour. Most edits should land in `app/components/revenue-dashboard/calendar-*` files. If touching `revenue-dashboard.tsx` is unavoidable, restrict to calendar render blocks.
- **Subagent 5 (signals)** — owns: the signals/attention-tasks render block in `revenue-dashboard.tsx`. Most logic edits land in `src/lib/reports/`.

If two agents must touch the same JSX region, the **later merge** is responsible for resolving — the orchestrator will hand-resolve trivial conflicts during Phase 3.

## Subagent briefs (summary; full briefs in conversation context)

### 1. data-foundations  (branch `review/data-foundations`)
Sync resumption hardening, Prisma indices migration `20260425010000_data_foundations_indices`, partition coverage, `SYNC_DAYS_BACK`/`SYNC_DAYS_FORWARD` env overrides (defaults 365), pricing **base** recommendation stabilisation in `src/lib/pricing/market-anchor.ts:639` (`buildRecommendedBaseFromHistoryAndMarket`), min = base × 0.7. Creates `CLAUDE.md`. **Do not** touch cancelled-booking pace logic. **Out of scope**: any UI.

### 2. security  (branch `review/security`)
Tenant isolation audit + automated check script in `scripts/`, role gates server-side (viewer locked out of calendar/pricing/team), zod parse on every POST/PATCH/DELETE, secret-leak grep, login rate-limit ≥ 5/15min/IP, session cookie hardening. Writes `SECURITY.md`. **Out of scope**: UI styling, non-security backend.

### 3. ui-polish  (branch `review/ui-polish`)
Cut filler copy across home/pace/reservations/sales/book-window/drilldown/attention-tasks-UI/settings/team/login/client-selector/client-create-form. Extract single `app/components/date-range-picker.tsx`. Compress headers to ≤120px desktop / ≤80px mobile. Mobile pass at 380px. Sync-progress shows "X of Y". Add "Manage team" link on client-selector. Rename clever menu labels to literal nouns. Run `npm run lint` after each commit. **Out of scope**: calendar UI, signals UI, backend logic.

### 4. calendar-pricing  (branch `review/calendar-pricing`)
Deep UX audit → `CALENDAR-REVIEW.md` + fixes. Popup anchored to viewport, clear primary action, base/min visually distinct, suggested-price rationale text (read-only, no Apply button), mobile layout (horizontal-scroll with sticky listing column or single-listing dropdown). **No AirROI calls.** Read PLAN.md before/after each commit. **Out of scope**: pricing calc (subagent 1), non-calendar UI.

### 5. signals-engine  (branch `review/signals-engine`)
Sort signals by imminence → severity. Drop signals beyond +6 months. Imminent low-occupancy (next 14d) always pinned to top. New helper `src/lib/reports/signal-suggestions.ts` returning 1–3 read-only suggestion strings derived from same-tenant historical patterns. Tenant-isolated. Mobile-readable cards. **Out of scope**: anything not signal-related.

## Global rules
- Never push directly to origin (push only happens at the end of Phase 3).
- Never modify `package.json` deps without explicit reason in commit body.
- Never edit existing migrations 20260227161000_init through 20260424220000.
- Out-of-scope findings → one-liner in `REVIEW-NOTES.md` under "Cross-cutting findings".
- If typecheck fails and unfixable in 30 min → final commit "WIP: typecheck failing — needs human review"; orchestrator skips merge.

## Merge order (Phase 3)
1. data-foundations (foundation: indices, sync constants, pricing logic)
2. security (may add a check script that exercises route handlers)
3. ui-polish (largest UI surface; date-range-picker extraction touches many pages)
4. calendar-pricing (depends on subagent 1's pricing logic stabilisation)
5. signals-engine (consumes tenant data; lands last to absorb any rebase fallout)

After each merge: `npm run typecheck` then `npm run test:tenant-isolation` if it passes through. If a merge breakage cannot be fixed in <15 min: `git merge --abort`, note branch in REVIEW-NOTES.md, continue.

## Final
Push `origin/main` only after all merges (or aborts) complete and typecheck passes. Append final summary to `REVIEW-NOTES.md`.
