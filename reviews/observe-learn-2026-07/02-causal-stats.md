# Agent 2 – Causal inference and experimentation review

Persona: pricing-experiment statistician. Charge: can this design ever prove a drop worked?
Date: 2026-07-03. Prod data pulled read-only from `DATABASE_PUBLIC_URL` (queries in the appendix).
All prose UK English; every code claim cites file:line; every data claim cites its query.

## Verdict in one paragraph

No. As built, the system cannot prove a drop worked, and it is not close. The one causal
comparison in the design (moved vs control pickup, learning #1) is scaffolding that is never
executed: `pickupVelocity` has no production caller and all 1,150 `peer_controls` rows in prod
have `moved_pickup` and `control_pickup` NULL. The 48h attribution window is mechanically
satisfied by routine engine repricing (80–204 price-change rows per listing-day), so
`BookingRateContext` measures the engine's breathing rate, not drop effects. 77% of peer
controls are rung 3, which records "no control exists" and computes nothing. Every confidence
number is an unvalidated constant or a category error. The good news: the raw substrate
(554k `rate_changes`, 134k `rate_states`, 63k+ lead-timed night facts, a pending-approval
suggestion pipeline) is exactly what a real measurement design needs, and the fix is cheap
relative to what is already built.

---

## 1. Hypothesis rulings

### H2 (drops validated by pickup velocity only, never revenue delta) – PARTIAL, in the worse direction

The design intends velocity-only validation; the implementation delivers **no validation at all**.

- The velocity metric exists as a pure function, `pickupVelocity` at
  `src/lib/observe/learnings-core.ts:20-29`, returning bookings-per-listing-day and a
  `liftPct`. It is exercised only by tests. The single production writer of `PeerControl`,
  `attachControlsForRecentChanges` (`src/lib/observe/peer-ladder.ts:218-229`), calls
  `recordPeerControl` without `movedPickup`/`controlPickup`, so they default to null
  (`peer-ladder.ts:133-134`).
- Prod: `SELECT rung, count(*), count(moved_pickup), count(control_pickup) FROM peer_controls
  GROUP BY rung` returns `1|262|0|0` and `3|888|0|0`. Zero measured outcomes in 1,150 rows.
- Revenue delta appears nowhere: no code path multiplies a post-drop booking's realised rate
  against the pre-drop rate or a counterfactual. `Suggestion` rows carry `revenueAtRisk`
  (the current listed rate, `src/lib/observe/suggestions.ts:79`), which is exposure, not outcome.

So H2's framing ("velocity only") is generous. Nothing closes on either velocity or revenue.

### H3 (drop-sizing and confidence are hand-tuned constants nothing updates) – CONFIRMED

- Drop size: `const dropPct = Math.min(0.25, Math.max(0.05, (args.expectedFill - threshold) * 0.5 + 0.05))`
  at `src/lib/observe/suggestions.ts:76`, with `threshold = RISK_FILL_THRESHOLD = 0.5`
  (`suggestions.ts:20`). The constants 0.25, 0.05, 0.5, 0.05 appear only here; grep shows no
  code writes them, and no table stores learned replacements.
- Confidence: `Math.min(0.9, args.expectedFill)` at `suggestions.ts:83`. Rung confidences
  0.8/0.5/0.3 are literals at `src/lib/observe/peer-ladder.ts:30`. Nothing in
  `learnings.ts`, `client-profile.ts` or `global-methodology.ts` feeds back into any of them.
- The learning pipeline's outputs (ClientProfile, GlobalMethodology) are consumed by nothing
  in the suggestion path except the lead-time buckets (`suggestions.ts:150-178`), which shape
  *when* a night is flagged, not *how big* the drop is or *how confident* to be.

### H5 (48h window and peer ladder untested; rung 3 no counterfactual; cancellations never re-linked) – CONFIRMED

- 48h is asserted, not derived: `ATTRIBUTION_WINDOW_HOURS = 48` at
  `src/lib/signals/config.ts:15` with a one-line comment and no justification anywhere in the
  repo (the original spec was never committed, so any "the spec says 48" claim is unverifiable).
- Rung 3 returns `controlListingIds: []` with the comment "the empty list signals portfolio
  elasticity" (`peer-ladder.ts:101-104`), and no code ever computes a portfolio-elasticity
  number for those rows. 888 of 1,150 prod rows (77%) are rung 3. Rung 2 has never fired (0 rows).
- Cancellations: `attributeRecentBookings` deliberately includes cancelled reservations
  (`src/lib/signals/attribution.ts:79-81`, a defensible choice), but nothing ever revisits a
  `BookingRateContext` when the reservation later cancels. Prod: 70 of 684 attributed
  reservations (10.2%) now have `cancelled_at` set, with no flag, no re-link, no discount of
  the "win". Learning #7 (cancellation quality, `learnings-core.ts:230-245`) is computed from
  reservation price percentiles and never joins to the drop that won the booking.

---

## 2. The 48h attribution window: what leaks in, what leaks out

**What leaks in: almost everything.** Attribution requires only that *some* price change on the
same stay-date was detected in the 48h before the booking (`attribution.ts:57`). But the
scanned engines reprice the whole 365-day calendar daily. Prod, last 14 days
(`rate_changes, lever='price'`): Coorie Doon 49,376 changes (80.2 per moved-listing-day),
Little Feather 63,812 (134.1), Stay Belfast 38,771 (184.6), Yo's House 91,484 (204.2). At that
base rate, P(qualifying change exists | any booking) is near 1 for any scanned listing, so a
`BookingRateContext` row is close to a tautology. The prod median `hours_since_change` of 9.8h
(p90 32.2h, n=1,922) is exactly what a twice-daily scan against a daily repricing engine
produces by clockwork; it is cadence, not causation. Coverage rates (attributed share of
bookings created in the last 30 days: Coorie Doon 221/399, LF 221/803, Stay Belfast 114/173,
Yo's 73/262) vary with scan timing, not with anything economic.

**What leaks out.**
- `detectedAt` is scan time (07:00 and 12:00 Europe/London,
  `src/lib/workers/../workers/rate-scan-worker.ts:18-19`), not the moment the rate actually
  changed on Hostaway. A change made at 13:00 is invisible until 07:00 next day, so a booking
  landing in that gap fails `detectedMs > bookingMs` (`attribution.ts:57`) and is
  unattributable even though the change plausibly caused it. Exposure time is mismeasured by
  up to ~19h, asymmetrically.
- No denominator. The design records changes that were followed by bookings but never the
  changes that were not, so even a naive conversion rate per change is uncomputable from
  `BookingRateContext` alone (the denominator sits unjoined in `rate_changes`).
- Direction-blind: `selectAttributions` links any lever move, including price *rises*
  (1,827 of 1,922 links are price, but nothing filters on `changePct < 0` in attribution),
  so a booking after a rise reads identically to a booking after a drop.

**Why 48 is the wrong question.** Any single window is wrong when the treatment recurs daily.
The right unit is the listing-night's booking hazard with the *current rate* as a
time-varying covariate (see §7). The window should be retired, not tuned.

## 3. The peer ladder as a control

**Selection bias is structural, and prod shows it.** A control listing is one with *no* price
change of any size, in either direction, on any date, in 14 days (`peer-ladder.ts:210-214`,
listing-level exclusion). When an RMS reprices everything daily, "unmoved" listings are
precisely the abnormal ones. Prod: Stay Belfast had 15 distinct moved listings against 14
active ones (a removed listing still generating changes), so no control ever exists and all
300 of its controls are rung 3. Coorie Doon: 44 of 46 listings moved, all 250 controls rung 3.
Yo's: 32 of 35 moved, all 300 rung 3. Little Feather is the only tenant with rung-1 controls
(262), and its most recent rung-1 control set is `C-321/C-322/C-403/C-611 St Annes`, i.e. the
static-priced student-accommodation block (0 price changes in 14 days, confirmed by query).
The only "clean control" the ladder can find for a short-stay apartment drop is a student hall
with a different demand process entirely. That is the selection bias made flesh.

**Snapshot starvation collapses the band check.** Rungs 1–2 require base and min within 20%
(`peer-ladder.ts:80-85`), read from the latest `EngineSnapshot` (`peer-ladder.ts:186-200`).
Prod has snapshots for only two tenants (Stay Belfast 156, LF 288); Coorie Doon, Yo's and
Escape Ordinary have zero, so `withinBand(null, ...)` is false (`peer-ladder.ts:47-53`) and
rung 1–2 are unreachable for them regardless of portfolio structure.

**Contamination once suggestions are applied.** Applied drops create `rate_changes` on the
treated listings, which makes them movers, which removes them from every control set for 14
days. As suggestion coverage grows, the control pool shrinks monotonically towards the
never-touched residue. The ladder therefore degrades fastest exactly when the system starts
acting, which is when the control is most needed. (Rate-copy listings are excluded from
scanning altogether, `scan-service.ts:163-190`, so their real price moves are invisible; any
of them entering a control set is "unmoved" only because we chose not to look.)

**Rung 3 confidence 0.3 of nothing.** A rung-3 row carries confidence 0.3 attached to an
empty control set and no computed quantity. 0.3 × undefined is undefined. The honest value of
a rung-3 control as currently written is zero information.

**Missing outcome even at rung 1.** Since `movedPickup`/`controlPickup` are never computed
(§1, H2), even the 262 well-formed rung-1 controls have never produced a single moved-vs-control
comparison. The ladder is a taxonomy of controls we did not use.

## 4. Sample sizes and the 20-booking floor

- The floor at `suggestions.ts:150-152` (`lead.n < 20`) gates on `n` from
  `computeLeadTime` (`learnings.ts:61-68`), which counts **occupied night facts, not
  bookings**. Prod trailing-365 counts: Coorie Doon 11,340; LF 25,928; Stay Belfast 4,514;
  Yo's 7,992; Escape Ordinary 13,495. The floor never binds; it is theatre. If it ever did
  bind, n=20 across 8 buckets gives roughly ±22 percentage-point 95% intervals per cumulative
  bucket share, useless for judging "behind pace".
- Night-weighting also biases the curve: each night of a stay contributes a row, and later
  nights of the same stay carry larger lead values, so long stays are over-weighted and
  smeared rightwards. LF's curve mixes 7,072 student-block nights (median lead 33d) with
  18,856 short-stay nights (median lead 54d) into one portfolio curve.
- The genuinely small sample is at the tenant level: `GlobalMethodology` shows
  `samples: 42`, but those are ~10 daily re-folds of the same 4 clients
  (`observe-service.ts:75` folds every daily run;
  `global-methodology.ts:114-168` increments `samples` each fold). Effective n = 4, with
  pseudo-replication inflating apparent support tenfold. Any cross-client "methodology"
  statistic from n=4 clients has essentially anecdotal standing.
- The fifth tenant, Escape Ordinary (53 listings, 13,495 lead-timed nights, 528 bookings in
  30 days), has 0 `rate_scans` and 0 `observation_windows`: it was never onboarded to the
  observe loop at all. It is the largest untapped sample in the estate.

## 5. Confounds, censoring, survivorship, and the confidence numbers

**Seasonality.** Everything pools 365 trailing days: the lead-time curve
(`learnings.ts:62`), pricing power (`learnings.ts:74`), cancellation quality
(`learnings.ts:223`). `expectedCumulativeFill` then judges a November night against a curve
dominated by summer behaviour, so shoulder-season nights are systematically flagged
"behind pace" and over-dropped. Pricing power's inelastic/elastic labels
(`learnings-core.ts:148-150`: occupancy ≥ 0.8 inelastic, < 0.5 elastic) conflate season with
date type. Note also `dateTypeFor` (`learnings.ts:33-39`) can never return `"event"`, so the
"event" row of learning #4 is permanently n=0.

**Regression to the mean / selection on treatment.** Drops (Mark's or the RMS's) are responses
to weakness. Any night that gets dropped was already behind; some fraction books anyway. With
no control executed (§1), every such booking silently supports "drops work". This is the
textbook mistake the peer ladder was meant to prevent and currently does not.

**Min-price censoring.**
- `judgeNightForSuggestion` proposes `rate × (1 − dropPct)` with no clamp to the listing
  minimum (`suggestions.ts:77`), so suggestions can propose below-min prices the engine will
  reject or claw back.
- Any future dose-response estimate is truncated at the min: nights already at min cannot
  receive the treatment, and those are disproportionately the weak nights, biasing estimated
  drop effects upward.
- The held-too-low test compares `revenueAllocated ≤ min × 1.05` where `min` is the *latest*
  snapshot min (`learnings.ts:126-150`) applied to bookings up to 90 days old: an anachronism
  (raise min today and history retroactively becomes "sold below min"), and `revenueAllocated`
  (net allocated revenue incl. discount spreading) is not the same quantity as a rate floor.

**Survivorship in the regret tallies.** `computeRegret` (`learnings.ts:94-157`) is a snapshot,
not a ledger. Held-too-high counts nights currently empty within 7 days of stay; a night that
books tomorrow exits the count with no memory, a night that expires empty was counted up to 8
times across daily runs but the profile only keeps the latest snapshot. Held-too-low counts
only bookings that survived (`isOccupied` night facts); a cheap-early booking that cancels
vanishes from the tally. And because the summary is built with `none: 0` and
`total = heldTooHigh + heldTooLow` (`learnings.ts:154-156`), **the two percentages always sum
to 1**. Prod confirms: Coorie Doon 0/1, LF 0.849/0.151, Stay Belfast 0.651/0.349, Yo's 0/1.
The profile rules then fire on these complementary shares (thresholds 0.15 and 0.25,
`client-profile.ts:44-46`), so at least one rule triggers for almost any client. LF's
"routinely sells below min, below-min moves permitted" rule (heldTooLowPct 0.849, 550 nights)
is largely an artefact of the anachronistic min test plus long discounted stays, yet it is
codified as a client rule a push stage could later enforce. This is the clearest case in the
system of a broken statistic being promoted into policy.

**The confidence numbers.** Three separate inventions, none a probability of anything:
rung confidences 0.8/0.5/0.3 (`peer-ladder.ts:30`); suggestion confidence
`min(0.9, expectedFill)` (`suggestions.ts:83`); and the implicit certainty of profile rules.
The suggestion one is a category error with adverse selection: `expectedFill` is "how booked
this night should be by now", so confidence is highest exactly for the most anomalous nights,
where unobserved night-level problems (poor listing, broken photo, local event cancelled) are
most likely the real cause and a price drop least likely to work. None of the three is ever
scored against outcomes, so none can be calibrated. Numbers that cannot be wrong are not
measurements.

## 6. What is fine – leave alone

- Attribution idempotency (`@@unique` upsert, `attribution.ts:114-138`) and tenant scoping
  throughout the observe code are sound.
- Including cancelled reservations at attribution time (`attribution.ts:79-81`) is the right
  call and consistent with the cancelled-pace logic; the defect is the missing later re-link,
  not the inclusion.
- The pure-core/DB-wrapper split with unit tests (`learnings-core.ts`, `peer-ladder.ts`
  pure functions) is genuinely good engineering and makes every fix below cheap.
- The anonymisation whitelist (`global-methodology.ts:40-60`) is strict and correct; do not
  loosen it.
- The pending-only suggestion flow (nothing auto-applied, `suggestions.ts:181-199`) is exactly
  the right substrate for randomisation: keep it.

## 7. Minimum viable measurement design

The claim Mark wants: "drops of size X at lead time Y earn Z% more revenue, with honest
uncertainty." The minimum design that supports it:

**Unit and outcome.** Unit = listing-night at decision time. Primary outcome = realised net
revenue for that night settled after the stay date (0 if it expired empty; cancellation
re-linked, so a cancelled win scores what it was resold for, or 0). Secondary = booked within
14 days of the decision (hazard form). This requires a resolved-outcome ledger (idea 1 below);
`night_facts` + `reservations` already contain everything needed to settle it.

**Randomisation: feasible and nearly free.** The suggestion pipeline already generates pending
rows that Mark approves in batches. Add one field at generation time: each at-risk night is
randomly assigned `apply` or `hold` (never shown / applied 72h late), stratified by lead-time
bucket × day-of-week × tenant, assignment recorded on the `Suggestion` row and in `PushLog`.
Holdout nights get the status quo, which is what all nights get today, so there is no
commercial downside beyond forgone (unproven) drop benefit on ~30% of nights for a few weeks.
Randomise at the listing-week block level (all at-risk nights of one listing in one ISO week
share an arm) to blunt within-listing spillover; measure cross-listing cannibalisation by
watching control-arm hazard on the same dates.

**Power at this portfolio size.** Assume at-risk nights convert at p0 ≈ 0.2–0.3 within 14
days and the effect worth detecting is +8 percentage points. Per-arm n ≈
2(1.96+0.84)² p̄(1−p̄)/δ² ≈ 500–650 nights, inflated ×1.5–2 for listing-week clustering →
roughly 1,000–1,300 nights per arm. The estate has ~198 active listings across the four
onboarded tenants and thousands of forward at-risk nights at any time (LF's median lead is
50d, so every empty night inside ~50 days flags). A coarse 2×2 (drop 5–12% vs 13–25%;
lead 0–14d vs 15–50d) reaches per-cell power in roughly 4–8 weeks of normal operation.
Revenue (not just fill) comparisons need the settled ledger and about one further month of
stay-date maturation. Report per-cell revenue delta per treated night with a 95% interval,
clustered by listing-week. That sentence, with those intervals, is the "Z% with honest
uncertainty" Mark is asking for. Nothing else currently planned gets there.

**Before randomisation is live (or alongside it):** an event-study on Mark's historic manual
drops: for each drop, compare the 7-day booking hazard of the treated stay-date against
matched un-dropped dates of the *same listing* (same DOW, same lead bucket, ±21 days). Within-
listing matching kills the worst selection bias the peer ladder suffers. `rate_changes` +
`night_facts` already support this retrospectively across 554k change rows.

## 8. Philosophy test: measuring "early competitiveness wins higher-value bookings and reduces gaps"

**What the claim decomposes into.** (a) Being priced sharper than comparators at long lead
raises the share of nights sold early; (b) early-sold nights realise higher value than
late-panic sales net of the sharper rate; (c) portfolios doing this end with fewer terminal
gaps. Each part is measurable, but (a) needs a comparator rate the system does not have.

**Data already in hand.** Own rate trajectory per listing-night at every lead
(`rate_states`/`rate_changes`, 134k/554k rows); booking lead and realised per-night revenue
(`night_facts.lead_time_days`, `revenue_allocated`, 63k+ rows across tenants); terminal gaps
(nights that expired empty, derivable from `daily_aggs`/`calendar_rates` vs `night_facts`).
So a within-portfolio version is testable today: define exposure = rate at 60–120d out
relative to the listing's own trailing ADR; outcomes = share booked by 60d, ADR of early vs
late bookings, terminal empty share; estimate with listing fixed effects across seasons, so
each listing is its own control. That answers "does pricing *yourself* sharper early pay?"
with observational caveats, and a listing-level randomised "sharpen 60–120d" trial (same
holdout machinery as §7) would answer it properly.

**What is missing.** Competitor position, the actual core of the claim. AirROI is removed,
KeyData is not integrated, and no observe table stores any external rate. The one free proxy:
two tenants are in the same city (Stay Belfast and Little Feather's Belfast units), so an
anonymised same-market rate-percentile covariate could be built through the existing
whitelist mechanism without new data sources. Also missing: cancellation-adjusted value
(early bookings have longer cancellation exposure; learning #7 exists but never joins back)
and any demand-shift control (search or enquiry volume) to separate "we were sharp early" from
"the market was strong early". Finally, note the suggestion trigger
(`empty + expectedFill ≥ 0.5 ⇒ drop`, `suggestions.ts:65-77`) fires only inside the booking
curve, i.e. inside ~50d for LF; nothing in the seven learnings observes or proposes the
far-out positioning move, so the system currently cannot even *see* the strategy it is meant
to validate. That is H7 territory (Agents 1 and 6), but from a measurement standpoint it means
goal 1's most important experiment has no instrumentation at all today.

## 9. Improvement ideas (beyond the current design and the listed hypotheses)

1. **A settled night ledger.** One row per listing-night, written after the stay date: final
   state (sold / expired empty / cancelled-resold), realised net revenue, winning lead, rate
   trajectory summary, and re-links on cancellation. Replaces the snapshot regret tallies
   (fixing the sums-to-1 degeneracy and survivorship in §5) and is the outcome table every
   design in §7 needs. Small: it is a nightly join of tables that already exist.
2. **A discrete-time booking-hazard model as the system's backbone.** Estimate baseline
   booking hazard by lead × DOW × month from the 63k+ lead-timed night facts, with the
   current rate (from `rate_states`) as a time-varying covariate. This one object replaces
   `expectedCumulativeFill` (fixing seasonality), the 48h attribution window (drop effects
   become hazard ratios), and gives drop sizing a gradient instead of the hand formula.
3. **Randomised holdout built into the suggestion pipeline** (§7): assignment at generation,
   recorded on `Suggestion`/`PushLog`, reported as per-cell revenue deltas with intervals.
   Feasibility at this portfolio size is demonstrated above; it converts routine operation
   into a permanent experiment.
4. **Calibration scoring of every emitted confidence.** Once outcomes settle, score each
   suggestion confidence and rung confidence against the realised outcome (Brier score +
   reliability curve in the readout). Constants that are never scored stay fiction; scored,
   they become a recalibratable mapping, and one that a trainee can be shown (serves goal 2).
5. **Same-market cross-tenant rate-position covariate.** Belfast is covered by two tenants;
   publish an anonymised nightly rate percentile per market through the existing
   `anonymiseForGlobal` whitelist and attach it to the night ledger. It is the only
   competitor-position signal available without re-introducing an external data dependency,
   and it directly instruments the philosophy test's part (a).
6. **Retrospective within-listing event-study on Mark's historic manual drops** (§7, last
   paragraph): evidence about drop effectiveness available in weeks, before any randomisation
   ships, from data already collected.

## Appendix – prod queries and returned values (all SELECT-only, 2026-07-03)

1. `SELECT rung, count(*), count(moved_pickup), count(control_pickup), avg(confidence) FROM peer_controls GROUP BY rung`
   → `1|262|0|0|0.8` ; `3|888|0|0|0.3`. (No rung-2 rows.)
2. Rung by tenant → Coorie Doon: 250 rung 3; Little Feather: 262 rung 1 + 38 rung 3; Stay
   Belfast: 300 rung 3; Yo's House: 300 rung 3.
3. `SELECT count(*), count(DISTINCT reservation_id), percentile_cont(0.5)…, percentile_cont(0.9)…, min, max FROM booking_rate_contexts`
   → `1922 | 684 | 9.76h | 32.19h | 0.03h | 47.43h`. Lever split: price 1,827, availability 90, min_stay 5.
4. Attributed share of bookings created in last 30d (LEFT JOIN reservations→booking_rate_contexts):
   Coorie Doon 221/399, Escape Ordinary 0/528, LF 221/803, Stay Belfast 114/173, Yo's 73/262.
5. Attributed reservations later cancelled: `70` of 684.
6. Engine snapshots by tenant: Stay Belfast 156 (156 base, 114 min non-null), LF 288 (282/276).
   No snapshots for Coorie Doon, Yo's, Escape Ordinary.
7. Price changes, last 14d, per tenant (count | distinct moved listings | changes per
   moved-listing-day): Coorie Doon 49,376|44|80.2; LF 63,812|34|134.1; Stay Belfast
   38,771|15|184.6; Yo's 91,484|32|204.2. Active listings: 46, 50, 14, 35 (+ Escape Ordinary 53).
8. Client profiles (revision 7): regret heldTooLowPct/heldTooHighPct/total → Coorie Doon
   0/1/89; LF 0.8487/0.1512/648; Stay Belfast 0.6514/0.3486/109; Yo's 0/1/88. Rules fired:
   `tolerates_empty_premium` (Coorie Doon, Yo's, Stay Belfast), `below_min_short_window`
   (LF, Stay Belfast). Median lead days: 24, 50, 25, 39.
9. Lead-timed occupied night facts, trailing 365d: Coorie Doon 11,340; Escape Ordinary
   13,495; LF 25,928; Stay Belfast 4,514; Yo's 7,992.
10. `global_methodology`: revision 42, `samples: 42`, regret 0.383/0.617, medianLeadDays 35.7.
11. Observation windows: 4 rows, all `observing`, started 2026-06-28, day 5/30. Escape
    Ordinary and Demo Property Manager: 0 rate_scans, 0 observation_windows.
12. Latest LF rung-1 control set = listings `C-321/C-322/C-403/C-611 St Annes`
    (student block), each with 0 price changes in 14d and 945 rate_states.
13. LF night-mix, trailing 365d, split by `name LIKE 'C-%'`: student 7,072 nights
    (median rev 80, median lead 33d); non-student 18,856 (median rev 78, median lead 54d).
