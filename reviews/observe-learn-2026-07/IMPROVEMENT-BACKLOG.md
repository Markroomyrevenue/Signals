# Observe-and-learn improvement backlog

Synthesiser ruling on every improvement proposed by Agents 1–6, 2026-07-03. Accepted items
below with WHAT / WHY / HOW / EFFORT (S/M/L) / SEQUENCE; explicit rejections at the bottom.
"Measure first" items produce evidence before behaviour changes; Agent 2's measurement design
(02-causal-stats.md §7) gates the items marked **[gated by M3]**. Build prompts exist in
`BUILD-PROMPTS/` for the top five (marked **[BP-nn]**).

Sequence key: **NOW** = before 2026-07-28 graduation. **NEXT** = weeks 2–6. **LATER** = after
the outcome loop produces data.

---

## Part A – Measure first

### M1. Mine the historical drop record for dose-response **[BP-05]**
- **WHAT:** One retrospective job over the 554,431 `rate_changes` + 1,922
  `booking_rate_contexts` + `night_facts`: extract drop episodes (listing x scan x contiguous
  date span, minimum meaningful move ~3%), and estimate fill-within-14d and realised rate by
  drop-size band x lead bucket x DOW, against matched un-dropped nights of the same listing
  (same DOW, same lead bucket, +/-21 days – Agent 2's within-listing event-study).
- **WHY:** Goal 1. It is the fastest route to evidence about the method Mark already runs –
  answerable in weeks from data already collected, before any prospective loop matures.
  Without it, drop sizing stays a hand formula for at least a season.
- **HOW:** New script/job reading `rate_changes`, `rate_states`, `night_facts`,
  `reservations`, `booking_rate_contexts` (all tenant-filtered); writes a `DropOutcomeStat`
  bootstrap table and a readout section. Stratified sampling across listings, not the
  take-50-newest pattern of `peer-ladder.ts:164-168`.
- **EFFORT:** M. **SEQUENCE:** NEXT (start now; nothing gates it).

### M2. Shadow suggestions + ghost scoring during the silent window **[BP-03]**
- **WHAT:** Generate suggestions internally every day regardless of graduation (flagged
  `shadow`), keep an append-only record of every generated suggestion, and a weekly retro-scorer
  that marks what happened with no action taken (booked anyway? at what rate? days later?).
  Include Agent 4's shadow-Mark agreement score: nights where Mark dropped and the system
  would/would not have, with size deltas.
- **WHY:** Goals 1, 2 and 3 at once. Turns the 30-day wait into a calibration report ("had we
  acted, X of Y would have filled"), gives free counterfactuals while nothing is applied, and
  is the trust gate for graduation. Currently the silent window produces nothing testable and
  the evidence is deleted daily (`suggestions.ts:181`).
- **HOW:** Stop the delete-and-regenerate (supersede instead), add `SuggestionEvent`
  (append-only) or a `shadow`/`superseded` status, score on the existing weekly settle
  (`observe-service.ts:193-220`) from `NightFact` + `Reservation` + `RateChange`.
- **EFFORT:** M. **SEQUENCE:** NOW (every day it is not running is backtest data lost).

### M3. The measurement design: randomised holdout + calibration scoring
- **WHAT:** Adopt Agent 2's minimum viable design before Phase 5 applies anything: at
  generation, randomly assign at-risk nights `apply`/`hold` at the listing-week block level,
  stratified by lead bucket x DOW x tenant, recorded on `Suggestion` and `PushLog`; report
  per-cell revenue deltas with 95% intervals; Brier/reliability scoring of every emitted
  confidence in the readout.
- **WHY:** Goal 1's actual deliverable: "drops of size X at lead Y earn Z% more revenue, with
  honest uncertainty." Powered in ~4–8 weeks at this portfolio size (Agent 2 §7). Without it,
  applied drops will be validated by regression to the mean (every dropped night was already
  weak).
- **HOW:** Assignment field on `Suggestion`, holdout logic in the apply path when Phase 5 is
  built, scorer joins the settled ledger (B4). Design doc first; it gates B5 and B6.
- **EFFORT:** M (design S, implementation with Phase 5). **SEQUENCE:** NEXT (design), LATER
  (live randomisation, with Phase 5).

---

## Part B – Build

### B1. Suggestion safety gates **[BP-01]**
- **WHAT:** Machine-checkable assertions before any suggestion is written: clamp
  `proposedValue` to the listing minimum; event shield via `eventAdjustmentForDate`; skip
  nights already carrying an approved/applied suggestion; per-night cumulative-drop cap across
  runs (no compounding ratchet); unit-count awareness for multi-units; freshness check on
  `CalendarRate`; human-readable listing names in the readout; a "blocked" counter reported in
  the readout as a trust metric.
- **WHY:** Goal 3's survival. Graduation for all four tenants is 2026-07-28; Fleadh week
  (+15..60% in `trial-events.ts`) starts 2026-08-02; the current generator would lead its
  first-ever email with ~20% cuts on +50% nights (Agent 6, narrative 6). One visibly stupid
  suggestion in week one costs Mark's confidence in all of them.
- **HOW:** `src/lib/observe/suggestions.ts` (judge + generate), reading
  `eventAdjustmentForDate` from `src/lib/pricing/events.ts`, engine-snapshot min (fallback
  `pricing_settings`/`rate_states` floor), `Listing.unitCount`. The blocked counter also
  teaches the "when NOT to drop" half of the method (goal 2).
- **EFFORT:** S/M. **SEQUENCE:** NOW – hard deadline 2026-07-28.

### B2. Tenant-lifecycle-proof scheduling + starvation visibility **[BP-02]**
- **WHAT:** Enumerate tenants at run time (dispatcher job or per-run reconcile) instead of
  boot-only registration; alert when a scheduled tenantId no longer resolves or a tenant has
  not completed a run in 48h; per-run learning ledger with null-reasons rendered as a
  starvation matrix in the readout (days-since-non-null per learning per client).
- **WHY:** Operational integrity for all goals. Two of six tenants are unobserved until a
  worker restart, stale dead-tenant jobs will throw daily from tomorrow, and `daily_aggs` = 0
  (killing learning #4 for everyone) survived six green runs unnoticed because a null learning
  and a computed learning look identical.
- **HOW:** `src/workers/observe-worker.ts:67-99` (registration), `observe-service.ts` (ledger
  writes), `readout.ts` (matrix + per-tenant last-success). New small append-only table.
- **EFFORT:** S/M. **SEQUENCE:** NOW (the stale jobs are already failing).

### B3. Fix regret and the client rules; fix the global aggregate **[BP-04]**
- **WHAT:** (a) Regret computed only on settled nights, restoring the `none` class (the
  unit-tested `classifyRegret` core is never called by the wrapper); suppress `held_too_low`
  when min data is absent instead of returning 0; exclude zero/near-zero `revenueAllocated`
  nights and owner blocks; compare like with like (booked gross nightly vs min, not net
  allocated); benchmark `held_too_high` against a seasonal expectation (read `PaceSnapshot`
  YoY – read-only, no refactor); fix the `below_min_short_window` description/trigger
  contradiction. (b) Suppress or flag the two artefact rules in existing profiles and the
  readout until recomputed. (c) Rebuild `GlobalMethodology` each settle from the latest
  profile per tenant (equal weight per client, per-field sample counts, segment keys), instead
  of the running mean – this also evicts the 14 deleted-tenant ghosts and fixes the
  daily-nulls-feeDrag overwrite.
- **WHY:** Goals 1 and 2. These artefacts are the falsehoods a trainee would be taught, and
  LF's below-min permission is the single most dangerous learned object in the system (Phase 5
  is designed to enforce it).
- **HOW:** `learnings.ts:94-157` (computeRegret), `learnings-core.ts:83-107` (wire the core),
  `client-profile.ts:44-46,83-124` (rules), `global-methodology.ts:114-196` +
  `observe-service.ts:75` (recompute-on-settle), `readout.ts` (flagging).
- **EFFORT:** M. **SEQUENCE:** NOW/NEXT (before the day-30 readout emails these rules to Mark).

### B4. The closed loop: action path, settled-night ledger, outcome re-scorer
- **WHAT:** Agent 3's §5.2–5.4 design, adopted as specified: a key-gated POST (or minimal UI)
  writing `pending → approved/rejected → applied` with actionedBy/At and edited values;
  rejection reasons as one-tap categories; a `SuggestionOutcome` table (tenant-scoped,
  `@@index([tenantId, ...])`) settled after stay date with cancellation re-links; a weekly
  re-scorer on the existing settle that finally computes `pickupVelocity` and populates
  `moved_pickup`/`control_pickup`; a `DropOutcomeStat` win-rate table replacing the hand
  constants with shrunken empirical confidence (hand formula as the prior, `n` displayed
  everywhere).
- **WHY:** Goal 3 has no mechanism without it, and goal 2 gets its worked examples ("we
  dropped £120→£102 at 14 days, it booked in 36 hours") from the same rows. This is H1's fix.
- **HOW:** New Prisma models `SuggestionOutcome`, `DropOutcomeStat`; POST route beside
  `app/api/observe/suggestions/`; re-scorer in `observe-service.ts` settle path; `PushLog`
  writer when Phase 5 lands. Confidence replacement **[gated by M3]** for the randomised
  variant, but the descriptive win-rate table can ship first.
- **EFFORT:** L (in shippable S/M slices per Agent 3). **SEQUENCE:** NEXT.

### B5. Contamination guards before Phase 5 switches on **[gated by M3]**
- **WHAT:** Provenance tagging (applied suggestion stamps the resulting `RateChange`/`PushLog`;
  learnings exclude or separately label self-caused changes), plus the endogeneity gauge
  (report "all data" vs "exogenous only" learning divergence), plus the holdout split.
- **WHY:** Goal 1's integrity once the app acts: otherwise the death spiral (drop → booking →
  "drops work" → drop more) is unguarded, the booking curve is endogenous to policy, and the
  histories become unmixable forever (Agent 6, narrative 1).
- **HOW:** `PushLog` writer + exclusion pattern copied from the rate-copy exclusion in
  `scan-service.ts:163-196`; variant computation in `learnings.ts`; divergence line in
  `readout.ts`.
- **EFFORT:** M. **SEQUENCE:** LATER, but **blocking** for Phase 5 – Phase 5 must not ship
  without it.

### B6. Rebuild the control substrate
- **WHAT:** Minimum-meaningful-move filter (~3%) on drop events, controls and attribution;
  event-level, per-listing stratified control sampling (replace take-50-newest); feed the
  ladder's band/min from `rate_states` (134k rows) when engine snapshots are absent, unlocking
  rungs 1–2 and non-degenerate regret for scan tenants; declare "no control available" instead
  of writing rung-3 rows with confidence 0.3 of nothing.
- **WHY:** Goal 1. The learner is currently studying PriceLabs' noise floor (median detected
  drop ~0.9%), 77% of controls carry no counterfactual, and coverage is 0.9% of drops on 9
  listings.
- **HOW:** `peer-ladder.ts:143-233` (sampling, band source), `signals/config.ts` (threshold),
  `attribution.ts` (filter). Actor heuristics (rate-copy targets as `mark`, portfolio-wide
  same-day sub-3% sweeps as `engine`) can follow as a second slice.
- **EFFORT:** M. **SEQUENCE:** NEXT (before M1's estimates are trusted, share its event
  definition).

### B7. See the far-out strategy: market signals, symmetric suggestions, applicability
- **WHAT:** (a) Read the captured-but-ignored PriceLabs `market_occ_next_30/60` and
  `recommended_base` (156/312 prod rows) as the first far-out positioning signal (own vs
  market occupancy at 30/60d). (b) Diff `recommended_base` in `snapshot.ts:38-74` as
  first-class engine behaviour so learning #5 produces anything. (c) Add symmetric hold/raise
  suggestions from the same curve for nights ahead of pace, and Agent 4's "why not" held-nights
  list in the readout. (d) Publish a per-client philosophy applicability score (share of
  booking value beyond 30/60 days from existing `NightFact` lead + revenue).
- **WHY:** H7: the system currently automates only the tactical tail, downward. Goal 1's core
  experiment (does early sharpening win?) has no instrumentation, and a one-directional
  recommender teaches "when in doubt, cut" (goal 2). The applicability score stops a
  Belfast/LF strategy being taught as universal (Coorie's median lead is 24 days).
- **HOW:** `snapshot.ts` (diff field), new reader over `engine_snapshots`,
  `suggestions.ts` (one branch in `judgeNightForSuggestion` + a `hold`/`raise` type),
  `readout.ts`, profile field for the score.
- **EFFORT:** M. **SEQUENCE:** NEXT/LATER (b and d are S and can ship early; a and c after B1).

### B8. Fix the remaining learning feeds
- **WHAT:** Root-cause and repair `daily_aggs` (0 rows kills pricing power) or compute
  learning #4 from `NightFact` + `CalendarRate` directly; route trial events into
  `dateTypeFor` so "event" is reachable; fix `computeNetRealised` (discounts hardcoded 0,
  unbounded `arrival: { gte }` including unstayed future bookings) and stop the daily run
  nulling the weekly fee drag; compute cancellation quality within listing/season strata
  before it may graduate to a rule.
- **WHY:** Goal 1 and 2: pricing power is the "hold" half of any teachable method and is
  currently null for every client; fee drag is the host-language number clients respond to and
  survives under 24h a week.
- **HOW:** `learnings.ts:33-39,75-79,203-241`, `observe-service.ts:144` (includeNetRealised on
  daily runs or preserve-on-null), whatever job owns `daily_aggs`.
- **EFFORT:** M. **SEQUENCE:** NEXT.

### B9. Teachability layer
- **WHAT:** Structured decision trace in `Suggestion.detail` (inputs, rule fired, size
  computation, floor checks, review-by date) rendered as a plain-English paragraph;
  denominators on every emitted number (`{value, n, window}` types); per-field sample sizes
  and a stability index on ClientProfile (settled vs unsettled rendering); weekly diff-based
  playbook changelog per client replacing the one-shot day-30 email; counterexample library
  (nights where a rule's prediction failed, attached to the rule).
- **WHY:** Goal 2. The methodology draft (v0.1) shows a trainee cannot currently answer "why
  12% and not 8%?", never sees a worked example, and cannot tell load-bearing numbers from
  noise.
- **HOW:** `suggestions.ts` (detail payload), doc types in `client-profile.ts`/`readout.ts`,
  the profile-history problem is solved for free by B2's learning ledger.
- **EFFORT:** M. **SEQUENCE:** NEXT/LATER (decision trace ships with B1; the rest follows B4).

### B10. Same-market cross-tenant rate percentile (optional)
- **WHAT:** Anonymised nightly rate percentile for Belfast (two tenants share the market)
  through the existing `anonymiseForGlobal` whitelist, attached to the settled ledger as a
  comp-position covariate.
- **WHY:** Goal 1: the only competitor-position signal available without a new external
  dependency; directly instruments the philosophy's part (a).
- **HOW:** `global-methodology.ts` whitelist extension + ledger column.
- **EFFORT:** M. **SEQUENCE:** LATER, and revisit when the KeyData decision lands (CLAUDE.md:
  KeyData is the planned market-data replacement; do not build a parallel comp system if
  KeyData is imminent).

---

## Part C – Rejected, with reasons

- **Tune the 48h attribution window to some other constant** (implicit option in H5): rejected.
  Any single window is wrong for a daily-recurring treatment; keep the plumbing as substrate
  and let the hazard model (below) replace its analytical role. Do not spend effort re-deriving
  a constant that should not exist.
- **Ship Agent 2's discrete-time booking-hazard model now**: deferred, not rejected on merit.
  It is the right eventual backbone (replaces `expectedCumulativeFill`, the window, and the
  sizing gradient), but it is L-effort and unhelpfully abstract until the settled ledger (B4)
  and historical mining (M1) exist to fit and validate it. Interim: the S-size
  final-occupancy multiplier on `expectedCumulativeFill` ships inside BP-01.
- **Invest further in learning #5's source classifier (rework the 24h window, owner/mark
  inference)**: rejected for now, per Agent 1. Zero lever moves in six days means there is
  nothing to classify; B7(b)'s `recommended_base` diff is the only #5 work worth doing until
  recorded human lever moves exist.
- **Cut learning #7 (cancellation quality)**: rejected. Keep it as the sceptical yellow flag
  (Agent 1), fix its confounding (B8) – but it may not graduate to a rule as-is.
- **Delete the rung-3 rows / rebuild the whole ladder from scratch**: rejected. The rows are
  harmless storage; B6 changes what gets written next. Retroactive cleanup buys nothing.
- **Build a new external comp-set data source**: rejected. CLAUDE.md is explicit that KeyData
  is the planned integration and AirROI must not return; B7(a) and B10 extract the comp signal
  already available inside the estate instead.
- **Shorten or bypass the 30-day silent window to get suggestions sooner**: rejected. All
  agents rate the window as correct governance; M2 makes the silence productive instead.
- **Recommend minimum-stay levers as part of symmetric suggestions**: rejected outright – owner
  has explicitly barred min-stay nudges (memory: feedback-no-min-stay-nudges).
