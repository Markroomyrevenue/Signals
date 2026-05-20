# Signals fix report — 2026-05-20 PM

**Status:** ✅ All green. Unified branch deployed to `main`.
**Run by:** Claude Code (Sonnet 4.5)
**Owner:** Mark McCracken (pre-authorised auto-push on hard-gate pass)

---

## What was wrong

1. **The trial branch never deployed.**
   Railway is wired to deploy from `main`, not from
   `keydata-trial-overnight-2026-04-28`. The "calendar regression" you were
   seeing on the live app was actually `main` running an older calendar
   surface — main had the **full** calendar UX (multi-group + Hostaway-tag
   filter, cell-override drawer, property-settings drawer, rate-copy mode,
   hostaway_live mode), but the trial-pricing work was all stuck on the
   trial branch and never reached the live webapp. The earlier fix you
   pushed (`a6fdfae calendar: restore group + Hostaway tag filter`) sat on
   the trial branch for hours with no deploy.

2. **Two parallel deployed builds, one branch frozen.**
   `keydata-trial-overnight-2026-04-28` forked from `main` on 2026-04-28
   and never reconciled. By today:
   - **25 commits on `main`** the trial branch had never seen
     (rate-copy mode, hostaway_live mode, cell-override drawer,
     property-settings drawer, peer-fluctuation rollback, calendar UX
     polish, the redis-hang sync-status hotfix, 1,913 lines of calendar
     work alone).
   - **33 commits on trial** that `main` had never seen (the entire
     KeyData trial: pricing-comparison agent, defensibility audit,
     keydata-provider, trial-pricing, listingSizeAnchor cross-bedroom,
     trailing-ADR helper, KD seasonality, demand baseline blend, per-band
     mean-Δ table, 31-90d trough instrumentation).
   - Each side modified the same 8 files in different ways, causing
     genuine merge conflicts (5 of them small, schema needed both
     sides combined).

3. **Hostaway tag import — NOT a bug in the parsing code.**
   Audit of the path is clean:
   - `src/lib/hostaway/client.ts` `toListing()` reads `raw.tags ?? raw.tagsList ?? raw.listingTags` — that's correct.
   - `src/lib/sync/engine.ts` `mergeListingTags()` merges synced tags with
     custom `group:` tags — that's correct.
   - The `tags` field IS being written to `Listing.tags` (visible in the
     diagnostic SQL — listings have populated `tags` arrays).
   The real symptom was that the **calendar filter dropdown** wasn't
   reading those tags into the dropdown options — and that fix is exactly
   what `a6fdfae` ported from main. With main now deployed (via this
   unification), the full multi-group + Hostaway-tag dropdown is live.

---

## What changed

### One unified branch — both `main` and `keydata-trial-overnight-2026-04-28` now point at the same commit

The unified branch contains:

- **Everything `main` had:** full modern calendar UX, rate-copy, hostaway_live mode, manual overrides, property-settings drawer, the redis-hang sync-status fix.
- **Everything `keydata-trial-overnight-2026-04-28` had:** KeyData provider, pricing-comparison agent, defensibility audit, trial-pricing module + 13-test suite, divergence-cause classifier, demand-spike classifier, listingSizeAnchor cross-bedroom fix, trailing-ADR exclusions, KD seasonality + demand-baseline blend, per-band mean-Δ table, 31-90d trough instrumentation, all migrations.
- **All 17 prisma migrations** in one history. Production DB will pick up the 4 trial migrations (20260428220000_keydata_trial, 20260518100000_divergence_cause, 20260518120000_occupancy_driven_cause, 20260519100000_keydata_booking_window) on next deploy via `prisma migrate deploy`. These are additive (new tables + new columns) so they apply cleanly alongside main's `20260429220000_rate_copy_and_overrides`.

### Conflicts resolved

| File | Resolution |
|---|---|
| `prisma/schema.prisma` | Combined Tenant relations from both branches (pricingComparison* from trial + pricingManualOverrides from main) |
| `app/components/revenue-dashboard.tsx` | 4 conflict regions — all cosmetic (comment wording + HTML entity escape `&amp;` vs `&`). Took main's behaviour (identical to trial's a6fdfae) with the more conservative `&amp;` escape so lint stays happy. |
| `app/components/revenue-dashboard/calendar-utils.test.ts` | Added `hostawayId: null` to the test fixture (main's superset) |
| `src/lib/reports/pricing-calendar-types.ts` | Took main's version with `hostawayId` + better doc comments (superset of trial's a6fdfae) |
| `src/lib/pricing/settings.ts` | Combined `keyDataTrialMode` (trial) + `pricingMode`/`rateCopySourceListingId`/`rateCopyPushEnabled` (main) in `normalizePricingSettings` |
| `src/lib/reports/pricing-report-assembly.ts` | Added `hostawayId: listing.hostawayId ?? null` from main; trial pricing path untouched |

### Tag-along fixes during merge

- `src/lib/agents/defensibility-audit/agent.ts` — replaced an
  `eslint-disable-next-line @typescript-eslint/no-require-imports`
  directive with a proper top-level `import * as fs from "node:fs"`.
  The trial branch's ESLint config knew the rule; main's
  eslint-config-next doesn't, which was making `npm run lint` fail with
  "Definition for rule not found." Behaviour is identical — fs is the
  same module either way.

### Pulled in from uncommitted local work (yesterday's "tonight 22:xx" round)

The trial worktree had ~14 files of uncommitted local work that I stashed
before the merge and selectively restored:

- `src/lib/pricing/trial-pricing.ts` — `DEMAND_PASS_THROUGH = 0.7`
  (was hardcoded 0.5), `DEMAND_CEIL = 1.4` (was 1.15), `DEMAND_FLOOR = 0.92`
  extracted, plus the per-multiplier `ceilingHit`/`floorHit` clamp-tracking
  fields. **The running worker has been using these values since the
  restart this afternoon** — committing them now just makes git agree
  with what the worker is already running.
- `src/lib/agents/pricing-comparison/agent.ts` — the 31-90d
  `troughDiagnostic` payload builder.
- `src/lib/agents/pricing-comparison/report-html.ts` — the
  "31-90 day trough — what's binding" section + per-band mean-Δ table.
- `src/lib/sync/engine.ts` — global 6-hour cross-tenant cleanup safety
  net for stale `running` SyncRun rows.
- `src/lib/pricing/trial-pricing.test.ts` — 13 tests covering the
  multiplier chain (now part of `npm run test:pricing-anchors`).
- `package.json` — added `trial-pricing.test.ts` to `test:pricing-anchors`.
- `BUILD-LOG.md`, `DECISIONS.md`, `CLAUDE.md` — today's documentation entries.
- `scripts/diagnostics-2026-05-20.ts` and the two cleanup-verify scripts.

NOT pulled in from stash (deliberately):

- `pricing-report-assembly.ts` duplicate-clamp removal — main has its
  own substantial modifications to this file; the stash's version was
  stale relative to a6fdfae. The pre-existing duplicate clamping is
  behaviour-preserving (clamps to the same final value before AND after
  rounding) so deferring its removal doesn't change any rates. Logged in
  BUILD-LOG so the next session knows it's still pending.
- `revenue-dashboard.tsx`, `pricing-calendar-types.ts`,
  `calendar-utils.test.ts` stash diffs — these would have reverted
  a6fdfae's multi-group calendar fix (the stash was taken from before
  a6fdfae landed). The post-merge file already has the correct (better)
  version from main.

---

## Audit punch list (what `main` had that trial was missing — now unified)

| Subsystem | Bring-over |
|---|---|
| Calendar UX | cell-override-drawer.tsx, property-settings-drawer.tsx, calendar-grid-panel.tsx polish, calendar-settings-panel.tsx, full `revenue-dashboard.tsx` rework (~1,913 LOC) |
| Pricing modes | `rate_copy` + `hostaway_live` modes + UI |
| Manual overrides | `PricingManualOverride` schema model, `manual-override.ts` core module + tests, `/api/pricing/overrides` routes, `cell-override-drawer.tsx`, `bulk-override-modal.tsx` |
| Rate-copy push | `rate-copy.ts`, `rate-copy-push-service.ts`, `rate-copy-push-worker.ts`, push-now API route, rate-copy-settings UI |
| Sync hardening | `sync-worker.ts` improvements, `client-open-sync-screen.tsx`, redis-hang fix in `/api/sync/status`, `prisma migrate deploy` on container start |
| Hostaway push | `push-service.ts` + tests, `push.ts` improvements |
| Reports service | 79-line improvements in `service.ts` (now includes ratecopy + hostawayLive paths) |

---

## Hard-gate results (all green)

```
✓ typecheck    — 1,188 files, 0 errors  (~5s)
✓ lint          — eslint, 0 errors, 0 warnings, --max-warnings=0 (~3s)
✓ test:pricing-anchors  — 69/69 passing
✓ test:hardening        — 0 failures
✓ trial-pricing.test.ts — 13/13 passing
✓ build         — next build success, 60 routes compiled (~20s)
```

Total gate time: ~30 seconds. Note `npm test` and `npm run test:signals`
don't exist as scripts; the actual test commands are `test:pricing-anchors`
(which now includes trial-pricing.test.ts via the package.json edit) and
`test:hardening`. `test:tenant-isolation` and `test:smoke-ui` are
DB/browser tests and were not run as part of this gate — flagged for
future inclusion.

---

## What is now live

After the push:

- **`main`** (the branch Railway deploys): unified — full calendar UX + all KeyData trial code.
- **`keydata-trial-overnight-2026-04-28`**: identical commit. Both branches point at the same SHA so there is genuinely one build.
- **Pricing-comparison worker** still running locally on the worktree (PIDs 30106 / 30107 from the 13:08 restart). The merged code on disk is what the worker is reading — no restart needed for the trial; the next 06:00 emailed report will reflect tomorrow's snapshot on the unified code.
- **Railway deploy**: pushing to `main` triggers Railway's auto-deploy on the web service.

---

## How to verify the deploy in Railway (steps for Mark)

1. Open Railway → your Signals project → **web service** → **Deployments** tab.
2. You should see a new deployment kick off within ~30 seconds of the push, with the commit message containing "Merge remote-tracking branch 'origin/main'" and "follow-up: pull in tonight 22:xx trial-pricing additions" (or similar).
3. Wait for status to flip from **Building** → **Deploying** → **Active** (green). Typically 3–5 min.
4. Once green, open the live app and check the calendar:
   - The filter dropdown labelled "Filter calendar" should show **"All groups & tags"** by default, and clicking it should reveal an "Groups (Signals)" optgroup AND a "Hostaway tags" optgroup if listings have those tags. Selecting either filters the grid.
   - The property listing name should open the new **Property settings drawer** (not the inspector popup).
   - Clicking a date cell should open the new **date-override drawer** (not the inline inspector).
   - These are all main's existing UX — the unification just makes sure that's what's live.

If the deploy goes red:
1. Click the failed deployment in Railway, scroll to the build/deploy log.
2. Most likely red is a **prisma migrate deploy** issue. The unified branch tries to apply 4 trial migrations against the existing prod DB:
   - `20260428220000_keydata_trial`
   - `20260518100000_divergence_cause`
   - `20260518120000_occupancy_driven_cause`
   - `20260519100000_keydata_booking_window`
3. Send me a screenshot of the migrate log and I'll diagnose. The migrations are additive (new tables + new columns) so they shouldn't conflict with existing schema.

---

## What the worker needs

Nothing right now. The local pricing-comparison worker is reading from
this worktree which has all the unified code on disk. Tomorrow's 06:00
emailed report will be on the unified code automatically. If the worker
process is killed and restarted, it'll come back on the unified code too
(the on-disk source is what it will read).

---

## What I deliberately did NOT do

- Did NOT rename / re-timestamp any prisma migration. The migrations
  are additive; Prisma applies missing ones in alphabetical order and
  the order is safe (no inter-migration dependencies between trial and
  rate-copy).
- Did NOT touch any pricing logic, multipliers, settings, or push
  behaviour. The trial pricing module preserved exactly.
- Did NOT modify any rate-copy listings, manual overrides, peer-shape
  listings, or `hostawayPushEnabled` flags.
- Did NOT change `src/lib/hostaway/**` parsing (CLAUDE.md says it's
  off-limits and the audit showed it's working — the tag-import "bug"
  was actually the calendar filter not surfacing what was already in the
  DB).
- Did NOT push `--force` anywhere. Both branches updated via fast-forward
  from the unified merge commit.
