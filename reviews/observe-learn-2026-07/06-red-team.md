# Agent 6 – Red team: how this system confidently reaches wrong conclusions

Reviewer persona: adversarial. Charge: failure narratives with mechanisms, each walking the actual
code path that produces the wrong conclusion, plus an early-detection signal and the missing guard.

Scope note: the original spec (`SIGNALS-OBSERVE-LEARN-SPEC.md`) was never committed and does not
exist in the repo or its history. Code comments citing "spec §N" are unverifiable. Where a design
intent claim matters below, I treat the code as the only spec.

Live state used throughout (queried 2026-07-03, read-only, prod): 6 tenants; 4 observation
windows (all started 2026-06-28, day 5/30, none graduated); suggestions 0; push_logs 0;
peer_controls 1150; engine_snapshots 444 (all `engine='pricelabs'`, Stay Belfast 156 + Little
Feather 288, captured 2026-06-28..2026-07-03 – so PriceLabs keys ARE live for those two tenants,
contrary to the brief's "all on hostaway-scan"); engine_changes 0; global_methodology revision 42,
`samples: 42`.

---

## Part 1 – The seven charged failure narratives

### Narrative 1 – The death spiral: drop, booking, "drops work", drop more

**Mechanism.** Once suggestions start being applied (Phase 5, or Mark acting on the readout by
hand), the system learns from its own actions through three unguarded channels:

1. **The booking curve is endogenous to pricing policy.** A drop fills a night; the booking lands
   as a `NightFact` with a short `leadTimeDays`. `computeLeadTime` pools every occupied night in
   the trailing 365 days (`src/lib/observe/learnings.ts:61-69`) with no flag separating
   policy-induced bookings from organic demand. `expectedCumulativeFill` sums bucket percentages
   with midpoint >= daysToStay (`src/lib/observe/suggestions.ts:29-37`). More short-lead bookings
   shift bucket mass into 0-14d, which LOWERS expected fill at every horizon beyond a few days.
   The curve now says "it is normal to be empty until the last minute", so nights stop flagging
   until close-in, where the drop formula (`suggestions.ts:76`) fires at its steepest (expected
   fill near 1.0 close-in gives dropPct near the 25% cap). Each cycle pushes discounting later
   and deeper, ADR ratchets down, and the at-risk count falls – which reads as success.
2. **Regret "improves".** `computeRegret` counts every still-available night within 7 days as
   `held_too_high` (`learnings.ts:99-112`; `learnings-core.ts:94-95`). Drops that fill those
   nights shrink the tally regardless of price, so the profile records "less regret" after every
   drop, at any rate.
3. **Applied suggestions are anonymous.** No code path anywhere sets a `Suggestion` to
   approved/applied (grep across `src/lib/observe` and `app/api/observe`: zero writers besides
   the pending `deleteMany` at `suggestions.ts:181`), and `PushLog` has no writer at all
   (push_logs = 0). A drop Mark applies by hand surfaces in the rate-scan as an ordinary
   `RateChange`, gets a peer control attached (`peer-ladder.ts:164-169`), and gets bookings
   attributed to it within 48h (`src/lib/signals/attribution.ts:57`,
   `src/lib/signals/config.ts:15`) – indistinguishable from a market move. The learner cannot
   even in principle exclude its own influence.

**Early detection.** Trailing-90d median lead falling run over run while occupancy holds; realised
ADR falling vs same-period last year while `heldTooHigh` falls. None of these are computed today.
**Missing guard.** Provenance: a suggestion-to-rateChange link stamped at application time, and an
"endogenous" filter excluding self-caused bookings from `computeLeadTime` and `computeRegret`.

### Narrative 2 – Peer contamination: controls stop being controls

**Mechanism.** `buildPeerControl` excludes "movers" – any listing with ANY price-lever
`RateChange` in the 14-day window (`peer-ladder.ts:210-214`, direction ignored). All these
listings are still driven by PriceLabs, which re-prices daily, so on the hostaway-scan stream
almost every listing is a mover almost every window. Additionally rung 1/2 need `base`/`min` from
`EngineSnapshot` (`peer-ladder.ts:186-207`); tenants without PriceLabs keys have zero snapshots,
so `withinBand` fails on nulls (`peer-ladder.ts:47-53`) and every control lands on rung 3 – the
rung with an empty control set and no counterfactual (`peer-ladder.ts:104`).

**Live evidence.** Rung distribution query
(`SELECT rung, count(*), count(moved_pickup) FROM peer_controls GROUP BY rung`):
rung 1 = 262, rung 2 = 0, rung 3 = 888. All 262 rung-1 rows belong to Little Feather (the tenant
with snapshots carrying base+min); Stay Belfast, Coorie Doon and Yo's House are 100% rung 3
(300/250/300). And on **all 1150 rows `moved_pickup` and `control_pickup` are NULL**:
`attachControlsForRecentChanges` never passes them (`observe-service.ts:137`,
`peer-ladder.ts:222-228`), and `pickupVelocity` (`learnings-core.ts:20-29`) has **no production
caller at all** – learning #1, the headline moved-vs-control learning, is a dead function wearing
a confidence label. Once the app's own suggestions move prices portfolio-wide, the same tenant's
"peers" are moved too, so even the rung-1 population collapses to rung 3.
**Early detection.** Exactly the queries above: rung mix and pickup-null rate, per run.
**Missing guard.** A control-health metric (rung-1 share, pickup measured share) surfaced in the
readout, plus exclusion of suggestion-driven moves from the mover test only when they are tagged
(see narrative 1's guard) – otherwise controls should be declared unavailable, not silently rung 3
with confidence 0.3 recorded as if it meant something.

### Narrative 3 – A bad season read as "hold higher fails"

**Mechanism.** `held_too_high` is an absolute count of empty forward nights inside 7 days
(`learnings.ts:99-112`) with no seasonal baseline, no comparison to last year, no price term.
`buildClientProfileDoc` converts the tally into a personality trait: `heldTooHighPct >= 0.25`
fires `tolerates_empty_premium` (`client-profile.ts:94-100`). In a soft season every portfolio
accumulates empty close-in nights; the profile reads demand weakness as a client'S pricing
disposition, and the day-30 readout emails it to Mark as a learned rule
(`readout.ts:86-90`). Because `held_too_low` requires a per-listing `min` from `EngineSnapshot`
(`learnings.ts:126-135`), tenants without engine keys can NEVER register held-too-low – regret is
structurally one-sided for them, so `heldTooHighPct` trends to 1.0 by construction.

**Live evidence.** Client profiles (query on `client_profiles` joined to `tenants`): Coorie Doon
`heldTooHighPct = 1.0` (total 89) and Yo's House `heldTooHighPct = 1.0` (total 88) – both without
engine snapshots, both already carrying `tolerates_empty_premium`. Which "personality" a client
gets is determined by whether an env var is set, not by client behaviour. There is also no
month/season axis anywhere in the profile: `dateTypeFor` knows only holiday/weekend/weekday
(`learnings.ts:33-39`), so a seasonal confound cannot even be expressed, let alone corrected.
**Early detection.** `heldTooHighPct` at exactly 1.0, and regret totals that track the calendar
(rising into low season) rather than pricing decisions.
**Missing guard.** Regret measured against a seasonal expectation – `PaceSnapshot` YoY data
already exists in this app and is the obvious denominator – and a hard rule that a one-sided
regret metric (heldTooLow structurally zero) may not fire profile rules.

### Narrative 4 – Racing the RMS: double-dropping

**Mechanism.** PriceLabs still prices these listings daily. A suggestion is computed at 05:30 from
`CalendarRate` (`suggestions.ts:155-164`) – the last-synced Hostaway rate. PriceLabs pushes its own
(often lower, close-in) rate during the day. If Mark approves the suggestion, the 5-25% drop is
applied on top of, or racing, the engine's own move. Worse, the ratchet: suggestions are
regenerated every run post-graduation (`observe-service.ts:152-155`), pending rows are deleted and
rebuilt from the CURRENT rate (`suggestions.ts:181`), and `proposedValue = round(rate × (1 −
dropPct))` has **no floor of any kind** (`suggestions.ts:77`) – no listing min, no engine min, no
sanity bound. A night that stays empty gets a fresh drop off yesterday's already-dropped rate,
every day, compounding 5-25% daily with no memory that it was already dropped (nothing stores
prior drops per night; the pending rows that would show it are deleted). Approved rows are
preserved but not excluded from regeneration – the same night can carry an approved drop AND a
fresh pending drop simultaneously.
**Early detection.** Same-night suggestions on consecutive days with monotonically falling
`oldValue`; proposedValue below the listing's `EngineSnapshot.min`.
**Missing guard.** (a) A min-price floor on `proposedValue`; (b) a per-night cumulative-drop cap
across runs; (c) skip nights that already carry an approved/applied suggestion; (d) staleness
check on `CalendarRate.updatedAt` before quoting `oldValue` to a human.

### Narrative 5 – A profile built on unrepresentative bookings

**Mechanism.** The only sample gate on suggestions is `lead.n < 20` (`suggestions.ts:151`) – 20
bookings, pooled across the whole tenant (`computeLeadTime` has no listing, LOS, channel or
season dimension, `learnings.ts:61-69`). Twenty bookings spread over 8 buckets is ~2.5 per bucket;
a couple of corporate blocks or one event weekend reshapes the whole curve, and every listing in
the portfolio is then judged against it with displayed confidence up to 0.9
(`suggestions.ts:83`).

**Live evidence – this is not hypothetical.** Little Feather's profile (revision 7) carries
`below_min_short_window` with `heldTooLowPct = 0.849` and `allowBelowMinInShortWindows: true` –
a learned PERMISSION that Phase 5 is designed to enforce (`client-profile.ts:84-90`). I decomposed
the trigger with the same logic as `learnings.ts:138-150` (occupied nights, lead >= 1.5 × median,
`revenue_allocated <= min × 1.05`), grouped by listing. Top contributors: "zzA - 203 Somerset
Studios" 52 nights at **average revenue_allocated £5 vs min £85**; "zzz - 33 Custom house Square"
38 nights at **£0 vs £85**; the Portland student multi-units (zB-G02/710/G06/G01) 129 nights at
£80-94 vs min £140. The rule is built on zero-revenue artefact rows and student long-lets whose
per-night allocated revenue (net, discounted, long-stay) is being compared against a PriceLabs
nightly min (gross, short-stay) – a unit mismatch, not a pricing behaviour. Note also the rule is
self-contradictory on its own terms: the description says "short booking windows"
(`client-profile.ts:87-88`) but the trigger condition requires lead >= 1.5 × median – LONG
windows (`learnings-core.ts:96-103`). A trainee reading the codified rule learns the opposite of
what was measured.
**Early detection.** Any profile rule whose supporting nights include revenue_allocated near zero;
rule parameters above 0.8 (real behavioural signals are rarely that clean).
**Missing guard.** Exclude zero/near-zero-revenue nights and owner blocks from regret inputs;
compare like with like (booked gross nightly vs min); per-listing-class segmentation before any
rule that grants below-min permission; and a human-review flag on any rule that widens Phase 5's
authority.

### Narrative 6 – The visibly stupid suggestion that ends trust in week one

Graduation is ~2026-07-28 for all four tenants (windows started 2026-06-28). Fleadh Cheoil, the
biggest Belfast demand event of the year, runs 2026-08-02..09 – 5 to 12 days after the first
suggestion batch lands in Mark's inbox. The suggestion engine is event-blind: nothing in
`src/lib/observe/**` references `eventAdjustmentForDate` or `trial-events.ts` (grep: zero hits),
and `dateTypeFor` can never return "event" (`learnings.ts:33-39`), so the `event` bucket in
pricing power is permanently `n=0, unknown`.

Concrete arithmetic with the real Stay Belfast curve (profile bucketPcts, prod): at 5 days out,
expected fill = 0.094+0.100+0.154+0.168+0.079+0.214 = **0.81**, so an empty Fleadh Friday
(2026-08-07) flags at dropPct = min(0.25, (0.81-0.5)×0.5+0.05) = **0.20** with confidence 0.81
(`suggestions.ts:76-84`) – a 20% cut on the night `trial-events.ts:131` prices at **+50%**. The
same app simultaneously says +50% and −20% about the same night, and the −20% goes to Mark's
inbox as the system's first-ever output, sorted near the top because event-week rates make
`revenueAtRisk` large (`suggestions.ts:124`). Other stupidity vectors in the same generator: no
min-price floor (narrative 4); multi-unit blindness – `booked` is "any occupied NightFact"
(`suggestions.ts:165-174`), so a 40-unit student building with 1 unit sold is "booked" and never
flagged, while a truly empty multi-unit night has revenueAtRisk understated by unit_count; and the
readout table shows raw internal listing ids, not property names (`readout.ts:101`), so Mark
cannot even quickly sanity-check which property a row means.
**Early detection.** Cross-check every suggestion batch against `eventAdjustmentForDate` before
sending; any overlap is a stop-ship.
**Missing guard.** An event/holiday shield in `judgeNightForSuggestion`, a min floor, unit-count
awareness, and human-readable listing names. Cheap, and each one prevents a distinct class of
instant-credibility-loss email.

### Narrative 7 – Philosophy test: the case against "sharpen early, further out"

When it loses money: (a) **inelastic far-out demand** – events and peak weekends book early at
premium; sharpening early sells the best inventory to price-insensitive early bookers at a
discount. (b) **Early bookings carry cancellation optionality** – the system's own learning #7
found `cheaper_cancel_more` on Little Feather dev data (run summary, "Verified against real
data"), meaning cheap-won early bookings are LOWER quality, directly contradicting the
philosophy's "high-value early bookings" premise. The regret learning agrees: early + cheap is
literally the definition of `held_too_low` (`learnings-core.ts:96-103`). The system therefore
holds two codified positions that contradict the philosophy and each other, and no component
notices. (c) **Competitor matching** – competitors on comp-based RMS re-price daily; being first
to sharpen triggers matching within a day, so you keep the lower rate without the share gain.
(d) **Displacement** – long cheap early bookings block later high-value short stays;
`losNights` exists on NightFact (`prisma/schema.prisma:365`) but no learning reads it.

Would this system notice any of these? No. There is no revenue-outcome comparison anywhere: the
only realised-revenue learning is fee drag (`computeNetRealised`, `learnings.ts:203-219`,
`discounts` hardcoded 0), never revenue-vs-counterfactual (H2). The early-sharpening failure mode
manifests as flat occupancy with falling ADR, a pattern invisible to every one of the seven
learnings. Worse, the suggestion trigger only automates the tactical tail (close-in drops on
behind-curve nights); nothing observes comp-set position at 60-120 days or early-window booking
share, so the strategy's core move is both un-learned and un-falsifiable (H7). The philosophy may
well be right; this system can neither prove nor disprove it.

## Part 2 – Additional failure modes found (beyond the floor)

### 8. Pseudo-replication: the global methodology counts days as clients

`accumulateLearning` folds a contribution into `GlobalMethodology` on EVERY daily run and again on
weekly settles (`observe-service.ts:75`; `global-methodology.ts:167` increments `samples`).
Prod: `samples = 42`, revision 42, after 6 days of 4 tenants (plus settles) – 42 "samples" from 4
clients whose trailing-365d inputs overlap ~99.7% day to day. Consequences: (a) claimed sample
size is fictitious; (b) the running means fossilise – after a year a new client's contribution is
weighted 1/(n+1) ≈ 1/1500; (c) the artefact rules from narratives 3 and 5 are already averaged in
(global regret currently `heldTooHighPct 0.617 / heldTooLowPct 0.383`, regretSamples 35), so every
future client inherits the artefacts as "market truth". Detect: samples greatly exceeding tenant
count. Guard: fold at most one contribution per client per period, or store per-client latest and
recompute the aggregate.

### 9. Silent per-tenant death

Two of six tenants – **Escape Ordinary and Demo Property Manager** – have NO observation window
after 6 days of daily runs (query: tenants not in observation_windows). Window creation is the
first write in `runObserveForTenant` (`observe-service.ts:115`), and `ensureObserveSchedules`
registers all tenants unconditionally (`src/workers/observe-worker.ts:73-77`), so those two jobs
have failed every day before their first write, and nothing surfaced it: failures go only to
worker logs (`observe-worker.ts:90-92`), the readout builds from windows so an absent tenant is
invisible in the very tool meant to show system state. The brief itself believed "5 tenants on the
daily run" – even the operator's mental model is wrong, which is the point. Guard: a per-tenant
last-success timestamp in the readout, and an error line when any tenant has not completed a run
in 48h.

### 10. Learning #5 is structurally starved even WITH keys

Two independent mechanisms: (a) `diffEngineSnapshots` only compares base/min/max/minStay
(`snapshot.ts:38-74`) – the settings levers humans rarely touch – not daily calendar prices; prod
shows 444 snapshots and **0 engine_changes** in 6 days of live PriceLabs capture on two tenants.
(b) When a change IS detected, `inferEngineChangeSource` attributes it to "engine" whenever it
falls within 24h of `last_refreshed_at` (`snapshot.ts:93-97`, `config.ts:26`) – and PriceLabs
refreshes daily, so the engine-timing test almost always matches and human moves are misclassified
as engine moves. `computeEngineReaction` then filters to `source in ["owner","mark"]`
(`learnings.ts:173-175`) and finds nothing. The "what does Mark do differently from the engine"
methodology extraction cannot happen with this classifier, keys or no keys (extends H6 beyond the
no-keys framing).

### 11. The evidence needed to score suggestions is deliberately destroyed

`generateSuggestionsForClient` deletes all pending rows every run (`suggestions.ts:181`). There is
no append-only record of what was suggested when at what rate. Even a purely retrospective
evaluation ("did nights we flagged on Tuesday book by Friday, at what rate?") is impossible from
the data the system keeps. For goal 1 – turning finger-in-the-air into evidence – the single most
valuable artefact is the one being discarded daily. (The day-30 JSON snapshot in
`observe-reports/` captures one day only.)

## Part 3 – Hypothesis rulings (from the red-team evidence)

- **H1 (no closed loop): CONFIRMED.** No writer for Suggestion status transitions or PushLog
  anywhere; pickup fields NULL on all 1150 peer_controls; nothing re-observes outcomes
  (narratives 1, 2, 11).
- **H2 (velocity only, never revenue delta): CONFIRMED, and worse.** Even velocity is never
  measured (`pickupVelocity` has no production caller); the only revenue learning is fee drag with
  discounts hardcoded 0 (`learnings.ts:218`).
- **H3 (hand-tuned constants in a learning costume): CONFIRMED.** dropPct and confidence formulas
  (`suggestions.ts:76,83`), rung confidences (`peer-ladder.ts:30`), thresholds
  (`client-profile.ts:44-46`) – no code path updates any of them from outcomes.
- **H4 (no causal recipes): CONFIRMED with an aggravation.** The one rule type that exists
  (client rules) produced a live rule whose description contradicts its own trigger condition
  (narrative 5) – worse than no recipe, a wrong recipe.
- **H5 (untested attribution/ladder validity): CONFIRMED.** Rung 3 = 77% of controls, rung-1
  share is an artefact of key provisioning, pickup never measured, cancellations never re-linked.
- **H6 (cannot distinguish RMS moves from Mark's): CONFIRMED and extended** – it will remain true
  after keys arrive, because of the 24h source-inference window and the settings-only diff
  (failure mode 10).
- **H7 (blind to the far-out positioning strategy): CONFIRMED.** No comp-set signal, no
  early-window share metric, trigger fires only behind-curve close-in; plus the system holds
  learnings that actively contradict the philosophy without noticing (narrative 7).

## Part 4 – Improvement ideas beyond the current design

1. **Ghost-suggestion scoring (turn the wait into calibration).** Keep an append-only
   `SuggestionEvent` snapshot of every generated (not just surviving) suggestion, and a weekly job
   that scores each past suggestion against what actually happened with NO action taken: did the
   night book anyway, at what rate, how many days later? Because nothing is being applied yet,
   every suggestion is automatically a counterfactual observation of "what the RMS/status quo did
   instead". By push day Mark would hold weeks of "when the system said drop and we did nothing,
   X% booked anyway at full rate" – the single best defence against both the death spiral and the
   trust failure, and it costs one table plus one job.
2. **Machine-checkable sanity assertions as a first-class trust metric.** Every suggestion must
   pass explicit assertions before it can be written: above engine min, not inside an event window
   (`eventAdjustmentForDate` is right there), rate fresher than 24h, unit-count-aware, no approved
   suggestion already on the night. Failed assertions are counted and reported in the readout as a
   "blocked stupid suggestions" line. This converts the trust failure mode from a hope into a
   measured gate, and the counter itself teaches trainees the "when NOT to drop" half of the
   method that nothing currently captures.
3. **Regret against the seasonal self.** Redefine held_too_high as empties in excess of the same
   tenant's same-week-last-year empties, using the existing `PaceSnapshot` YoY infrastructure
   (out of scope to refactor, fine to read). One join changes regret from a weather vane into a
   pricing signal and kills the bad-season narrative at the root.
4. **Endogeneity tags on the event log.** A one-click "applied" action on a suggestion that stamps
   the resulting `RateChange` with the suggestion id; learnings then compute both "all data" and
   "exogenous only" variants and the readout shows the divergence. The size of that divergence is
   itself the measure of how much the system is learning from itself – a self-contamination gauge
   no amount of statistical cleverness can substitute for later, once the histories are mixed.

## Part 5 – Things that are fine, leave them alone

- The 404-when-unkeyed posture on the readout/suggestions routes and the key-masking discipline
  (`registry.ts`, `secrets.ts`) – sound, tested, consistent with the monthly-summary precedent.
- `anonymiseForGlobal` as a whitelist (`global-methodology.ts:40-60`) – the leak protection is
  real and tested; my complaint (failure mode 8) is with the merge cadence, not the anonymisation.
- Blocked nights ARE excluded from suggestions – `available: true` on `CalendarRate`
  (`suggestions.ts:157`) does that job; the charge's "drops on blocked nights" concern does not
  materialise.
- The `.email-sent` marker guard and prune-before-re-add schedule hygiene
  (`day30-runner.ts:79-110`, `observe-worker.ts:67-82`) – both address bug classes that have
  actually bitten this app; keep.
- The suggestion cap (50) and revenue-at-risk ordering (`suggestions.ts:124-125`) – right shape
  for a human-reviewed list, once the inputs above are fixed.
