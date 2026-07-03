# Observe-and-learn review – the verdict

Synthesiser (Agent 7), 2026-07-03, branch `review/observe-learn-2026-07`. This is the ruling
across six specialist reviews (files 01–06 in this directory carry the detail and every query).
Where agents conflicted I rule below and say why. Prose: UK English, no em dashes.

## Two provenance corrections, up front

**1. There is no spec.** `SIGNALS-OBSERVE-LEARN-SPEC.md` and the build prompt were never
committed and are absent from git history (verified independently by Agents 1, 3, 4 and 6).
Every "spec says" comment in `src/lib/observe/**` is unverifiable; the code and
`OBSERVE-LEARN-RUN-SUMMARY.md` are the only record of the design. For goal 2 this is itself a
finding: no written statement of the method exists anywhere.

**2. The brief's live state was wrong in two ways.** (a) Not all tenants are on hostaway-scan:
Little Feather and Stay Belfast have live PriceLabs keys (444 `pricelabs` engine_snapshots over
six days; Agents 3, 4, 5, 6 all confirmed). Learning #5 is still empty everywhere, but for two
different reasons (no keys for Coorie Doon and Yo's House; a diff that watches only
base/min/max/min_stay, which varied on 0 of 74 listings, while `recommended_base` varied on 19
of 74 and is not diffed – Agent 5 §1). (b) The "missing 5th tenant": Agent 5's forensics rule.
Six tenants ran 2026-06-28 to 2026-07-03; Escape Ordinary and Demo Property Manager were
**deleted and recreated today** (created_at 2026-07-03 14:38 and 19:49, after the 04:30 run),
cascading away their windows and profiles. Their 14 contributions remain permanently baked into
the global doc (42 merges, only 28 attributable to survivors), the stale queue jobs for the dead
tenant ids will throw daily from tomorrow, and the new ids are unobserved until a worker restart
because schedules register only at boot (`src/workers/observe-worker.ts:67-99`). Agent 1's
"created after last boot" guess was directionally right; Agent 5 has the full mechanism.

## The three goals

**Goal 1 – a defensible, evidence-based method: not on track as designed.** The system measures
no outcome of any price move. The one causal comparison in the design (moved vs control pickup)
has never executed: `pickupVelocity` (`learnings-core.ts:20`) has no production caller and all
1,150 prod `peer_controls` rows have `moved_pickup`/`control_pickup` NULL (Agents 1, 2, 3, 5, 6,
same query, same numbers). No revenue delta exists anywhere. The evidence needed to score
suggestions retrospectively is deliberately destroyed daily (`suggestions.ts:181` deletes all
pending rows each run). Of the seven learnings, one is real (lead time), one is dead
(`daily_aggs` = 0 rows kills pricing power), one is degenerate (regret percentages sum to 1 by
construction, `learnings.ts:154-156`), one is erased weekly (fee drag overwritten with null by
the next daily run), and #1/#5 have never produced a sample. Drops are currently validated by
nothing at all.

**Goal 2 – train people on the method: not on track as designed.** Agent 4 ran the honest test
(`methodology-draft-v0.1.md`): the Tuesday-morning procedure cannot start (no output before
day 31), and what the system codifies would teach falsehoods. Both headline client rules are
data artefacts: `tolerates_empty_premium` fires at exactly 1.0 for both keyless tenants because
`held_too_low` needs an engine-snapshot min they cannot have, and Little Feather's
`below_min_short_window` (0.849) is built from £0–5/night artefact rows and student long-lets
compared against a gross nightly min (Agent 6, narrative 5) – a learned below-min permission
minted from a unit mismatch, whose description ("short booking windows") contradicts its own
trigger (lead >= 1.5x median, i.e. long windows). No worked examples, no counterexamples, no
denominators. The one genuinely teachable artefact is the per-client lead-time table.

**Goal 3 – train the app: not on track as designed, but nearest to rescue.** The governance
shell is exactly right and must be kept: pending-only suggestions, human approval, the 30-day
silent window (Agents 1, 2, 3 all say leave alone). But there is no mechanism by which the app
can improve: no writer for approved/rejected/applied anywhere (GET-only routes), no outcome
re-scorer, and every constant a suggestion carries (drop size, confidence, rung confidence) is
a source-code literal nothing updates (H3). Worse, the first live output is on course to destroy
trust on schedule: all four windows graduate the same morning, 2026-07-28, five days before
Fleadh Cheoil, and the generator is event-blind with no minimum-price clamp
(`suggestions.ts:76-77`), so the first batch would propose ~20% drops at confidence 0.81 on
nights `trial-events.ts` prices at +50%, sorted to the top because event rates inflate
`revenueAtRisk` (Agent 6, narrative 6, with the arithmetic).

## Hypothesis rulings

**H1 (no closed loop) – CONFIRMED.** No status writer, pending rows deleted daily, PeerControl
and GlobalMethodology write-only, push_logs = 0, no outcome re-scorer (Agents 3, 6). The loop is
open at both ends.

**H2 (validated by velocity only, never revenue) – CONFIRMED, worse than stated.** Agents 1 and
6 say CONFIRMED-worse; Agent 2 says PARTIAL because the premise "velocity only" is generous. The
substance is unanimous and I rule CONFIRMED in the worse direction: not even velocity is
computed (0 of 1,150 controls carry a pickup measurement), and no revenue comparison exists.
Agent 2's PARTIAL is a labelling quibble, not a disagreement.

**H3 (hand constants in a learning costume) – CONFIRMED.** `suggestions.ts:76,83`,
`peer-ladder.ts:30`, `client-profile.ts:44-46`, `learnings-core.ts:74,80,150`: nothing in any
pipeline updates any of them (Agents 2, 3, 6). The only learned input to a suggestion is the
lead-time curve.

**H4 (no causal recipes) – CONFIRMED, with two aggravations.** The global doc is running means
and vote tallies with no condition/action/rationale (Agent 4, prod revision 42). Aggravation
one: the aggregation is invalid anyway – run-count weighted (samples = 42 from at most 6
clients), permanently polluted by deleted tenants (14/42), cross-market blended, and read by
nobody but its own updater (Agent 3). Aggravation two: the one rule type that exists produced a
live rule whose description contradicts its trigger (Agent 6).

**H5 (untested attribution and ladder validity) – CONFIRMED.** 48h is an underived constant
mechanically satisfied by daily engine repricing (80–204 changes per moved-listing-day, so a
qualifying change nearly always exists; median hours_since_change 9.8h is scan cadence, not
causation). 888/1,150 controls (77%) are rung 3 with an empty control set and nothing computed;
rung 2 has never fired; the only rung-1 control set is a static-priced student block; 70/684
attributed reservations later cancelled with no re-link (Agent 2).

**H6 (cannot tell RMS moves from Mark's) – PARTIAL: premise overturned, conclusion confirmed
and sharpened.** Agents 5 and 6 agree on substance; I adopt Agent 5's PARTIAL label because the
brief's factual premise (no keys anywhere) is wrong. The conclusion survives and worsens: 0
engine_changes means `inferEngineChangeSource` has executed zero times in prod; `rate_changes`
has no source column at all (0 of 554,431 moves attributable); and even when a lever eventually
moves, the 24h source window against a daily-refreshing engine classifies nearly everything as
"engine" (Agent 6, failure mode 10). The Mark-vs-engine extraction cannot happen with this
design, keys or no keys.

**H7 (blind to the far-out strategy) – CONFIRMED, quantitatively.** Only one suggestion type
exists (a drop); the trigger needs expectedFill >= 0.5, which live median leads put at ~24–50
days, so days 51–120 of the horizon are unreachable by construction; suggestions rank premium
empty nights first; and the one market signal already captured (PriceLabs `market_occ_next_30/60`,
`recommended_base`, 156/312 prod rows) is read nowhere (Agent 1). The system automates the
tactical tail only, and only its downward half. It also holds learnings that contradict the
philosophy (`cheaper_cancel_more`; held_too_low defined as early+cheap) without noticing
(Agent 6, narrative 7) – the philosophy itself is currently unfalsifiable by this system.

## Top findings, ranked by impact on the goals

1. **No outcome measurement exists anywhere** (goals 1 and 3). Zero measured pickups, zero
   revenue deltas, suggestion history destroyed daily. Everything else is downstream of this.
2. **The graduation-day trust bomb** (goal 3). Four tenants graduate together on 2026-07-28
   into Fleadh week with an event-blind, floorless, compounding drop generator. This is the
   only finding with a hard deadline.
3. **Degenerate regret has already minted policy** (goals 1 and 2). Percentages sum to 1;
   keyless tenants pinned at 1.0; LF's below-min permission built on artefact rows. These rules
   are live in prod profiles today and Phase 5 is designed to enforce them.
4. **The learnings and the suggestions are disconnected** (all goals). The generator consumes
   one of seven learnings; ClientProfile's only reader is the display layer; GlobalMethodology
   is read by nobody. The system does not act by its own strategy doc.
5. **Silent per-tenant death plus global-doc pollution** (operational). Two tenants unobserved
   until a worker restart, stale jobs throwing daily from tomorrow, deleted tenants permanently
   averaged into "market truth", and no alert surfaced any of it.
6. **The control substrate is measuring the RMS noise floor** (goal 1). Median detected "drop"
   ~0.9%; every listing is a "mover"; coverage 0.9% of drops concentrated on 9 listings; scan
   tenants structurally cannot leave rung 3 while 134k `rate_states` rows sit unused.
7. **The far-out half of Mark's method is invisible** (goal 1's biggest experiment has no
   instrumentation), while captured market signals go unread.

## What is fine – leave it alone

Unanimous across agents: the trust architecture (pending-only, human gate, 30-day silent
window); the rate-scan substrate and attribution plumbing (idempotent, tenant-scoped, 554k
changes and 1,922 attributions in weeks – consume it, do not rebuild it); the
`anonymiseForGlobal` whitelist and key hygiene; snapshot capture and diff mechanics as
engineering; the pure-core/DB-wrapper split with unit tests; lead-time learning #2 (the one
load-bearing learning – fix its occupancy scaling, keep it); the daily cadence itself (six clean
runs, no dupes, no stale leakage for registered tenants); the suggestion cap and
money-ordering in spirit. Cancelled-pace logic and `src/lib/hostaway/**` were out of scope and
no agent proposed touching them.

## The single most important next action

Ship the suggestion safety gates (min floor, event shield, no-compounding memory, history
preservation) **before 2026-07-28**. Everything else can proceed at its own pace; that date
cannot.
