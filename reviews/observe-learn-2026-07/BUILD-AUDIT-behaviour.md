# Build audit — behaviour (independent adversarial re-run)

Auditor: behavioural auditor, no context from the build agents. Date: 2026-07-03 (late evening).
Scope: everything after commit `9529135` on `feat/observe-learn-fixes-2026-07` (28 commits).
Method: I did not take any test's word for it. I re-ran the green gate myself, then exercised
the new code paths against the local dev DB with seeded fixtures (two throwaway tenants,
~15k seeded night facts, real Fleadh trial events), exercised the scheduler against the real
local Redis queue, and re-ran the prod mining analysis read-only to reproduce the committed
report. All seeded data was deleted afterwards (0 audit rows remain); prod was SELECT-only
throughout and I verified prod received no writes, no migrations and no shadow rows.

## Verdict: SHIP-SAFE (no blocking findings)

The five prompts' behaviours hold up under live exercise, the constraints were respected
(no `src/lib/sync/pace.ts`, no `src/lib/reports/service.ts` pace queries, no
`src/lib/hostaway/**`, no AirROI, nothing routed through `settings.localEvents` writes,
every new query on the sacred tables tenant-filtered), nothing was deployed, and the
2026-07-28 graduation output is materially safer than the pre-branch state. Non-blocking
findings are listed at the end; F1 (ghost scorer counts owner blocks as bookings) is the
one I would fix before reading the calibration numbers as graduation evidence.

## Green gate, re-run independently

- `npm run typecheck` — exit 0.
- `npm run lint -- --max-warnings=0` — exit 0.
- `npm run test:tenant-isolation` — "Tenant isolation check passed."
- `npm run test:observe` — 163/163 pass (includes the new learnings, suggestion-scoring
  and drop-outcomes suites, wired into `package.json`).
- `npm run test:observe-schedule` — 6/6 pass.

## 1. Safety gates (prompt 01) — exercised live, 49/49 checks pass

Seeded a tenant named `Little Feather AUDIT …` (slug matches the trial-events source, so it
receives the real Fleadh Cheoil 2026 events: 06 Aug +15%, 07 Aug +50%, 08 Aug +60%) with a
single-unit listing (engine-snapshot min 95), a floor-less listing, and a 40-unit multi-unit
listing, plus 365 days of occupied history (lead 60d) so the booking-curve trigger fires.
Ran the real `generateSuggestionsForClient` (`src/lib/observe/suggestions.ts:623`):

- **Event shield**: all three positively event-adjusted Fleadh nights blocked with reason
  `event`; none appears in the generated rows. Resolution goes through the shared
  `eventAdjustmentForDate` (`suggestions.ts:13,697`) fed by the trial-events file — read-only,
  nothing written to `settings.localEvents`.
- **Min floor**: a 100-rate night clamped to exactly the engine min 95 (not the raw 75),
  `detail.floor = 95` persisted; a 90-rate night with floor 95 suppressed (`min_floor`);
  the floor-less listing emitted unclamped with `detail.floorUnknown = true`.
- **Cumulative cap**: two prior rejected drops totalling 26.7% within 14 days on one night
  block a fresh drop (`cumulative_cap`). See F2 on gate ordering.
- **Already actioned**: a night covered by an `approved` row is blocked (`already_actioned`);
  when I seeded `applied` rows instead, the night was also blocked (by the stronger
  already-actioned gate) — over-blocking, the safe direction; a fresh cut-on-cut is
  impossible either way.
- **Multi-unit**: 1 of 40 units sold → the night is NOT treated as booked; it is suggested
  with `revenueAtRisk = 80 × 39 = 3120` (`suggestions.ts:686-701`).
- **Blocked counters reach the readout**: `{event: 3, min_floor: 1, cumulative_cap: 1,
  already_actioned: 1}` persisted on `observation_windows.last_suggestion_run` and rendered
  in the HTML as "Blocked by safety gates: 6 (…)" (`readout.ts:474-484`).
- **Readable readout**: listing names joined into the suggestions table (`readout.ts:318-329`).

## 2. Shadow + supersession + ghost scorer (prompt 03) — exercised live

- **Shadow rows invisible**: `status: "shadow"` generation for the ungraduated window wrote
  3 rows; `buildReadout` pending list showed 0 (pending-only read, `readout.ts:246`), and the
  day-30 email path (`day30-runner.ts:55-57`) renders from the same builder, so shadow rows
  cannot reach the email either.
- **Supersession keeps history**: regenerating turned the 3 prior shadow rows into
  `superseded` and inserted 3 fresh ones — total row count grew from N to N+3, nothing
  deleted (`applySuggestionRegeneration`, `suggestions.ts:360-391`). Human-actioned rows
  (approved/rejected/applied) untouched.
- **Ghost scorer three-way classification** on seeded fixtures via the real
  `scoreSettledSuggestions` (`suggestion-scoring.ts:336`): a booked night with a live
  reservation → `booked_no_action` with `realisedVsProposed = 120/90`,
  `daysToBookingAfterSuggestion = 5` and `rateMovedAfter = true` (a −5% RateChange landed
  between suggestion and booking); an empty settled night → `expired_empty`; a night whose
  covering reservation was created after the suggestion and later cancelled →
  `cancelled_after_booking`. Late-cancellation re-check verified: setting `cancelledAt` on
  the booked reservation and re-running flipped the outcome and nulled the realised fields
  (`rechecked = 1`).
- **Calibration + method agreement** then appeared in the readout (scored 3; method
  agreement dropped∧flagged 1 / flagged-only 2, matching the seeded RateChange exactly).

## 3. Regret rewrite (prompt 04) — exercised live

- **Pcts no longer sum to 1**: seeded tenant A produced `{heldTooLow: 0, heldTooHigh: 0,
  none: 3687, total: 3687}` — the `none` class is real and dominant
  (`computeSettledRegret`, `learnings-core.ts:179`).
- **Zero-revenue exclusion**: a £0 occupied night was excluded; `total` equalled
  occupied-in-window − 1 exactly.
- **Coorie Doon mirror** (tenant with no engine snapshots, no daily aggs, no pace):
  `heldTooLow` came back `null` (not 0), `heldTooLowPct` null in the profile, the
  `below_min_*` rule did not fire, and — despite `heldTooHighPct = 0.6`, which would have
  fired the old tautology — `tolerates_empty_premium` did NOT fire because
  `baselineSource === "none"` guards it (`client-profile.ts:126-144`). No `allowBelowMin`
  string exists anywhere in the produced profile; the below-min rule is emitted as an
  observation only (`client-profile.ts:102-123`).
- **Live artefact rules will disappear**: prod today (SELECT-only) shows exactly the
  review's degenerate state — Coorie Doon and Yo's House pinned at `heldTooHighPct = 1`
  with `tolerates_empty_premium`, Little Feather at `heldTooLowPct = 0.849` with
  `below_min_short_window`, Stay Belfast carrying both. The fixture run proves the new code
  cannot reproduce any of these; they evaporate on the first post-deploy daily recompute.
- **Global recompute**: with profiles written for both seeded tenants,
  `recomputeGlobalMethodology` returned `samples` = number of distinct tenants with a
  profile (equal weight per client, not per fold); deleting one tenant and recomputing
  dropped `samples` by exactly 1 (deleted-tenant ghosts evicted). Daily runs no longer fold
  (`observe-service.ts:163-170`, `recomputeGlobal: false`), so the settle-only feeDrag can
  no longer be daily-nulled.
- **Readout regret block** renders value + n + window and an explicit "insufficient data —
  unmeasurable, not zero" state for a null heldTooLow (`readout.ts:404-425`).

## 4. Lifecycle scheduling (prompt 02) — exercised against the real local Redis, 19/19

- Simulated the 2026-07-03 failure: registered a repeatable for a dead tenant id, ran the
  real `reconcileObserveSchedules` (`observe-worker.ts:130`) — the dead schedule was pruned
  with a clear warning log, and the end state was exactly 2 repeatables per live tenant
  plus the single reconcile job (13 total for 6 tenants), all `Europe/London`.
- Created a tenant after the fact and re-ran reconcile: it was enrolled (daily + settle,
  `added: 2`) without any worker restart — the boot-only-registration failure class is
  closed by the 05:15 daily reconcile job (`config.ts:42`, fires before the 05:30 runs).
- `removeObserveSchedulesForTenant` removed exactly that tenant's two schedules. The
  in-job dead-tenant self-heal (`observe-worker.ts:74-85`: findUnique miss → prune own
  schedules → return skipped, never throw) was verified by code reading; the reconcile
  prune path was verified live.
- Estate health + starvation: `buildReadout` listed a tenant with no observation window
  with the explicit warning "no observation window — this tenant has never been observed",
  and the starvation matrix rendered `never` for a learning that had never produced a value
  next to `0d` for one computed the same run. The ledger wrote exactly 7 rows per run, with
  a `nullReason` of "daily_aggs empty…" for pricing power on the starved tenant.
- Left the local queue reconciled to the 6-tenant state (the same state the daily
  reconcile job produces).

## 5. Mining report (prompt 05) — pure checks + full prod reproduction

- Pure behaviour (8/8): a 30-date contiguous sweep collapses to exactly 1 episode spanning
  the full range; a 1-day gap splits it into 2; sub-3% wiggle and positive changes are
  filtered (only the −3% row survives); stay-before-detection rows discarded; drop bands
  correct at the boundaries; stratified sampling spans the full history (never
  newest-first).
- **Prod numbers verified the hard way**: I re-ran `scripts/mine-drop-outcomes.ts --prod`
  (read-only) into the scratchpad ~15 minutes after the committed run. The output is
  byte-identical to the committed `observe-reports/drop-outcomes-prod-2026-07-03.md`
  except the generation timestamp — every episode count, cell and n reproduces. Independent
  SQL spot-check: listings-with-qualifying-drops per tenant (44 Coorie, 33 LF, 15 SB,
  32 Yo's, 0 for both recreated tenants) matches the report exactly.
- Caveats are present and correct (observational, selection-on-weakness biased AGAINST
  drops, matching limits, denominator mismatch, history depth); every cell carries its `n`
  and thin cells are marked "insufficient matched controls".
- The script performs `findMany` only; prod's `_prisma_migrations` shows nothing applied
  after `20260626120000_add_observe_learn`, prod has neither the ledger table nor the
  `last_suggestion_run` column, and prod `suggestions` has 0 shadow/superseded rows —
  nothing from tonight touched prod.

## 6. End state

- Working tree clean apart from pre-existing untracked files (`.claude/`,
  `RELIABILITY-FINDINGS.md`, `trial-reports/`) and the parallel auditor's
  `BUILD-AUDIT-code.md`.
- 28 commits after `9529135`, one fix per commit, coherent story (7 gate commits for
  prompt 01, 3+doc for 02, 5+doc for 03, 4+doc for 04, 3+doc+reports for 05).
- All five build-run summaries carry an explicit TO DEPLOY (or TO DEPLOY / TO REVIEW)
  block; nothing was auto-deployed, matching the overnight rule.
- Diff scope check: no changes under `src/lib/sync/`, `src/lib/hostaway/`,
  `src/lib/reports/`; the only non-observe source touches are `queues.ts` (reconcile
  schedule), `trial-tenants.ts` (export-only, one keyword) and `package.json` (test list).
- Graduation-safety question: on 2026-07-28 the generator now clamps to a resolved floor,
  refuses drops on event-lifted nights, cannot compound on actioned nights, understands
  multi-units, shows blocked counts as a trust line, names listings, and arrives with a
  calibration section built from 25 days of shadow history (if deployed promptly) instead
  of a leap of faith. Materially safer than the pre-branch state.

## Non-blocking findings (fix-worthy, none ship-blocking)

- **F1 — ghost scorer counts owner blocks and artefact rows as bookings.** The scorer's
  fact query (`suggestion-scoring.ts:380-385`) filters only `isOccupied: true`; prod has
  8,234 `ownerstay` facts (all occupied, 7,120 with revenue ≤ £5) plus ~5,400 more ≤£5
  occupied rows on real statuses. A shadow-flagged night later owner-blocked scores
  `booked_no_action` with realisedRate ≈ 0, inflating the calibration's "booked anyway"
  share while dragging `avgRealisedVsProposed` down. Prompts 04 and 05 both exclude
  `ownerstay` + ≤£5 rows (`learnings.ts:238`, `scripts/mine-drop-outcomes.ts:186`); the
  prompt-03 scorer should adopt the same convention before the calibration report is read
  as graduation evidence.
- **F2 — the cumulative cap is in practice reachable only via rejected rows.** For any
  forward night, an approved/applied suggestion trips `already_actioned` first
  (`suggestions.ts:555-565` gathers them; gate order `suggestions.ts:161-200`), so
  `cumulative_cap` today only fires when ≥25% of drops were REJECTED within 14 days.
  That matches the prompt's letter ("prior non-pending suggestions") and over-blocks
  (safe), but the cap will not do its real anti-ratchet job until applied `RateChange`
  drops are wired in ("once available" in the prompt).
- **F3 — the thin-data early return skips supersession.** When lead-time n < 20
  (`suggestions.ts:643-646`) the run returns before superseding prior rows or updating
  `lastSuggestionRun`, so if a tenant's lead-time data ever degrades, stale pending rows
  and a stale blocked line linger rather than being refreshed or cleared.
- **F4 — the readout estate section is cross-tenant by design** (`readout.ts:219-222`,
  tenant list, all windows, all ledger rows). Fine while the route is gated by the single
  internal `OBSERVE_READOUT_KEY` (`app/api/observe/readout/route.ts:28-34`); if a readout
  key is ever issued per client this leaks tenant names. The tables involved are not in
  the CLAUDE.md sacred list and the code documents the intent, so this is an observation.
- **F5 — the event shield covers positively adjusted nights only.** Fleadh week is
  2026-08-02..09 but the trial source lifts only 06-08 Aug; Sun-09 (deliberately 0%) can
  still receive a drop suggestion. This is what the prompt specified ("positive event
  adjustment"), just worth knowing when eyeballing the first pending list.
- **F6 — DOW occupancy is tenant-wide and full-window.** `computeDowOccupancy`
  (`suggestions.ts:501-538`) pools all listings and counts 365 denominators for listings
  added mid-year — documented in code, errs toward fewer suggestions (safe).
- **F7 — calibration level mismatch.** `realisedVsProposed` divides net
  `revenueAllocated` by the advertised proposed price; the mining report documents this
  denominator mismatch, the calibration section does not — its "% of the price the system
  proposed" reads slightly low. Wording nit.
- **F8 — in-job dead-tenant self-heal has no direct unit test.** `processJob`'s prune-and-
  skip path (`observe-worker.ts:74-85`) is straightforward and its helper is tested, but
  only the reconcile prune is covered by tests; a thin test around `processJob` would
  close that.
