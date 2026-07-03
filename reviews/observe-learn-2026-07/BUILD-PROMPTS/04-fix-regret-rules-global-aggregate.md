# Build prompt 04 – Fix regret semantics, artefact client rules, and the global aggregate

Copy-paste this whole file into a fresh Claude Code session at the `signals` repo root.

## Context (self-contained; assume no memory of prior sessions)

The observe-and-learn system (`src/lib/observe/**`) computes a daily per-tenant ClientProfile
including a "regret" learning and derived "divergence rules", and folds an anonymised view into
a single `GlobalMethodology` row. A July 2026 review (`reviews/observe-learn-2026-07/REVIEW.md`;
detail in `02-causal-stats.md`, `04-teachability.md`, `06-red-team.md`) found the regret
statistic is degenerate and has already minted false, live "rules" in prod:

1. **Percentages sum to 1 by construction.** `computeRegret`
   (`src/lib/observe/learnings.ts`, ~lines 94-157) hardcodes `none: 0` and
   `total = heldTooHigh + heldTooLow`, so the two shares are complementary and at least one
   rule threshold (0.15 / 0.25 in `src/lib/observe/client-profile.ts` ~lines 44-46) fires for
   almost any client. The unit-tested pure core `classifyRegret`
   (`src/lib/observe/learnings-core.ts` ~lines 83-107), which has a `none` class, is never
   called by the wrapper.
2. **held_too_high is a forecast, not a regret.** It counts every currently-available night in
   the next 7 days, before the outcome is known; a night that books tomorrow was still counted
   today. It also has no seasonal baseline, so a soft season reads as a client personality.
3. **held_too_low is a data-availability artefact.** It needs a per-listing min from
   `EngineSnapshot`; tenants without engine keys (Coorie Doon, Yo's House) structurally score
   0, pinning `heldTooHighPct` at exactly 1.0 and tautologically firing the
   `tolerates_empty_premium` rule.
4. **A dangerous live rule from a unit mismatch.** Little Feather's `below_min_short_window`
   rule (`heldTooLowPct` 0.849, `allowBelowMinInShortWindows: true` – a permission a future
   push stage would enforce) is built by comparing `NightFact.revenueAllocated` (net,
   discount-spread, includes £0-5 artefact rows and student long-lets) against the LATEST
   PriceLabs list min applied anachronistically to 90-day-old bookings. Also the rule's
   description says "short booking windows" while its trigger requires lead >= 1.5x median
   (long windows) – see `client-profile.ts` ~lines 84-90 vs `learnings-core.ts` ~lines 96-103.
5. **The global aggregate is invalid.** `accumulateLearning`
   (`src/lib/observe/observe-service.ts` ~line 75) folds every tenant into
   `GlobalMethodology` on EVERY daily run and settle via a running mean that increments
   `samples` per call (`src/lib/observe/global-methodology.ts` ~lines 114-196). Prod shows
   samples = 42 from at most 6 clients, including 14 permanent contributions from tenants that
   were deleted; the daily run also overwrites the weekly `feeDragPct` with null.

## Task

Work on a branch off `main`.

1. **Rewire `computeRegret` to settled nights only.** Regret is computed over past nights whose
   outcome is known (stay date passed), not forward availability:
   - `held_too_high`: nights that expired empty in the trailing window, in excess of a seasonal
     expectation. Use same-week-last-year empties from the existing `PaceSnapshot` data as the
     baseline where available (READ-ONLY: do not modify `src/lib/sync/pace.ts` or the pace
     queries in `src/lib/reports/service.ts`), falling back to a trailing same-DOW average.
   - `held_too_low`: keep the concept (sold cheap unusually early) but fix the comparison:
     gross booked nightly rate (accommodation fare / nights from `Reservation`, not
     `revenueAllocated`) against the min that was in force near the booking date (nearest
     `EngineSnapshot` by `capturedAt`, not the latest). Exclude nights with near-zero revenue
     (`revenueAllocated <= 5`) and owner blocks from all regret inputs.
   - Restore the `none` class by calling `classifyRegret` from the wrapper so the pcts no
     longer sum to 1, and return `null` for `held_too_low` (not 0) when no min data exists.
2. **Guard the rules.** In `buildClientProfileDoc` (`client-profile.ts`): a rule may not fire
   when its input is one-sided or absent (e.g. `heldTooLow` null); every rule carries its `n`
   and window; fix the `below_min_short_window` description to match its trigger (long lead),
   and drop `allowBelowMinInShortWindows: true` – a learned below-min PERMISSION must not
   exist until it is validated against settled outcomes; emit it as an observation, not a
   permission.
3. **Rebuild the global aggregate as recompute-from-latest.** Replace the incremental
   production fold: on each weekly settle, read the latest profile per current tenant and
   rebuild the `GlobalMethodology` doc from those contributions with equal weight per client
   and per-field sample counts (`samples` = number of contributing clients). Keep
   `anonymiseForGlobal` and its whitelist exactly as is (it is correct and tested). Keep
   `mergeGlobalMethodology` for its unit tests if convenient, but it stops being the
   production path. This also evicts deleted-tenant ghosts and fixes the feeDrag
   daily-null overwrite (recompute happens only on settle; daily runs stop folding).
4. **Surface, do not silently rewrite.** The readout should render each regret figure and rule
   with `{value, n, window}` and an explicit "insufficient data" state. The two currently-live
   artefact rules will disappear on the next profile recompute; confirm in the output that
   they do.

## Constraints (house rules, non-negotiable)

- Every Prisma query touching `Listing`, `Reservation`, `NightFact`, `PaceSnapshot`,
  `CalendarRate`, `DailyAgg`, or `SyncRun` MUST filter by `tenantId` (see
  `scripts/test-tenant-isolation.ts`).
- Cancelled-booking pace logic is OUT OF SCOPE: read `PaceSnapshot` only, change nothing in
  `src/lib/sync/pace.ts` or the pace queries in `src/lib/reports/service.ts`.
- Do not touch `src/lib/hostaway/**`. No AirROI.
- Owner preference: one fix per commit where practical (regret rewrite, rule guards, global
  recompute are three natural commits).

## Green gate (all must pass)

```
npm run typecheck
npm run lint -- --max-warnings=0
npm run test:tenant-isolation
```

Plus unit tests covering: pcts no longer sum to 1 (a `none` case exists); `held_too_low`
returns null without min data and the dependent rule does not fire; zero-revenue nights are
excluded; the anachronistic-min case (min raised after booking) no longer flags; global
recompute weights clients equally and drops a deleted tenant on the next settle. Update any
existing tests that asserted the old degenerate behaviour.

## Finish

Report what changed, the before/after profile values for the four live tenants (from a local
run if prod is not reachable), the test evidence, and the commit list. Then ask Mark
explicitly: **deploy to the live webapp or keep local?** Note for Mark: until deployed (web +
`signals-worker` restart on Railway), the day-30 readout on 2026-07-28 will email the current
false rules. If this is an autonomous or overnight run and Mark cannot answer, do NOT
auto-deploy: leave the change local with a "TO DEPLOY" block at the top of your summary. If
Mark says deploy, follow the standing deploy & self-heal protocol in CLAUDE.md end to end.
