# Agent 4 – Teachability review (the Goal 2 test)

Persona: methodology codifier and trainer. Question: could a new team member learn Mark's
daily-drop method from what this system captures and emits? Method: pulled the real prod
`client_profiles` and `global_methodology` rows (SELECT-only, 2026-07-03), read the live
readout endpoint, then attempted to write the Tuesday-morning decision procedure a new hire
would follow. The attempt, with its gaps marked inline, is delivered as
`reviews/observe-learn-2026-07/methodology-draft-v0.1.md`. This file is the analysis behind it.

A note on sources: the code cites `SIGNALS-OBSERVE-LEARN-SPEC.md` throughout (e.g.
`src/lib/observe/client-profile.ts:2`, `src/lib/observe/global-methodology.ts:2`), but that
file does not exist in the repo or its git history (verified: `ls` and
`git log --all --diff-filter=A` both return nothing). For Goal 2 this matters directly: the
only written statement of the method the system is meant to codify is a build log
(`OBSERVE-LEARN-RUN-SUMMARY.md`), which describes what was built, not how to price. There is
currently **no document in existence a trainer could hand to a new hire**, which is exactly
why this exercise was run.

---

## 1. What the system actually contains, one week in (prod, 2026-07-03)

Query: `SELECT t.name, cp.revision, cp.updated_at FROM client_profiles cp JOIN tenants t ON
t.id = cp.tenant_id` → 4 rows, all revision 7, all updated 2026-07-03 04:30. Clients:
Coorie Doon Stays, Little Feather Management, Stay Belfast, Yo's House & Short Stay Harrogate.

The "missing fifth tenant" flagged by the orchestrator is resolved: `SELECT name, created_at
FROM tenants ORDER BY created_at` shows **Escape Ordinary was created 2026-07-03 14:38 UTC**
(today, after the 04:30 run) and Demo Property Manager at 19:49. Neither has a window because
neither existed at the last run. Side finding: `ensureObserveSchedules` registers repeatables
only at worker boot (`src/workers/observe-worker.ts:67-77`), so Escape Ordinary will not be
observed until the worker restarts. A new client silently not being observed is itself a
teachability hazard (the trainer says "check the profile" and there is none).

Full profile payloads (query: `SELECT t.name, jsonb_pretty(cp.profile::jsonb) FROM
client_profiles cp JOIN tenants t ...`), summarised:

| Field | Coorie Doon | Little Feather | Stay Belfast | Yo's House |
| --- | --- | --- | --- | --- |
| engine | hostaway-scan | pricelabs | pricelabs | hostaway-scan |
| medianLeadDays | 24 | 50 | 25 | 39 |
| regret heldTooLowPct | 0 | 0.849 | 0.651 | 0 |
| regret heldTooHighPct | 1.0 | 0.151 | 0.349 | 1.0 |
| regret total | 89 | 648 | 109 | 88 |
| pricingPower | null | null | null | null |
| engineReaction fractions | all 0 | all 0 | all 0 | all 0 |
| feeDragPct | null | null | null | null |
| cancellationSignal | cheaper_cancel_more | cheaper_cancel_more | cheaper_cancel_more | cheaper_cancel_more |
| rules fired | tolerates_empty_premium | below_min_short_window | both | tolerates_empty_premium |

Global methodology (query: `SELECT revision, jsonb_pretty(methodology::jsonb) FROM
global_methodology`) → revision 42, `samples: 42`, `medianLeadDays: 35.69`
(`medianLeadSamples: 35`), regret `0.383 / 0.617` (35 samples), `pricingPowerVotes: {}`,
`engineReactionByEngine.pricelabs`: all-zero fractions over 21 samples, `feeDragPctMean:
0.0130` (5 samples), `cancellationSignalVotes: {cheaper_cancel_more: 35}`.

Suggestions: `SELECT count(*) FROM suggestions` → **0** (all clients day 5/30, nobody
graduated). Readout endpoint returns the four windows, `status: observing, daysObserved: 5`.

## 2. The Tuesday-morning test: where the procedure breaks

The full attempt is `methodology-draft-v0.1.md`. The breaks, in order of severity:

**Break 1 – the procedure cannot start.** Suggestions are the only per-night, actionable
output, and they exist only after day-30 graduation (`src/lib/observe/observe-service.ts:152-155`)
and only via a key-gated JSON route or a one-shot day-30 email. Before day 31 the system gives a
new hire nothing to act on; after day 31 it gives up to 50 rows with no floors, no context, no
follow-up step.

**Break 2 – the two headline "client rules" are data artefacts, so training on them teaches
something false.** `computeRegret` counts *every* forward available night in the next 7 days as
`held_too_high` (`src/lib/observe/learnings.ts:110-112`) with no reference to a booking curve,
and sets `none: 0` so the two regret percentages always sum to 1
(`src/lib/observe/learnings.ts:154-156`; the unit-tested `classifyRegret` core with its `none`
label, `learnings-core.ts:83-107`, is never called by the wrapper). Meanwhile `held_too_low`
requires a per-listing min from `EngineSnapshot` (`learnings.ts:126-136`), and hostaway-scan
clients have **zero** engine snapshots (prod: snapshots exist only for Little Feather 288 and
Stay Belfast 156; none for Coorie Doon or Yo's House). Result, visible in the data: both
hostaway-scan clients show `heldTooHighPct = 1.0` exactly, so "tolerates empty premium nights
to the wire" fired for them **because the min data is missing, not because of any observed
behaviour**. And because the two pcts sum to 1 against thresholds of 0.15 and 0.25
(`client-profile.ts:44-46`), at least one rule fires for essentially every client, and both
fire together for Stay Belfast, describing opposite habits at once. Rules that always fire
teach nothing; rules that fire on artefacts teach the wrong thing.

**Break 3 – the learning that locates the premium is structurally dead.** `computePricingPower`
reads `DailyAgg` (`learnings.ts:75-79`) and prod `daily_aggs` has **0 rows** (`SELECT count(*)
FROM daily_aggs` → 0). So `pricingPower` is null for every client, forever as built, and the
readout section "Pricing power by date type" will always render "n/a". Separately, even if the
table were populated, `dateTypeFor` (`learnings.ts:33-39`) can never return `"event"`, so event
pricing power (the single most teachable "when to hold" rule, and the one the Fleadh trial
already exercises) is unlearnable by construction.

**Break 4 – the learned strategy is never consulted by the decision-maker.** The only reader of
`ClientProfile` in the entire codebase is the display layer (`src/lib/observe/readout.ts:54`);
`generateSuggestionsForClient` uses only `computeLeadTime` (`suggestions.ts:150`) and ignores
the profile, its rules, and `GlobalMethodology` (which is read by nobody but its own writer,
`global-methodology.ts:173,186`). For a trainer this is fatal: the system's stated method
("build the client's strategy doc, then act by it") is not the method the system itself
follows, so you cannot teach by pointing at what it does.

**Break 5 – the numbers a trainee would recite are miscalibrated or denominator-free.**
`expectedCumulativeFill` (`suggestions.ts:29-37`) treats the lead-time distribution of
*bookings that happened* as a fill probability for *nights*: "curve expects ~62% booked by now"
actually means "62% of eventual bookings typically land at least this far out", which is only
the same thing at 100% final occupancy. The drop size (5-25% band, `suggestions.ts:76`) and
confidence (`min(0.9, expectedFill)`, `suggestions.ts:83`) are unexplained constants that
appear in no emitted document. Profile percentages carry no n, no window, no denominator
(e.g. Coorie Doon's `heldTooHighPct: 1` is actually "89 unbooked listing-nights across 46
listings in the next 7 days"). And there is **no minimum-price clamp** on `proposedValue`
(`suggestions.ts:77`), so the emitted procedure, followed literally, prices through floors.

**Break 6 – nothing tells the trainee what happened next.** No suggestion→outcome record
exists, so there are no worked examples, no counterexamples, and no way to show a new hire
"here is a drop that worked, here is one that did not". Every apprenticeship runs on exactly
those. (This overlaps H1, Agent 3's remit; flagged here for its teaching consequence.)

## 3. Hypothesis ruling

**H4 – CONFIRMED.** The prod `global_methodology` doc (revision 42) contains only running
means and vote tallies (shape defined at `global-methodology.ts:62-74`): lead-time bucket
means, a mean-of-medians lead time, regret pct means, an empty `pricingPowerVotes`, all-zero
engine-reaction fractions, a fee-drag mean, and a unanimous cancellation vote. There is no
condition, no action, no rationale, no "when X, do Y, because Z" anywhere in it. The nearest
things to recipes in the whole system are (a) the three `ClientRule`s
(`client-profile.ts:83-124`), of which two fire on artefacts (Break 2) and none are consulted
by the suggestion engine (Break 4), and (b) the suggestion reason string
(`suggestions.ts:84`), which is a genuine partial "because" but covers only the trigger, not
the size, the floor, or the follow-up. Additional teachability note on the aggregate itself:
`samples: 42` counts client-runs, not clients (the same 4-6 clients are re-folded every day
by `accumulateLearning`, `observe-service.ts:75`), so a reader who takes "42 samples" or
"35 medianLeadSamples" as an evidence base is off by an order of magnitude.

## 4. What is fine, leave it alone

- **Lead-time learning (#2) is real and teachable.** Medians of 24/25/39/50 days across the
  four clients are plausible, meaningfully different, and precisely the kind of per-client
  fact a trainer wants ("Little Feather books at 50 days median; Belfast at 25 – a Belfast
  empty night 30 days out is not yet a problem; a Little Feather one is"). Keep as-is.
- **The suggestion reason string** (`suggestions.ts:84`) is the right idea, just underfed.
  Extend it; do not replace it.
- **The readout HTML skeleton** (`readout.ts:85-137`) is the right shape for a per-client
  one-pager (strategy, rules, suggestions in one page). Its problem is what feeds it, not
  its structure.
- **Anonymisation whitelist** (`global-methodology.ts:40-60`) and key hygiene are well built
  and irrelevant to change here.

## 5. What must be captured or emitted for the method to become teachable

1. **A structured decision trace on every suggestion** (extend `Suggestion.detail`, which
   already exists in the schema, `prisma/schema.prisma:839`): inputs (night, lead, curve value
   with its denominator, floor, client rules checked and their pass/fail), the rule that
   fired, the size computation, the expected outcome, and a review-by date. Rendered as one
   plain-English paragraph per row.
2. **Make the suggestion engine consume the profile it writes** (floors from engine snapshot
   min or pricing settings; `below_min_short_window` / `tolerates_empty_premium` as actual
   branch conditions). Until the system acts by its own strategy doc, the doc is decoration.
3. **Fix regret semantics before anyone is trained on it**: benchmark `held_too_high` against
   the expected curve (the machinery already exists in `expectedCumulativeFill`), restore the
   `none` class, and suppress `held_too_low` when min data is absent rather than silently
   returning 0.
4. **Populate or replace the pricing-power source** (`daily_aggs` is empty; either wire the
   aggregation or compute from `NightFact`+`CalendarRate` directly) and route trial events
   into `dateTypeFor` so "event" is reachable.
5. **Denominators on every emitted number**: change the doc types so a percentage cannot be
   emitted without `{value, n, window}`.

## 6. Improvement ideas beyond the current design and hypotheses

1. **Shadow-Mark agreement scoring (the training exam).** Mark's real daily drops are already
   observable (rate-scanner `RateChange` with rate-copy exclusion; 554k rows in prod). Run the
   suggestion engine silently every morning regardless of graduation, then score agreement:
   nights where Mark dropped and the system would have, where he dropped and it would not, and
   vice versa, with size deltas. That agreement report is simultaneously (a) the honest measure
   of whether the codified method matches the actual method, (b) the graduation exam for a new
   hire ("you pass when you match Mark on 80% of nights and can explain the disagreements"),
   and (c) the trust gate for Goal 3. No new capture burden; it reuses existing tables.
2. **A counterexample library.** Auto-capture nights where the method's prediction failed
   (flagged at-risk but booked at full rate before any drop; not flagged but went empty) as
   annotated, dated examples attached to the rule that misfired. Teachable methods document
   their failure modes; every operational playbook that survives contact with staff has a
   "when this rule is wrong" section, and this system could write its own.
3. **A weekly playbook changelog instead of a one-shot day-30 email.** Profiles already carry
   revisions (7 in prod). Emit, weekly, a diff-based page per client: which numbers moved,
   which rules appeared or lapsed, and why (which underlying counts changed). Training then
   becomes "read the changelog each Monday", and a stale or oscillating rule becomes visible
   instead of silently overwritten. The day-30 email becomes just the first entry.
4. **"Why not" negative examples in every readout.** Alongside the top-50 at-risk nights, emit
   the top 5 nights that were *considered and held* with their reasons ("empty at 40d but
   Belfast curve expects only 31% by now – hold"). Trainees learn restraint from negative
   examples; the current output only ever teaches dropping.

## 7. Data appendix (queries run, read-only, 2026-07-03)

```sql
SELECT t.name, cp.client_key, cp.revision, cp.updated_at FROM client_profiles cp JOIN tenants t ON t.id=cp.tenant_id;
-- 4 rows, all revision 7, updated 2026-07-03 04:30
SELECT t.name, jsonb_pretty(cp.profile::jsonb) FROM client_profiles cp JOIN tenants t ON t.id=cp.tenant_id;
-- payloads as tabulated in section 1
SELECT revision, updated_at, jsonb_pretty(methodology::jsonb) FROM global_methodology;
-- revision 42, samples 42, values as section 1
SELECT name, created_at FROM tenants ORDER BY created_at;
-- Escape Ordinary 2026-07-03 14:38, Demo 2026-07-03 19:49 (both post-run today)
SELECT t.name, ow.started_at, ow.days_observed, ow.status FROM observation_windows ow JOIN tenants t ON t.id=ow.tenant_id;
-- 4 windows, started 2026-06-28 04:30, day 5, observing
SELECT t.name, count(*), count(es.min) FROM engine_snapshots es JOIN tenants t ON t.id=es.tenant_id GROUP BY t.name;
-- Little Feather 288 (276 min), Stay Belfast 156 (114 min); none for Coorie Doon / Yo's House
SELECT count(*) FROM daily_aggs;                -- 0
SELECT count(*) FROM engine_changes;            -- 0
SELECT count(*) FROM suggestions;               -- 0
SELECT t.name, pc.rung, count(*) FROM peer_controls pc JOIN tenants t ON t.id=pc.tenant_id GROUP BY t.name, pc.rung;
-- CD rung3 250; LF rung1 262 + rung3 38; SB rung3 300; Yo rung3 300
SELECT t.name, count(*) FROM night_facts nf JOIN tenants t ON t.id=nf.tenant_id
  WHERE nf.is_occupied AND nf.lead_time_days IS NOT NULL AND nf.date >= CURRENT_DATE-365 GROUP BY t.name;
-- CD 11,358; EO 13,519; LF 25,989; SB 4,519; Yo 8,005
```

Note against the shared brief: prod is **not** all on hostaway-scan. Little Feather and Stay
Belfast resolve to `pricelabs` with working keys (profiles say `engine: pricelabs`; 288/156
engine snapshots exist, 48 and 26 per day matching the PriceLabs account listing counts).
`engine_changes = 0` because no lever has moved beyond epsilon in the six captured days, not
because capture is dead. Coorie Doon and Yo's House are on hostaway-scan. Learning #5 is
starved everywhere, but for two different reasons.
