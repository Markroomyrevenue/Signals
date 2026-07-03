# Agent 1 – Revenue management science review

Reviewer persona: revenue management scientist, 15 years hotel/STR pricing, has run pricing teams.
Scope: are the seven learnings the right signals for a daily-drop method; what a senior RM needs that is missing; the drop trigger and band; the philosophy test; rulings on H2 and H7.
Date: 2026-07-03. Branch: `review/observe-learn-2026-07`. All prod queries were SELECT-only via `DATABASE_PUBLIC_URL`.

A note on provenance: the spec (`SIGNALS-OBSERVE-LEARN-SPEC.md`) referenced throughout the code comments was never committed and does not exist in the repo or its history. Every "spec says" claim below is therefore unverifiable; the code and `OBSERVE-LEARN-RUN-SUMMARY.md` are the only record of the design.

---

## 1. Hypothesis rulings

### H2 – drops validated by pickup velocity only, never revenue delta: CONFIRMED, and the reality is worse

Design level: pickup velocity (`pickupVelocity`, `src/lib/observe/learnings-core.ts:20-29`) is the only outcome metric the design contains for a price move. No function anywhere in `src/lib/observe/**` computes a revenue delta (nights x rate, old vs new) for a drop. A drop that fills a night at a loss scores identically to one that fills it profitably.

Implementation level: even pickup velocity is never computed in the wired path. `pickupVelocity` has no production caller (grep over `src` excluding tests: only the definition and the `movedPickup`/`controlPickup` parameter plumbing in `peer-ladder.ts:108-134` appear). `attachControlsForRecentChanges` (`peer-ladder.ts:218-228`) calls `recordPeerControl` without ever passing `movedPickup`/`controlPickup`, so they persist as null.

Prod confirmation (query: `SELECT rung, count(*), count(moved_pickup), count(control_pickup) FROM peer_controls GROUP BY rung`):

| rung | rows | moved_pickup non-null | control_pickup non-null |
| --- | --- | --- | --- |
| 1 | 262 | 0 | 0 |
| 3 | 888 | 0 | 0 |

**As shipped, drops are validated by nothing at all.** 1,150 control rows exist, none carries a measured outcome. Learning #1 is an orphaned pure function wearing a learning costume.

### H7 – the suggestion engine only automates late reactive drops, blind to the far-out strategy: CONFIRMED, quantitatively

Three independent lines of evidence:

1. **Only one suggestion type exists, and it is always a drop.** `generateSuggestionsForClient` writes `lever: "price"`, `type: "timed-pct"`, `proposedValue = round(rate x (1 - dropPct))` (`suggestions.ts:76-77, 190-197`). There is no raise, no hold, no "sharpen base 60-120 days out" type. The engine is structurally one-directional.

2. **The trigger cannot fire far out.** A night is only at risk when `expectedFill >= 0.5` (`RISK_FILL_THRESHOLD`, `suggestions.ts:20, 65`). `expectedCumulativeFill(d)` is the share of historical bookings with lead >= d (`suggestions.ts:29-37`), which crosses 0.5 at roughly the median lead time. Live median leads (query on `client_profiles.profile->'leadTime'->>'medianLeadDays'`): Little Feather 50, Yo's 39, Stay Belfast 25, Coorie Doon 24. So no suggestion can ever be generated beyond ~50 days out for the longest-lead client, and beyond ~24 days for Coorie Doon. The 120-day horizon (`SUGGESTION_HORIZON_DAYS`, `suggestions.ts:18`) is dead weight: days 51-120 are unreachable by construction. The system automates exactly the tactical tail and nothing else.

3. **No comp-set position signal exists – even though one is already being captured and ignored.** PriceLabs snapshots in prod carry market signals: 444 snapshots, 312 with `recommended_base`, 156 with `market_occ_next_30` (query: `SELECT engine, count(*), count(recommended_base), count(occ_next_30), count(market_occ_next_30) FROM engine_snapshots GROUP BY engine`). Grep shows these columns are written in `snapshot.ts:172-178` and read nowhere. The only market-position data the system has is dark.

Additional H7 aggravation: suggestions are ordered by `revenueAtRisk`, which is simply the night's current rate (`suggestions.ts:78, 124`), and capped at 50. The list therefore leads with the most expensive empty nights – peak Saturdays and event dates, precisely the inventory with pricing power that a competent RM holds. The ordering systematically proposes dropping premium inventory first. This inverts good practice.

---

## 2. Are the seven learnings the right signals? One by one, with live evidence

Headline structural finding first: **the learnings and the suggestions are disconnected.** `generateSuggestionsForClient` consumes only `computeLeadTime` (`suggestions.ts:150`). The ClientProfile – regret appetite, pricing power, cancellation quality, engine reaction, the divergence rules – is never read by the suggestion path. Six of the seven learnings feed a document nobody (human or machine) currently acts on. Whatever their individual merits, they do not yet shape a single recommendation.

**#1 Pickup velocity moved-vs-control – right concept, not wired.** The moved-vs-control idea is the correct core of a defensible method. It is unimplemented (see H2). Also note the control substrate is collapsing: 888 of 1,150 controls (77%) are rung 3 (confidence 0.3, empty control set, no counterfactual), and rung 1 exists only for Little Feather (262). Cause: the `movers` exclusion (`peer-ladder.ts:210-214`) removes any listing with any price change in the 14-day window – and the RateChange stream shows 128,276 price drops across the four tenants in the last 14 days (26,058 / 33,481 / 22,491 / 46,246) with a median |change| of ~0.9% (0.0086-0.0098; query: `percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(change_pct))`). When an RMS wiggles every listing daily, every listing is a "mover" and no clean control survives. The mechanism also samples at most 50 most-recent events per day (`CONTROL_MAX_EVENTS`, `peer-ladder.ts:145`) out of thousands – under 0.3% coverage, non-random. Verdict: keep the concept, rebuild the event definition (see improvement 5) before trusting any of it.

**#2 Lead-time curves – the one load-bearing learning, and worth keeping.** Well-sampled (booked nights with lead in trailing 365d: LF 25,928, Coorie 11,340, Yo's 7,992, SB 4,514, Escape Ordinary 13,495 – query on `night_facts`). The 20-booking graduation floor (`suggestions.ts:151`) is trivially passed everywhere; sample size is not the binding constraint. Two real defects: (a) one curve per tenant, pooled across all listings, DOW and seasons (`computeLeadTime`, `learnings.ts:61-69`) – a Saturday in August and a Tuesday in November share a curve, though weekends demonstrably book on different curves; (b) the curve is `P(lead >= d | eventually booked)`, not `P(booked by d)` – see section 4. Fix, do not cut.

**#3 Regret both directions – right idea, degenerate as built.** The pure core (`classifyRegret`, `learnings-core.ts:83-107`) is sound and unit-tested, but the DB wrapper (`computeRegret`, `learnings.ts:94-157`) does not use it and produces degenerate output: `none` is hardcoded 0 and `total = heldTooHigh + heldTooLow` (`learnings.ts:154-156`), so the two percentages always sum to 1 and the base rate is discarded. Live profiles (query on `client_profiles`): Coorie `heldTooHighPct: 1`, Yo's `heldTooHighPct: 1`, LF `heldTooLowPct: 0.849`, SB `0.651/0.349`. Consequences in prod today:
- Coorie and Yo's fired `tolerates_empty_premium` with parameter 1.0 – because with no engine `min` data (`minSnaps` from `engine_snapshots`, which hostaway-scan tenants do not have), `heldTooLow` is structurally 0, so `heldTooHighPct` is structurally 1. The rule is a data-availability artefact, not a client behaviour.
- LF fired `below_min_short_window` ("below-min moves are permitted for this client") off 550 of 648 nights flagged held-too-low. The comparison is `NightFact.revenueAllocated <= PriceLabs min x 1.05` (`learnings.ts:147-150`): net allocated per-night revenue (after channel fees and length-of-stay discounts) against a list-price minimum. Apples against oranges – long discounted stays will land "below min" without anyone ever pricing below min. This is the most dangerous artefact in the system: a mis-measured learning has minted a rule that licenses below-minimum drops.
- "Held too high" counts every currently-empty available night within 7 days (`learnings.ts:99-112`) – measured before the outcome. A night at 5 days out that books at 2 days out was still counted as regret today. Regret must be settled after the stay date, never forecast.

**#4 Pricing power by date type – dead on arrival in prod.** `computePricingPower` reads `DailyAgg` (`learnings.ts:75-79`); prod `daily_aggs` has **0 rows** (query: `SELECT count(*) FROM daily_aggs` returns 0). Every live profile has `pricingPower: null` (verified for all four). This is the one learning that would have guarded against dropping inelastic nights, and it silently produces nothing. Also, even if populated, its date-type map is 7 fixed holidays plus Fri/Sat (`dateTypeFor`, `learnings.ts:33-39`) with no events – despite the codebase already holding an events helper (`eventAdjustmentForDate` in `src/lib/pricing/events.ts`, per CLAUDE.md). Fix the data source, wire in events, then make suggestions consult it.

**#5 Engine reaction – starved, and the brief's premise is partially wrong.** The orchestrator brief says all tenants are on hostaway-scan; in fact LF and Stay Belfast have live PriceLabs snapshots (288 and 156 rows over 6 days, engine `pricelabs`). Even so, `engine_changes` = 0 (query), so learning #5 has zero samples everywhere – nobody has moved a base/min/max lever in 6 days, and the learning only sees lever moves, not the engine's daily price surface. Keep it dormant; it costs nothing. Do not invest further until there are recorded human lever moves to react to.

**#6 Net realised rate – right host-language metric, two fixes needed.** Fee drag is exactly the kind of number Mark's clients respond to. But `computeNetRealised` hardcodes `discounts: 0` (`learnings.ts:218`) so weekly/monthly discount drag is invisible, and its filter `arrival: { gte: since }` has no upper bound (`learnings.ts:206`), so unstayed future bookings are included in a "realised" rate. Keep, fix both.

**#7 Cancellation quality – keep as a guard, treat the label with caution.** All four clients read `cheaper_cancel_more` (query above). Consistent and plausible, but the win-price percentile is per-night `accommodationFare/nights` across the whole year (`learnings.ts:230-241`), so "cheap" terciles are heavily confounded with off-season, DOW and long discounted stays, and recent bookings' cancellation windows have not closed. It is a useful yellow flag against indiscriminate deep drops (drop-won bookings may be flakier), which is exactly the sceptical voice this system needs – keep it, but do not let it graduate to a rule until it is computed within season/DOW strata.

**Cut as noise, as currently built:** rung-3 PeerControl rows (888 rows, confidence 0.3, empty control set, no measured pickup – pure storage noise until an outcome is attached); the daily GlobalMethodology merge (see below); the `confidence` field on suggestions (`min(0.9, expectedFill)`, `suggestions.ts:83` – expected fill is not a confidence and presenting it as one will mis-train both staff and Mark's trust).

**GlobalMethodology autocorrelation defect:** `accumulateLearning` folds each client into the global doc on every daily run (`observe-service.ts:75`). Prod: `samples = 42`, `revision = 42` after ~6 days x 4 tenants plus settles – the "global" doc is a running mean over repeated, near-identical daily observations of the same four clients, weighted by run count, not a sample of clients. `medianLeadDays` 35.69 is a mean of re-submitted medians. `pricingPowerVotes` is `{}` (learning #4 dead). Any cross-client claim from this document is statistically empty. Merge once per client per settle at most, or keep latest-per-client and aggregate on read.

---

## 3. What a senior revenue manager checks before a drop that this system does not capture

In descending order of how much their absence hurts the three goals:

1. **Pace against a target, not against a booked-lead histogram.** The system has `PaceSnapshot` data (used by the reports) but the suggestion trigger never consults YoY or target pace – it judges each night in isolation against a shape-only curve. An RM asks "are we behind where we should be for this month at this lead, given last year and current demand", not "is this individual night empty later than the median booking arrives".
2. **Comp-set rate position.** Nothing records what competitors charge. "Be a little more competitive a little further out" is unmeasurable without it. Partial proxy already captured and ignored: PriceLabs `market_occ_next_7/30/60` (156 prod rows).
3. **Displacement and length-of-stay.** Dropping a lone Saturday can win a 1-night booking that displaces a 3-night arrival; orphan nights between bookings have different economics from open weeks. `Reservation.nights` exists; no learning or suggestion uses stay length or gap topology. (Note: recommending min-stay changes is explicitly off the table per owner feedback – this is about LOS-aware drop decisions, not min-stay nudges.)
4. **Day-of-week x season interaction.** One pooled curve per tenant (section 2, #2). The single most common daily-drop error in practice is dropping a weekend on a weekday's curve.
5. **Event demand shape.** `dateTypeFor` knows 7 fixed dates; the Fleadh-class event machinery exists elsewhere in this codebase and is not consulted. An empty night before a major event is behind curve and should be held, not dropped.
6. **Channel mix.** Not captured anywhere; matters for net rate (channel fee spread) and for how visible a price cut even is.
7. **The client's own discount dose-response.** With 554k `rate_changes` and 1,922 `booking_rate_contexts` already stored, the question "when this client drops 10%+, how often does the night fill within 48h vs matched undropped nights" is answerable today and is never asked.

---

## 4. Is "empty + behind expected fill => drop" the right trigger?

No – it systematically over-fires, and it over-fires worst on the nights that should be held. Four mechanisms:

1. **Missing final-occupancy scaling.** `expectedCumulativeFill(d)` = share of *eventual bookings* with lead >= d. The correct comparison is expected *occupancy* at d days out = final occupancy x P(lead >= d). At ~70% annual occupancy, a night at median lead has true expected occupancy ~35%, not 50%. The trigger treats every night as if it will certainly book, so a structurally 60-70%-occupancy portfolio will always show a thick band of "behind pace" nights. Every empty night between ~median lead and stay date is permanently at risk, every day, until it books or passes.
2. **No demand-side exclusions.** No event/holiday hold, no inelastic-date-type guard (learning #4 is null in prod and unconsulted anyway), no pace-ahead offset from strong months.
3. **Premium-first ordering.** Ranking by raw rate (section 1, H7) surfaces the highest-rate empty nights first – peak dates – the opposite of where a drop list should start.
4. **Re-fire compounding.** Pending suggestions are deleted and regenerated each run (`suggestions.ts:181`). If a drop is applied and the night stays empty, tomorrow's run proposes a further 5-25% off the *new* rate. Nothing remembers yesterday's drop. Over a week this compounds to far below any floor the method would defend. (Death-spiral mechanics are Agent 6's charge; I flag the RM consequence: the trigger has no memory, and a method with no memory is not a method.)

What the trigger gets right and should keep: judging against lead-time-conditional expectation rather than final occupancy is the correct family of trigger; ordering by money rather than by count is right in spirit; the cap keeps the list reviewable; booked nights are never touched. The skeleton is sound. The demand model inside it is not.

## 5. Is the 5-25% band defensible?

The band itself (floor 5%, cap 25%) is a reasonable prior for STR close-in discounting – as a *starting* guardrail I would not fight it. What is not defensible:

- **The mapping into the band.** `dropPct = min(0.25, max(0.05, (expectedFill - 0.5) x 0.5 + 0.05))` (`suggestions.ts:76`) scales drop size purely with *lateness on the curve*, i.e. with time, not with demand, elasticity, comp position or the client's realised discount response. Reaching the 25% cap requires expectedFill 0.9 – for Coorie (median lead 24d) that is roughly inside the final week, where a 25% cut on an inelastic weekend is a pure giveaway and on a dead midweek is probably not enough. Same lateness, opposite correct actions.
- **Nothing ever updates it.** No learning writes back into the constants (this is H3, Agent 3's remit; from the RM side I confirm the constants encode no client's data).
- **It ignores the two rules the profile already mints.** A client flagged `tolerates_empty_premium` gets exactly the same drop sizing as one flagged `below_min_short_window`. The profile and the band never meet.

Defensible version: keep 5-25% as the outer clamp; derive the point estimate inside it from the client's own dose-response (improvement 2 below) conditioned on DOW/date type, with the profile rules as modifiers. Until then the band is a house style, not a method – fine to state as such, not fine to present as learned.

## 6. Philosophy test (shared with Agents 2 and 6)

**Can the system see the far-out positioning move? No.** Established under H7: no suggestion beyond ~median lead (24-50 days live), no raise/sharpen type, no comp position. As built, goal 3 would automate only the tactical tail – and only its downward half.

**Does the captured data support "early competitiveness wins higher-value bookings and fewer gaps"? It could, partially, but no learning currently computes the needed quantities.** The raw material exists: `NightFact.leadTimeDays` + `revenueAllocated` (63k booked nights with lead across live tenants) supports *value by lead band* (is revenue per night actually higher for early bookings, per client, per season?); calendar data supports gap-night rates. What is missing and cannot be reconstructed from current capture: competitor rate position at the time of each booking (no comp data at all), and any counterfactual for "we sharpened early" (no record links a far-out positioning move to the bookings that followed, because far-out moves are not even a recognised event type).

**Where the philosophy fails, and how to detect it honestly:**
- *Genuinely inelastic windows* (events, graduation/festival weekends, compression dates): sharpening early sells inventory that would have sold anyway, at a discount, to the earliest – and per learning #7's consistent `cheaper_cancel_more` reading, possibly flakier – bookers. Detector: settled held-too-low rate (fixed version of learning #3) concentrated in specific date types; value-by-lead-band showing *early bookings earning less* per night in those windows.
- *Short-window markets*: Coorie Doon's median lead is 24 days – half its bookings arrive inside ~3.5 weeks. "Further out than competitors" barely exists as a lever there; the philosophy is a Belfast/LF strategy being generalised. The per-client lead curve is exactly the right instrument to decide *where the philosophy applies at all* – this framing (philosophy applicability as a per-client learned property) should be explicit in the methodology.
- *Everyone sharpens*: once peers (or the app itself, at scale) adopt early sharpening, the early-mover margin compresses and the observed "lift" becomes contamination (Agent 2/6 territory).
- Honest measurement minimum: pre-register the metric as *net realised revenue per available night over a season*, not fill; compare sharpened vs unsharpened at matched DOW/season/date-type; randomise which listings/weeks get the early sharpening (staggered rollout). Fill-rate wins alone must never be accepted as validation – that is H2's trap generalised.

## 7. Fine, leave alone

- The 48h booking-to-change attribution substrate (`src/lib/signals/attribution.ts:44-71`): cheap, idempotent, latest-change-wins is a sane tie-break. Its validity limits are Agent 2's charge; as plumbing it is good.
- The anonymisation whitelist (`global-methodology.ts:40-60`): genuinely clean, ratios and labels only; the leak test claim held on inspection.
- The 30-day silent window, the pending-only suggestion posture, and the human-approval gate: exactly right for goal 3's trust arc. Do not shorten.
- Snapshot capture + diff mechanics (`snapshot.ts`): resilient per-listing error handling, epsilon guard, sound engineering. Leave alone.
- Lead-time bucket boundaries (`learnings-core.ts:33-42`): standard, fine.
- Suggestion cap at 50 and money-ordering *in spirit* (fix the ordering key, keep the idea).

## 8. Improvement ideas beyond the current design and the listed hypotheses

1. **Settled-night outcome ledger (regret at settlement, not forecast).** Nightly job re-labels each past night after the stay date: booked/empty, final net rate, lead at booking, drops applied on the way, days-empty-before-sale. Converts learning #3 from a forward guess into settled fact, gives every applied suggestion a real outcome, and is the substrate every other fix needs. (Distinct from H1's generic "closed loop": the specific claim is that *regret must only ever be computed on settled nights*, and the current forward-counting version should be deleted, not patched.)
2. **Learn the drop dose-response from data already in the DB.** 554,431 `rate_changes` + 1,922 `booking_rate_contexts` already link drops to bookings. Estimate fill-within-48h by drop-size bucket (0-3/3-7/7-15/15%+) vs matched undropped nights per client x DOW. Replaces the hand 5-25% mapping with each client's own measured response curve – no new capture needed, answerable this week.
3. **Symmetric suggestions: hold/raise from the same curve.** Nights *ahead* of expected fill at their lead should generate "hold" or "+X%" suggestions. A one-directional recommender teaches staff that the method is "when in doubt, cut" – symmetry is what makes the methodology defensible (goal 1) and teachable (goal 2), and it costs one branch in `judgeNightForSuggestion`.
4. **Exploit the captured-but-ignored market signals as the first far-out positioning input.** `market_occ_next_30/60` and `recommended_base` are already in `engine_snapshots` (156/312 prod rows). Own-occupancy vs market-occupancy at 30/60 days is precisely the "sharpen further out" trigger the philosophy needs, for zero new integration work where PriceLabs keys exist.
5. **Minimum-meaningful-move filter + actor heuristics on the scan stream.** Median detected "drop" is ~0.9% – RMS daily wiggle, not method. Exclude |change| < ~3% from drop events, controls and attribution; tag rate-copy targets as `mark` and portfolio-wide same-day sub-3% sweeps as `engine` (the `rate_changes` table has no actor column at all – verified via `\d rate_changes`). Without this, the learner is studying PriceLabs' noise floor, not Mark's method.
6. **Per-client philosophy applicability score.** Publish, per client, the share of booking value arriving beyond 30/60 days (from existing NightFact lead + revenue). Clients below a threshold (Coorie: median lead 24d) get the close-in playbook only; the far-out strategy is explicitly marked not-applicable. Stops the method being taught as universal when the data says it is regional.

## 9. Incidental live-state observations (for Agents 5/7)

- The brief's "all tenants on hostaway-scan" is wrong: Little Feather (288 snapshots/48 listings) and Stay Belfast (156/26) are live on PriceLabs since 2026-06-28. `engine_changes` is still 0, so learning #5 is starved regardless.
- The missing 5th tenant is **Escape Ordinary** (53 active listings, no observation window). Likely cause: `ensureObserveSchedules` registers repeatables only at worker boot (`observe-worker.ts:67-82`); a tenant created after the last restart never gets a job. Its id (`cmr51...`) is a much later cuid generation than the four scheduled tenants (`cmo...`), consistent with post-boot creation.
- `daily_aggs` is empty in prod (0 rows), which silently kills learning #4 – worth a root-cause pass on whatever job was meant to populate it.

## 10. Verdict against the three goals (this agent's view)

- **Goal 1 (defensible methodology): not on track as designed.** The only validation metric is unwired, regret is degenerate and has already minted a dangerous below-min rule from a measurement artefact, pricing power is dead, and the suggestion engine consumes one learning out of seven. The skeleton (curve-conditional judgement, controls, silent window) is worth keeping.
- **Goal 2 (train people): not on track as designed.** What the profile currently codifies is either degenerate (`tolerates_empty_premium` at 1.0 from missing data) or wrong (`below_min_short_window` from a net-vs-list comparison). Teaching from these rules today would train the wrong method.
- **Goal 3 (train the app): the governance is right, the brain is not.** Pending-only, human-gated, 30-day-silent is the correct trust architecture. The recommendations inside it would, in week one post-graduation, lead with 25%-capped drops on the most expensive empty peak nights – the visibly-stupid-suggestion trust failure Agent 6 is charged with, arriving on schedule.
