# Round 3 — UI / Aesthetics review of push + multi-unit features — 2026-04-25

Five targeted aesthetic / copy fixes on `review/ui-aesthetics`, each as its
own commit. Verifications: `npm run typecheck` PASS, `npm run lint` PASS.

| # | SHA | Summary |
| - | --- | --- |
| 1 | `f136d09` | **review:** distinguish push section as the live-Hostaway zone — 2px green-dark border, faint green tint, "Live" pill next to the eyebrow, body copy tightened (drops "channel manager" jargon). |
| 2 | `bf877d7` | **review:** integer percent + typographic minus for multi-unit Occupancy line — matches the brief's `Occupancy 75% (15/20) at 45-day lead → −2%` exactly. New `formatSignedIntegerPercent` helper used only for multi-unit (matrix integer pcts); `formatSignedPercent` kept for computed multipliers. |
| 3 | `a751735` | **review:** bump multi-unit pill legibility on 380px viewport — 9px → 10px, bold + faint border on the `× N units` pill, harmonised type on the `Grouped` chip. |
| 4 | `0dc1738` | **review:** explicit ON/OFF label next to Hostaway push toggle in the property-pricing card — colour delta alone was ambiguous. Helper copy reworded to plain English. |
| 5 | `ffc2bfe` | **review:** plain-English copy in multi-unit settings section — drops "pricing engine" / "occupancy ladder" / "night-fact data" jargon, splits the peer-set field into label + numeric input + visible "days" suffix. |

## Findings against the 9-check brief

1. **Push UI section — visually distinct, primary action, confirm dialog, last-push line, mobile** — FIXED-IN-COMMIT-1. Section now has a 2px green-dark border, green-tinted background, and a "Live" pill so the eye lands on it as the live-Hostaway zone. Confirm dialog already showed up to 5 sample dates with "and N more". Last-push line lives in muted-text below other content — readable, not buried. Mobile: section sits inside the inspector popup which is `min(540, 92vw)` → ~349px on a 380px viewport; primary `Push next 30 days` button uses `flex flex-wrap` so it wraps to its own line if the "Custom range" button doesn't fit on the same row, which is acceptable.

2. **HostawayPushToggle in property pricing card** — FIXED-IN-COMMIT-4. Label "Push live rates to Hostaway" is non-jargon. State was previously colour-only; now has explicit ON/OFF text in green-dark/muted-text. The `row.settings.hostawayPushEnabled` gate before mounting `<CalendarPushSection>` (calendar-grid-panel.tsx line ~812) still hides the push UI when off — verified.

3. **Multi-unit row badge: "× N units" pill, "Grouped" chip, amber row tone** — FIXED-IN-COMMIT-3. Pill now renders bolder + with a border at 10px so it reads as a clear row marker on 380px. Amber row tint applies to the property column tile (`rgba(252,244,220,0.7)`) — verified at calendar-grid-panel.tsx line ~1119.

4. **Per-cell `X/N (P%)` text — doesn't crowd price, readable, hides gracefully** — PASS. Renders only when `multiUnitUnitsTotal !== null && multiUnitUnitsSold !== null` (calendar-grid-panel.tsx line 1405). Price stays at `text-[15px]` while the multi-unit line is `text-[9px]` — clear hierarchy. At 84px desktop column width, all four lines (price, secondary label, X/N, min-stay) fit comfortably; at the smaller mobile cells the same column width is preserved by the table's `min-w-max table-fixed` so no squeezing happens — mobile gets horizontal scroll.

5. **Inspector breakdown for multi-units: "Occupancy 75% (15/20) at 45-day lead → −2%"** — FIXED-IN-COMMIT-2. Formula matches the brief exactly, integer percent, typographic minus. The generic "Occupancy" row in the smaller `From base to recommended` block (single value, e.g. `−2.0%` from `renderMultiplierRow`) is intentionally separate — that block runs for ALL listings, not just multi-unit. The detailed multi-unit format only replaces the entry in the larger "Why this price" rationale list. Not a duplication.

6. **Settings panel multi-unit section — copy, validation, matrix mobile, peer-set unit suffix** — FIXED-IN-COMMIT-5. Section blurb, lookup paragraph, and peer-set field all rewritten to drop jargon. Peer-set now has a visible "days" suffix on the right of the input. Matrix table is wrapped in `overflow-x-auto` (line 564) — mobile gets horizontal scroll, which is the right call here since stacking 7 lead-time buckets vertically per occupancy row would be a worse UX. The `Number of units` input and validation hint copy is plain English and still passes (validator rejects only `< 0`). Default placeholder `Leave blank for a single-unit listing` is fine.

7. **Inspector section ordering / repetition** — PASS. Order from top: pricing-detail card (close X, badges, date H2, listing name, 4 rate cards including Recommended at top, breakdown, Why-this-price, min-stay/demand) → property-pricing editable card (anchor summary, Quality, Hostaway toggle, Base/Min inputs, Save/Reset) → push section. Recommended rate is the first thing visible and the breakdown sits below it. Push section sits last because it's a write action that depends on the read-only context.

8. **Plain-English copy review across new strings** — FIXED-IN-COMMITS-1/4/5. Removed "channel manager" (×2), "pricing engine", "standard occupancy ladder", and "night-fact data". No `/api/` references in user-facing strings (only in fetch URLs which the user never sees).

9. **Mobile-first / fixed-pixel widths** — PASS. The matrix table relies on horizontal scroll. The unit-count input grid uses `md:grid-cols-[180px_minmax(0,1fr)_120px]` which collapses to single-column below md. The push section's flex-wrap row of buttons handles narrow widths. The inspector popup is `min(540, 92vw)` so it always fits the viewport.

## Items deliberately NOT touched

- The push button copy "Push next 30 days" — once the section is wrapped in the new green-bordered Live treatment (commit 1), the button reads as "the live action of this live section." Adding "to Hostaway" to the button itself would be redundant inside this framing.
- `formatSignedPercent` (one-decimal) for non-multi-unit multipliers — they're computed values where the decimal carries information; matrix deltas are stored as integers, so they get the integer formatter.
- Confirm dialog copy "Push N dates to Hostaway?" — already direct and unambiguous; no edit needed.
- The "From base to recommended" `Occupancy` row stays generic because the block runs for all listings, not just multi-unit.

## Files touched

- `app/components/revenue-dashboard/calendar-push-section.tsx`
- `app/components/revenue-dashboard/calendar-grid-panel.tsx`
- `app/components/revenue-dashboard/calendar-utils.ts`
- `app/components/revenue-dashboard/calendar-settings-panel.tsx`

---

# Round 2 follow-up — 2026-04-26

Six targeted owner-feedback fixes shipped sequentially after Round 1, each as
its own commit so they can be rolled back individually. Verifications:
`npm run typecheck` PASS, `npm run lint` PASS, `npm run test:pricing-anchors`
26/26 PASS, `signal-suggestions.test.ts` **10/10** PASS, `npm run test:tenant-isolation`
PASS, `npm run audit:tenant-isolation` PASS (27 routes, 0 findings).

| # | SHA | Summary |
| - | --- | --- |
| 1 | `67f5398` | **data:** bump sync window back to 730/365 for YoY pace accuracy. Reverts Round 1's 365/365 default — YoY pace requires the current 365 + the prior 365. Env override mechanism unchanged. |
| 2 | `feee9e6` | **calendar:** anchor date inspector to clicked cell, not page top. Captures cell `getBoundingClientRect()` on click and renders inspector via `createPortal` at a viewport-anchored position. Closes on any scroll/resize (no chasing). Mobile bottom-sheet kept (anchoring 420px popup to a 48px mobile cell would clip). |
| 3 | `0ccad7e` | **ui:** portal date-range-picker dropdown so it overlays all content. Dropdown menu now rendered into `document.body` via `createPortal` with `position:fixed` + `zIndex:1000` — escapes any parent stacking context (transforms/opacity/filter on chart cards). Closes on viewport shifts. |
| 4 | `932e82b` | **ui:** horizontal swipe list for signals on mobile. Replaces the rejected accordion with `flex + overflow-x-auto + snap-x mandatory`; cards 88vw with snap-start so the next card peeks. Tiny `CarouselDots` indicator below the strip on mobile only. Same JSX template renders as grid/stack on `sm:+`. |
| 5 | `11c44c0` | **signals:** drop min-stay nudges, use calendar price logic for suggestions. Removed LOS/min-stay branches entirely from `signal-suggestions.ts`. Added `SignalPriceComparison` + new branch: recommended ≤ current × 0.95 → "Dropping to recommended may book the gap"; recommended ≥ current × 1.05 → "leaving revenue on the table"; within ±5% → no suggestion. 10/10 helper tests cover all branches incl. defensive cases. **Service-side wiring of recommended-rate-per-signal is deferred (see § Manual steps).** |
| 6 | `6b5bb67` | **export:** PDF always renders at desktop width regardless of viewport. New `captureNodeAtDesktopWidth` helper temporarily pins the capture node to 1280px, waits 2 RAFs + 220ms for recharts ResizeObservers to fire, then snapshots; original styles restored in `finally`. Both call sites (Business Review PDF + PowerPoint slide) routed through it. |

## Round 2 — Manual steps for the owner

1. **Pull the latest `main`** on any other dev machine (these 6 commits sit on top of the Round 1 merge).
2. **No new Prisma migration this round** — Round 1's `20260425010000_data_foundations_indices` is still the only outstanding deploy task.
3. **Sync window default is now 730 / 365** (was 365 / 365 after Round 1, originally 800 / 540). If `SYNC_DAYS_BACK` is set on Railway, it overrides this default; check whether the override is still needed.
4. **Signal price-comparison wiring (deferred)** — `signal-suggestions.ts` supports a `priceComparisonAtHorizon` input that produces price-driven suggestions ("recommended is X, currently Y, drop / hold"). The home-dashboard call site passes `null` for that field today because pulling per-signal recommended rates requires running the calendar pricing pipeline (`buildPricingCalendarRows` + ~10 supporting loaders) once per affected listing, which is a non-trivial integration and was outside the per-fix budget. To turn the new branch on, wire those loaders in `src/lib/reports/service.ts` near the `buildSignalSuggestions` call (line ~4029). All historical-pattern branches keep working with `null`.

---

# Overnight Review — 2026-04-25

All 5 review branches merged into `main`, then pushed.
Verifications run after the final merge: `npm run typecheck` PASS, `npm run lint` PASS, `npm run test:tenant-isolation` PASS, `npm run test:pricing-anchors` 26/26 PASS, `npm run audit:tenant-isolation` PASS (27 routes, 0 findings), `signal-suggestions.test.ts` 6/6 PASS.

Branches preserved locally for rollback (`review/data-foundations`, `review/security`, `review/ui-polish`, `review/calendar-pricing`, `review/signals-engine`).

---

## 1. What shipped

### Data foundations (`review/data-foundations`, 6 commits)
- **bf5a6b0** Default sync window 800/540 → **365/365**, env-overridable via `SYNC_DAYS_BACK` and `SYNC_DAYS_FORWARD`. New `CLAUDE.md` at repo root documents this + AirROI gate + cancelled-pace + multi-tenant rules.
- **1434350** New migration `20260425010000_data_foundations_indices` adds 6 hot-path indices (`night_facts.reservation_id`, `reservations.source_updated_at`, `sync_runs(status, finished_at)` + `(job_type)`, `listings.tenant_id`).
- **1bb7910** Sync resumption hardening — `cleanupStaleRunningSyncs(tenantId)` runs at the start of every sync, marks any SyncRun stuck "running" past 30 min as failed with an explicit warn log.
- **0011c5b** Partition coverage: `src/lib/db/partitions.ts` now walks every tenant's reservation arrival/departure span and ensures partitions exist for every covered month (idempotent).
- **5d9c1c5** Pricing stability — rewrote `buildRecommendedBaseFromHistoryAndMarket()` with documented formula (listing-size anchor + trailing-365d ADR + occupancy nudge). Min locked to base × 0.7 in `pricing-report-assembly.ts`. New tests cover "two near-identical apartments → near-identical prices".

### Security (`review/security`, 8 commits)
- **94382ce** New static-analysis script: `npm run audit:tenant-isolation` walks every `app/api/**/route.ts` and asserts auth check + tenant filter + zod parse on mutations. 27 routes audited; currently 0 findings.
- **88350e3** Lock cross-tenant data destruction in `POST /api/tenants/clients` — orphan-cleanup branch could nuke any tenant whose Hostaway API key was known.
- **460a4d3** Lock viewers out of `POST /api/reports/pricing-calendar` (server-side 403).
- **c783a9d** Lock viewers out of `POST /api/listings/groups` (property-group mutations).
- **aae1688** Lock viewers out of `GET /api/hostaway/connection` (was leaking client ID + webhook user).
- **fd80e42** zod schema for `POST /api/sync/run` (was unsafe `as` cast).
- **056cc51** zod schema for `POST /api/webhooks/hostaway/reservations` (was hand-rolled `unknown`/`isRecord`).
- **def077d** New `SECURITY.md` with findings table.

### UI polish (`review/ui-polish`, 15 commits)
- **b530636 / feef8cf / 649f80e** New shared `app/components/date-range-picker.tsx`; wired into Reservations, Home, and Bookings (replaces the toggle-style picker).
- **39c321c** Top dashboard header collapsed to single 32px-tall pill row (now ~64–90px total height including filter row, with wrap).
- **c9ebcf7** Recharts panels on Pace/Sales/Bookings/SignalLab/BookingWindows now `overflow-x-auto` with `minWidth=520`, `height=420` so 380px viewport gets horizontal scroll instead of squashed ticks.
- **b2a611b** Reservations table → stacked card layout per row below 640px.
- **2cd667b** Live sync progress on the open-sync screen now shows "Reservations: 1247 of 1320 synced", "Calendars: 22 of 60 listings", etc.
- **31e73cf** "Manage team" link added to client-selector header for users with admin role on any client.
- **ab70406** Add-client and add-teammate forms simplified (single-column, tighter copy, separated success/error banners).
- **18e6f38** Tab renames: **Sales → Stayed**, **Booked → Bookings**. Nav sub-explainers (`tabDescription`) removed.
- **98906fb / 0c8a9a1 / 376a3db** Aggressive copy cleanup — removed kickers ("Portfolio Lens", "Booked Reservations", "Property-by-Property", "Demand Mechanics", "Expert Workspace", etc.) and tagline paragraphs across non-signal/non-calendar sections.
- **0154d9f** Settings page tightened.
- **2f78cb4** Added `"root": true` to `.eslintrc.json` to fix worktree+parent eslint plugin duplication.

### Calendar + pricing UI (`review/calendar-pricing`, 6 commits)
- **5f8902a** New `CALENDAR-REVIEW.md` documenting full UX audit + decisions.
- **757a7c0** Pricing detail inspector now anchored to viewport (was destroying page scroll); mobile uses fixed bottom-sheet via React portal with body scroll lock.
- **b82f857** Base vs Minimum visually distinct: solid green chip vs dashed mustard chip; grid Base column gets solid bottom-border accent, Min gets dashed; inspector cards reorder Base on top with explanatory captions.
- **ee79f2d** Plain-English rationale + "what this means" footer chip on suggested actions. Read-only — no Apply button (per brief).
- **6616bda** Mobile day list now Monday-anchored 7-column weekly grid with weekend tinting + sticky listing picker top bar.
- **65f69de** Primary action renamed "Edit this property's pricing" (verb-first); explicit "Close / Back to calendar" button.
- **d157aac** (post-merge fix) escaped apostrophe in label to satisfy lint.

### Signals engine (`review/signals-engine`, 4 commits)
- **c251a54** New `src/lib/reports/signal-suggestions.ts` — pure helper, takes a signal + tenant history and returns 1–3 short read-only suggestion strings (sample outputs include last-year rate-cut precedents, LOS hints, portfolio outlier comparisons). 6/6 unit tests green.
- **16e8b91** Signals now sorted by **imminence first, severity second**, with a hard 6-month horizon. Imminent low occupancy (next 14 days) is always pinned to the top.
- **5acb8bd** Signals UI: suggestions render as bullets, new horizon chip, mobile-readable layout at 380px (no horizontal scroll).
- **5c3d706** Defense-in-depth: cap input lengths in `/api/reports/attention-tasks/resolve`.

---

## 2. What was deferred (and why)

- **Wire heavier rate-history queries into `loadSignalHistoryByListing`** (subagent 5) — `lastYearRateCutThatBooked` and `recentHeldRateThatBooked` slots emit `null` today; the suggestion module already produces useful output without them. Keeping the engine shippable in one merge.
- **Page-level admin redirects on `/dashboard/select-client/new[/provisioning]` and `/dashboard/settings`** (subagent 2 → noted for subagent 3, but not picked up) — UI scope; API is now safely 403'd, so it's a polish item.
- **In-memory rate-limit Map → Redis** (subagent 2) — fine on single Railway replica today; revisit when scaling.
- **Pace and Sales date inputs left as bare `<input type=date>`** (subagent 3) — they were never toggle-style pickers, so adding presets was scope creep.
- **"Roomy Recommended" branding string still in pricing/calendar code** (subagent 4 cross-cut) — out-of-scope rename; grep for `ROOMY_RECOMMENDED_LABEL` and the literal `"Roomy"`.
- **"Calendar Workspace" eyebrow duplicates H1** (subagent 4 cross-cut) — minor copy nit; out-of-scope for calendar agent.
- **`assertUniqueHostawayConnection` race with orphan-cleanup** (subagent 2) — not exploitable today; fold into a single transaction next time write paths in this area change.

---

## 3. What the owner needs to do manually

1. **Run the new Prisma migration on Railway** when ready to deploy:
   ```
   prisma migrate deploy
   ```
   The new file is `prisma/migrations/20260425010000_data_foundations_indices/migration.sql`. Adds 6 indices; no destructive changes.
2. **Confirm `API_ENCRYPTION_KEY` is set in Railway env vars** for the production app. `src/lib/crypto.ts` falls back to `NEXTAUTH_SECRET` then to a literal dev key if missing — that fallback must never be hit in prod.
3. **(Optional) Set `SYNC_DAYS_BACK` / `SYNC_DAYS_FORWARD` in Railway env** if you want a window other than the new default of 365/365. Previous defaults were 800/540; the new defaults will fetch ~half the previous data volume on first sync.
4. **Push to `origin/main`** — done by the orchestrator; verify the GitHub remote shows the merge commits.
5. **Pull on any other dev machines** before further work — the merge commits include changes to `app/components/revenue-dashboard.tsx`, `package.json` scripts, `.eslintrc.json`, and `prisma/schema.prisma`.
6. **Roll back any individual change** if needed: each shipped item has its own commit (see § 1). Use `git revert <sha>` to undo a single fix without touching the others.

---

## Cross-cutting findings (raw)

### From subagent 1 (data-foundations)

- `npm run lint` errors with "ESLint couldn't determine the plugin '@next/next' uniquely" because the worktree picks up both the worktree's local `node_modules/@next/eslint-plugin-next` AND the parent repo's `node_modules/@next/eslint-plugin-next`. This is a worktree+npm install artifact, not a code issue. Workaround: run `npm run lint` from the main repo path, OR remove the worktree's local node_modules and rely on the parent's. (Subagent 3 has since added `"root": true` to `.eslintrc.json` to mitigate.)

### From subagent 2 (security)

- Page-level admin gates on `/dashboard/select-client/new[/provisioning]` and `/dashboard/settings` would tighten UX (viewers can land on those pages today; API-side is now safely 403). Defer to UI subagent.
- `src/lib/login-rate-limit.ts` uses an in-memory `Map`. If/when the deployment scales beyond one Railway replica, swap to a Redis-backed counter. Acceptable today on single replica.
- `assertUniqueHostawayConnection` runs as a separate query before the orphan-cleanup pass in `app/api/tenants/clients/route.ts`. Two concurrent re-adds with the same key could theoretically both pass the cleanup gate. Not exploitable today (admin-only, single human user) but worth folding into one transaction when other write paths land.
- `src/lib/crypto.ts` falls back to `NEXTAUTH_SECRET` then to the literal `"insecure-dev-key-change-me"` if `API_ENCRYPTION_KEY` is unset. The fallback should never be reached in production — confirm `API_ENCRYPTION_KEY` is in the Railway env.

### From subagent 4 (calendar)

- Workspace header button labelled "Duplicate Tab ↗" — jargon. "Open in new tab" is clearer. (Workspace shell, not calendar grid.)
- Branding string "Roomy Recommended" appears throughout pricing/calendar code; product is Signals. Whoever owns the rename should grep for `ROOMY_RECOMMENDED_LABEL` and the literal "Roomy".
- Top of calendar workspace eyebrow reads "Calendar Workspace" — duplicates the H1 that says "Calendar". Could be removed for cleaner header (subagent 3 territory if it touches header copy).

---

## Merge log

| Order | Branch | Result |
| --- | --- | --- |
| 1 | `review/data-foundations` | Clean merge, typecheck PASS, 26/26 pricing tests PASS |
| 2 | `review/security` | Add/add conflict on `REVIEW-NOTES.md` resolved, typecheck PASS, audit script PASS |
| 3 | `review/ui-polish` | Clean merge, typecheck PASS, lint PASS |
| 4 | `review/calendar-pricing` | Add/add conflict on `REVIEW-NOTES.md` resolved, typecheck PASS |
| 5 | `review/signals-engine` | Auto-merge of `revenue-dashboard.tsx` succeeded (boundary partitioning held), typecheck PASS, 1 trivial lint error fixed in `d157aac` |
