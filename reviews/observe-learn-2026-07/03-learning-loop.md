# Agent 3 – Learning-systems engineer: the learning loop

Reviewer persona: ML engineer who builds decision systems, allergic to "learning" that is
actually a one-shot feature extractor. Read-only review on branch
`review/observe-learn-2026-07`, 2026-07-03. Every code claim cites file:line; every data
claim cites the query and the returned numbers. Prod queries were SELECT-only via
`DATABASE_PUBLIC_URL`.

Note on the missing spec: `SIGNALS-OBSERVE-LEARN-SPEC.md` and the build prompt were never
committed and are absent from git history. Code comments citing "spec §N" are unverifiable.
The code and `OBSERVE-LEARN-RUN-SUMMARY.md` are the only record of the design, and this
review treats the code as the design.

---

## 1. Verdict in one paragraph

This system is a well-built daily **feature extractor** wearing a learning costume. Data
flows cleanly from rate scans through to a per-client profile and a global aggregate, but
the flow is strictly one-way: nothing downstream of an observation ever changes how the
system observes, sizes, scores, or suggests. The suggestion engine consumes exactly one of
the seven learnings (the lead-time curve); the other six, the client rules, the peer
controls and the global methodology are write-only or email-only. There is no code path by
which a suggestion can ever be approved, applied, or re-scored against an outcome, and
yesterday's pending suggestions are deleted every morning, destroying the history you would
need to even backtest. On top of that, the global aggregate is measurably contaminated: it
counts the same client once per run rather than once per client (42 samples after 7 runs of
what should be at most 6 clients), and contributions from deleted tenants remain baked in
forever. None of this is hard to fix, and the substrate (554k `rate_changes`, 1,922
`booking_rate_contexts`) is genuinely strong. But as shipped, goal 3 (an app whose
recommendations improve with evidence) has no mechanism, only a hope.

---

## 2. The full data flow, hop by hop

### Hop 1 – Rate scan produces RateChange
The existing rate-scan worker diffs Hostaway calendar state (`RateState`) into `RateChange`
rows (`src/lib/signals/scan-service.ts`; model at `prisma/schema.prisma:628-648`). Rate-copy
listings are deliberately excluded from scanning (`scan-service.ts:163-196`). Prod:
554,431 `rate_changes` (orchestrator-verified count).

### Hop 2 – Booking attribution (48h window)
`attributeRecentBookings` links fresh reservations to the closest qualifying change per
stay-date within `ATTRIBUTION_WINDOW_HOURS = 48` (`src/lib/signals/config.ts:15`), writing
`BookingRateContext` (`src/lib/signals/attribution.ts:83-143`). Prod: 1,922 rows, 1,870
distinct rate changes.

**Dead end:** the only reader of `BookingRateContext` outside its writer is the dormant
monthly rate-scan summary (`src/lib/signals/summary.ts:272`). No observe-side learning
consumes it. The `{change → booking}` pairs the scanner's own header calls "the teachable
signal the scanner exists to grow" (`attribution.ts:6-7`) feed nothing.

### Hop 3 – Daily observe run
`runObserveForTenant` (`src/lib/observe/observe-service.ts:98-178`) per tenant: ensure the
30-day window (`observation-window.ts:43-58`), one-time backfill, engine snapshot capture +
diff (`snapshot.ts:115-235`), peer-control attach, learnings → profile → global fold, window
advance, and (post-graduation only, `observe-service.ts:152-155`) suggestions. Scheduled
daily 05:30 + Monday settle (`observe-worker.ts:67-82`, `config.ts:32-38`).

### Hop 4 – Peer control attach
`attachControlsForRecentChanges` (`peer-ladder.ts:153-233`) takes the **most recent 50**
price drops in a 14-day lookback (`peer-ladder.ts:143-145,164-168`) and attaches a
`PeerControl` at rung 1/2/3 with hard-coded confidence 0.8/0.5/0.3 (`peer-ladder.ts:30`).

**Dead ends, three of them:**
1. `movedPickup` / `controlPickup`, the fields that would hold the actual moved-vs-control
   pickup measurement, are never computed: `recordPeerControl` is called without them
   (`peer-ladder.ts:222-228`), so they default to null (`peer-ladder.ts:133-134`). Prod
   confirms: `SELECT rung, count(*), count(moved_pickup), count(control_pickup) FROM
   peer_controls GROUP BY rung` → rung 1: 262, 0, 0; rung 3: 888, 0, 0.
2. `pickupVelocity`, learning #1's pure core (`learnings-core.ts:20-29`), is never called by
   any non-test code (repo-wide grep: only its definition and test). Learning #1 is absent
   from `computeClientLearnings` (`learnings.ts:252-279`), which runs #2-#7 only.
3. Nothing reads `PeerControl` except its own idempotency check (`peer-ladder.ts:173-179`).
   All 1,150 prod rows are write-only.

**Structural rung collapse:** the ladder's price band needs base/min, which come exclusively
from the latest `EngineSnapshot` (`peer-ladder.ts:186-199`); `withinBand` returns false on
null (`peer-ladder.ts:47-53`). Hostaway-scan tenants have no snapshots
(`snapshot.ts:125-127`), so they can never leave rung 3. Prod per tenant: Coorie Doon 250
rung 3, Yo's House 300 rung 3, Stay Belfast 300 rung 3, Little Feather 262 rung 1 + 38 rung
3. Additionally the "movers" exclusion treats any listing with any price change in 14 days
as unusable as a control (`peer-ladder.ts:210-214`); with an RMS repricing daily (46,246
drops in 14 days for Yo's House alone; query: `SELECT t.name, count(*) FROM rate_changes
... change_pct < 0 AND detected_at >= now() - interval '14 days' GROUP BY t.name`), nearly
every listing is always a mover. The 50-per-day cap also means controls cover roughly 50 of
~3,300 daily drops per tenant (~1.5%), biased to the most recent.

### Hop 5 – Seven learnings → ClientProfile
`computeClientLearnings` (`learnings.ts:252-279`) recomputes six learnings from scratch
each run over trailing windows (365d lead-time at `learnings.ts:29,61-69`; 90d regret at
`learnings.ts:115`). `buildClientProfileDoc` (`client-profile.ts:65-137`) derives up to
three threshold-triggered "divergence rules" and `writeClientProfile` upserts one row per
tenant, bumping `revision` (`client-profile.ts:143-159`).

**This is the one-shot feature extractor.** The profile is a pure function of current DB
state. `revision` counts recomputations, not knowledge: prod shows all four profiles at
revision 7 after 7 runs (6 daily + 1 settle since 2026-06-28). No field carries a sample
size a consumer could weight by; no field is updated by an outcome; deleting the row and
re-running reproduces it exactly. There is no state that yesterday's world can influence
except through the raw source tables.

### Hop 6 – GlobalMethodology fold
`accumulateLearning` (`observe-service.ts:56-77`) folds an anonymised profile view into the
single global doc **every daily run and every weekly settle**
(`bootstrapOrUpdateGlobalMethodology`, `global-methodology.ts:181-196`), a running mean that
increments `samples` per call (`global-methodology.ts:114-169`).

**Measured contamination.** Query: `SELECT revision, methodology->>'samples',
methodology->>'regretSamples', methodology->>'medianLeadSamples' FROM global_methodology`
→ revision 42, samples 42, regretSamples 35, medianLeadSamples 35. The four surviving
profiles account for 4 × 7 = 28 contributions; the other 14 (exactly 7 × 2) came from
tenants that no longer have profiles or windows (prod has 6 tenants: Coorie Doon, Demo
Property Manager, Escape Ordinary, Little Feather, Stay Belfast, Yo's House; only 4 have
`observation_windows`/`client_profiles` rows). So the "global methodology" is currently: the
same 4-6 clients counted seven times each, including permanent, un-removable contributions
from tenants that have since been deleted or re-created. A client observed for a year will
be counted ~365 times against a new client's 1. This is not a per-client average; it is a
run-count-weighted echo with unbounded memory.

**Dead end here too:** `readGlobalMethodology` is only called by its own updater
(`global-methodology.ts:184`; repo-wide grep). Nothing inherits it as a new client's day-1
baseline (the module header's stated purpose, `global-methodology.ts:6-7`), nothing in the
readout renders it, and no suggestion logic consults it.

### Hop 7 – Suggestions (post-graduation)
`generateSuggestionsForClient` (`suggestions.ts:138-203`) loads **only** the lead-time
distribution (`suggestions.ts:150`), judges each forward empty night against the expected
cumulative fill, and writes pending `Suggestion` rows. Drop size and confidence are fixed
formulas: `dropPct = min(0.25, max(0.05, (expectedFill − 0.5) × 0.5 + 0.05))`
(`suggestions.ts:76`) and `confidence = min(0.9, expectedFill)` (`suggestions.ts:83`). The
rung confidences (0.8/0.5/0.3, `peer-ladder.ts:30`) never reach a suggestion; the
`Suggestion.rung` column (`schema.prisma:837`) is never populated. ClientProfile rules,
pricing power, regret, cancellation quality and GlobalMethodology are all ignored by the
generator.

### Hop 8 – Then what? Nothing.
- Every run **deletes all pending rows and regenerates** (`suggestions.ts:181`), so the
  suggestion history is destroyed daily. You cannot later ask "what did we suggest on 3
  July and what happened to those nights" because the rows are gone.
- The schema anticipates `approved | rejected | applied` (`schema.prisma:838`) but no code
  writes any of them: the only routes are GET (`app/api/observe/readout/route.ts`,
  `app/api/observe/suggestions/route.ts`; the suggestions route has a single `GET` export
  at line 20), there is no UI, and repo-wide grep finds no `suggestion.update` and no
  status writer.
- `PushLog` has no writer (Phase 5 unbuilt; prod count 0).
- The day-30 readout (`readout.ts:43-137`, `day30-runner.ts`) renders profile + pending
  suggestions to HTML/JSON/email. That email is the terminal consumer of the entire
  pipeline.

So the full flow is: RateChange → (PeerControl: write-only) → learnings → ClientProfile →
(GlobalMethodology: write-only) → Suggestion (pending, deleted daily) → email. No arrow
points backwards.

---

## 3. Hypothesis rulings

### H1 – no closed loop: **CONFIRMED**
Once generated, a suggestion has no forward path (no approve/apply writer anywhere; GET-only
routes) and no backward path (no job joins `Suggestion` to `NightFact`/`Reservation` after
the stay date; repo-wide grep for readers of `Suggestion` finds only `readSuggestions` at
`suggestions.ts:206`, used by the readout). Outcomes exist in the substrate
(`BookingRateContext`, `NightFact`, `Reservation.cancelledAt`) but nothing feeds them into
suggestion logic or the profile. Prod: suggestions 0 (no tenant graduated), push_logs 0,
and `moved_pickup`/`control_pickup` null on all 1,150 peer controls. Signal capture is
strong; the loop is open at both ends.

### H3 – hand constants wearing a learning costume: **CONFIRMED**
The drop-sizing formula (`suggestions.ts:76`) and confidence (`suggestions.ts:83`) are
literal constants in code, as are the risk threshold 0.5 (`suggestions.ts:20`), the rung
confidences (`peer-ladder.ts:30`), the regret thresholds (`learnings-core.ts:74,80`), the
profile rule thresholds 0.15/0.25 (`client-profile.ts:44-46`), and the elasticity cutoffs
0.8/0.5 (`learnings-core.ts:150`). No table stores any of these; no code path updates any of
them; the only way they change is a human editing source. The one learned input to a
suggestion is the lead-time bucket distribution. Everything labelled "confidence" in this
system is a design-time opinion, not a posterior.

### H4 (GlobalMethodology half) – averages away what matters: **CONFIRMED, and worse**
Beyond containing no causal recipes (it is means, votes and tallies:
`global-methodology.ts:62-74`), the aggregation itself is invalid for its stated purpose:
(a) it weights by run count, not by client (samples 42 after 7 runs, §2 hop 6); (b) it
never removes or decays a contribution, so deleted tenants persist forever (14 of 42
current samples are orphans); (c) it blends across markets and portfolio types into single
numbers (one `medianLeadDays` = 35.7 across a Belfast aparthotel operator and a Harrogate
cottage operator whose true medians are 25 and 39; profile query below), which erases
exactly the per-client differences the ClientProfile layer was built to preserve; and (d)
nothing reads it anyway, so today the damage is latent. Transfer across clients could be
legitimate if keyed by segment (market, property type, unit count) with per-client equal
weight and per-field sample counts. As built it is not.

Profile evidence (query: `SELECT t.name, cp.revision, regret fields, medianLeadDays,
rules length FROM client_profiles JOIN tenants`):

| tenant | rev | heldTooHighPct | heldTooLowPct | regret n | medianLead | rules |
|---|---|---|---|---|---|---|
| Coorie Doon | 7 | 1.0 | 0 | 89 | 24 | 1 |
| Little Feather | 7 | 0.151 | 0.849 | 648 | 50 | 1 |
| Stay Belfast | 7 | 0.349 | 0.651 | 109 | 25 | 2 |
| Yo's House | 7 | 1.0 | 0 | 88 | 39 | 1 |

Note the degeneracy: `heldTooHigh` counts every currently-available night in the next 7
days (`learnings.ts:99-112`), and `heldTooLow` requires an engine-snapshot min
(`learnings.ts:126-135`), so hostaway-scan tenants are pinned at 1.0/0.0 and the
snapshot-bearing tenants swing the other way. These ratios are artefacts of data
availability, not client behaviour, and they are what feeds both the client rules and the
global regret mean (currently folding ~1.0s and ~0.85s into one number).

---

## 4. Also observed (for the synthesiser; overlaps other agents' remits)

- **Prod brief correction:** two tenants DO have PriceLabs keys live. Query: engine
  snapshots by tenant → Stay Belfast 156 (26 listings × 6 days), Little Feather 288 (48 ×
  6), engine=`pricelabs`, 2026-06-28 → 2026-07-03. `engine_changes` = 0 so learning #5 is
  still empty (no lever moved beyond epsilon in 6 days, or diffing needs longer), but "all
  tenants on hostaway-scan" is not the live state. Snapshot mapping is leaky: Stay Belfast
  has `listing_id` on only 90/156 snapshots (58%), which contributes to its rung-3 collapse.
- **Missing tenants:** Escape Ordinary and Demo Property Manager have no observation
  window/profile despite `ensureObserveSchedules` registering all tenants at boot
  (`observe-worker.ts:73-77`). Schedules are only registered at worker boot, so tenants
  created (or deleted and re-created with a new id) after the last restart are silently
  unobserved, and stale tenantId schedules throw "tenant not found"
  (`observe-service.ts:110`) until the next boot. This plus the 14 orphaned global samples
  is consistent with tenant churn after the 2026-06-27 deploy. Agent 5 should confirm from
  worker logs.

---

## 5. The missing closed loop, designed for this codebase

The pieces below are ordered so each is independently shippable. All are additive; none
touch `src/lib/hostaway/**` or the cancelled-pace logic.

### 5.1 Stop destroying the history (prerequisite, S)
Replace the delete-and-regenerate at `suggestions.ts:181` with supersession: mark prior
pending rows `status = "superseded"` (add to the status enum comment) instead of deleting.
Alternatively (leaner): before `deleteMany`, append rows to a new `SuggestionSnapshot`
table. Without this, no retrospective evaluation is ever possible; with it, every day of
the silent window becomes backtest data.

### 5.2 An action path (S)
A key-gated POST (same `OBSERVE_READOUT_KEY` pattern as the existing routes) or a minimal
UI writing `status` transitions `pending → approved → applied` (and `rejected`), stamping
`detail.actionedAt`, `detail.actionedBy`, and, when Mark edits the number before applying,
`detail.appliedValue`. **Rejections and edits are labelled training data for goal 3 and
worked examples for goal 2** and cost nothing to capture. Applying (Phase 5) additionally
writes `PushLog` as designed.

### 5.3 The outcome table and re-scorer (M) – the core of the loop
New model `SuggestionOutcome` (tenant-scoped, `@@index([tenantId, ...])` per CLAUDE.md):

```
suggestionId, tenantId, listingId, stayDate,
appliedAt, appliedValue, oldValue,          -- from the suggestion at apply time
leadDaysAtApply, expectedFillAtApply, dropPct,
outcome        -- filled | expired_empty | cancelled_after_fill
bookedAt, realisedRate, hoursApplyToBook,
counterfactual -- peer-control fill on same dates (rung + peer fill rate), nullable
revenueDelta   -- realisedRate − counterfactualExpectedRate, nullable
scoredAt
```

A re-scorer job on the existing weekly settle (`runWeeklySettleForTenant`,
`observe-service.ts:193-220`, which already exists for "settled" data) processes every
`applied` suggestion whose `stayDate` + 2 days < now:
- **filled**: a `NightFact` with `isOccupied` on (listingId, stayDate); realised rate from
  `revenueAllocated`; `hoursApplyToBook` via the reservation's `createdAt`; re-check
  `Reservation.cancelledAt` on later passes and flip to `cancelled_after_fill` (this is the
  missing cancellation re-link from H5, done at outcome level rather than by touching the
  48h attribution).
- **expired_empty**: stay date passed with no occupied NightFact.
- **counterfactual**: the `PeerControl` already attached to the drop's `RateChange` (finally
  a consumer for hop 4); compute control fill on the same dates from `NightFact` for the
  `controlListingIds` – this is exactly the un-called `pickupVelocity`
  (`learnings-core.ts:20`) and populates `movedPickup`/`controlPickup` at last.

### 5.4 Outcome-driven sizing and confidence (M)
New single-row-per-bucket model `DropOutcomeStat` keyed by
`(tenantId | "global", leadTimeBucket, dropPctBand, dateType)` with counts: `applied,
filled, filledWithin48h, expiredEmpty, cancelledAfterFill, meanRealisedPctOfOld`. The
weekly re-scorer upserts it from `SuggestionOutcome` (idempotent recompute-from-scratch each
settle, per the recompute discipline that has served this app well).

Then replace the constants with shrunken empirical values:
- `confidence = (filled + α) / (applied + α + β)` with prior α/β chosen so that at n = 0 it
  reproduces today's hand value for that bucket (the hand formula becomes the prior, not
  the answer). Report `n` alongside confidence everywhere it is displayed.
- `dropPct`: choose the band with the best `meanRealisedPctOfOld × fillRate` for the
  bucket, clamped to today's 5-25% envelope, falling back to the current formula until
  `applied ≥ 20` in that bucket. Even this crude win-rate table beats hand constants
  because it moves when the world does, and it is teachable (goal 2: "we drop 10% at 15-30
  days out on weekdays because 34 of 41 such drops filled at 93% of the old rate").

### 5.5 Contamination guard before Phase 5 ever switches on (M, gating)
Once the app's own pushes move prices, the rate scanner will observe them and the learner
will study its own hand. Two guards, both with codebase precedent:
1. **Provenance tagging**: when a push happens, record (listingId, date, pushedAt) via
   `PushLog`, and have the observe learnings exclude (or separately label) `RateChange`
   rows matching a PushLog within the scan interval – the exact pattern of the rate-copy
   exclusion already in `scan-service.ts:163-196` and `inferEngineChangeSource`'s "mark"
   source (`snapshot.ts:83-100`). Self-caused changes are evaluated ONLY through
   `SuggestionOutcome`, never through the "what does the human method do" learnings.
2. **Holdout nights**: apply approved suggestions to a deterministic ~80% of at-risk nights
   (hash of listingId+date), leaving 20% untouched as within-portfolio controls. This gives
   rung-3 tenants their first real counterfactual and is the minimum honest answer to "did
   the drop cause the fill". Coordinate the exact split with Agent 2's measurement design.

### 5.6 Fix the global aggregate (S)
Replace the incremental fold with a recompute: on each settle, read the **latest profile
per tenant** and rebuild the global doc from those (equal weight per client, per-field
sample counts, keyed by segment: market/city and property type, which `Listing` already
carries). This one change fixes the run-count weighting, the orphaned dead tenants, and the
staleness, and keeps `anonymiseForGlobal`'s whitelist untouched. The incremental
`mergeGlobalMethodology` can stay for tests but should stop being the production path.

---

## 6. Fine as it is – leave alone

- **The substrate.** `RateState → RateChange` diffing, the 48h attribution writer, and the
  tenant-scoped, additive, cascade-clean schema design are solid. 554k rate changes and
  1,922 attributions in a week is a real dataset. Do not rebuild it; consume it.
- **`anonymiseForGlobal`'s whitelist** (`global-methodology.ts:40-60`) with its leak test is
  exactly right and should survive any redesign of the aggregation behind it.
- **The silent window as a product decision** (suggestions gated, observation not:
  `observe-service.ts:152-155`) is sensible. §7.1 below makes the silence earn its keep,
  but the gate itself is fine.
- **Snapshot capture + diff + source inference** (`snapshot.ts`) is the right shape for
  learning #5; it is starved of engine-change events, not wrong.
- **Idempotency discipline** (peer-control attach, attribution upserts, prune-then-re-add
  schedules) is consistently good.

---

## 7. Improvement ideas beyond the current design and the listed hypotheses

1. **Shadow-mode scoring during the 30 silent days.** Generate suggestions internally from
   day 1 (never shown, flagged `shadow`), and re-score them with the §5.3 re-scorer as
   their stay dates pass. The observation window then produces a calibration report at
   graduation: "had we acted, X of Y drop suggestions would have filled, at Z% realised".
   Day-30 stops being a leap of faith and becomes the first evidence Mark sees, which is
   also the single best trust-builder for goal 3. Currently the 30 days produce recomputed
   descriptive stats and nothing testable.

2. **Mine the 554k historical rate changes as labelled episodes now, instead of waiting a
   season for prospective outcomes.** Every past drop already has: size, lead time, date
   type, whether the night filled (`NightFact`), at what realised rate, and often the
   attributed booking (`BookingRateContext`). A one-off episode-extraction job (stratified
   sample across lead-time × drop-size buckets, not `attachControlsForRecentChanges`'
   most-recent-50-per-day, which covers ~1.5% of drops with recency bias) can bootstrap the
   §5.4 `DropOutcomeStat` table from a year of Mark's own manual method in a single run.
   This is the fastest route to goal 1 (evidence for the method Mark already runs) and it
   requires zero new observation time.

3. **Per-field sample sizes and a stability index on ClientProfile.** `revision` counts
   recomputations, not learning. Add to each profile field its `n` and a run-over-run
   delta; declare a field "settled" only after k stable runs, and have the readout render
   settled vs unsettled fields differently. Cheap, and it directly serves goal 2: a
   trainee can see which numbers are load-bearing and which are still noise. It also
   exposes degeneracies like the current heldTooHighPct = 1.0 artefacts (§3/H4) instead of
   codifying them as client "rules".

4. **Make rejection a first-class learning signal (active learning on Mark).** Every
   suggestion Mark rejects or edits is a labelled boundary example of the method the system
   is trying to codify. Store the rejection reason as a one-tap category (too deep / too
   early / event night / owner constraint / wrong listing) plus optional free text on the
   §5.2 action path, and fold the tallies per bucket into `DropOutcomeStat` as a veto
   prior. This is how goals 2 and 3 converge: the categories become the training decision
   tree's branch labels, and the app learns Mark's judgement rather than only the market's.

5. **Schedule registration should react to tenant changes, not worker boots.** Register or
   prune observe repeatables when tenants are created/deleted (or reconcile hourly),
   rather than only in `ensureObserveSchedules` at boot (`observe-worker.ts:67-82`). Two of
   six prod tenants are currently invisible to the learner for exactly this reason (§4),
   and with the global doc's unbounded memory (§3/H4c) every churned tenant leaves a
   permanent ghost in the methodology.

---

## 8. Ruling summary

| Hypothesis | Ruling | One-line evidence |
|---|---|---|
| H1 (no closed loop) | CONFIRMED | No status writer, GET-only routes, pending rows deleted daily (`suggestions.ts:181`), no outcome re-scorer; PeerControl/GlobalMethodology write-only; push_logs = 0. |
| H3 (hand constants) | CONFIRMED | `suggestions.ts:76,83`, `peer-ladder.ts:30`, `client-profile.ts:44-46`, `learnings-core.ts:74,80,150` – nothing in any pipeline updates any of them. |
| H4 (global half) | CONFIRMED+ | Run-weighted running mean (42 samples ≈ 7 runs × 6 clients), permanent orphan contributions from deleted tenants (14/42), cross-market blending, and zero consumers. |
