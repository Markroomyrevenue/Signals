# Agent 5 – Live data audit: is the learner actually learning, one week in?

Audit date: 2026-07-03. Live since 2026-06-27; first scheduled run 2026-06-28 04:30 UTC (05:30 London). Access: read-only SELECT against prod Postgres plus the key-gated readout endpoint. Every number below is from a query run today; every code claim cites file:line.

## Verdict in one paragraph

The plumbing works: runs fire daily at 05:30, windows advance exactly once per day, profiles are written every run, dedupe is clean. But of the seven learnings, only three (lead time, regret, cancellation) contain any signal, and two of those three are degenerate for half the tenants. Learning #1 (pickup velocity) has never been measured, #4 (pricing power) can never fire because its source table is empty, #5 (engine reaction) has recorded zero events despite live PriceLabs keys, and #6 (fee drag) is erased by the next daily run. Two tenants fell out of observation entirely today and will stay out until the worker restarts. One week in, the learner is mostly recording that it is running, not what Mark's method is.

---

## 1. Census: every observe table, per tenant, with freshness

Tenants in prod (query: `SELECT id, name, created_at FROM tenants ORDER BY created_at`):

| Tenant | created_at |
|---|---|
| Stay Belfast | 2026-04-24 |
| Yo's House & Short Stay Harrogate | 2026-04-24 |
| Coorie Doon Stays | 2026-04-25 |
| Little Feather Management | 2026-04-25 |
| **Escape Ordinary** | **2026-07-03 14:38 UTC (today)** |
| **Demo Property Manager** (`tenant_demo`) | **2026-07-03 19:49 UTC (today)** |

### observation_windows (4 rows)

All four: status `observing`, started 2026-06-28 04:30, `days_observed` 5, `last_run_at` 2026-07-03 04:30, `backfilled_at` = started_at. No window for Escape Ordinary or Demo (see §2).

### client_profiles (4 rows)

All four: revision 7, created 2026-06-28 04:30, updated 2026-07-03 04:30. Revision 7 = 6 daily runs (Jun 28–Jul 3) + 1 weekly settle (Mon Jun 29). Exact match; no missed or doubled profile writes for surviving tenants.

### engine_snapshots (444 rows)

| Tenant | engine | rows | days | listings/day | mapped to Signals listing |
|---|---|---|---|---|---|
| Little Feather | pricelabs | 288 | 6 (Jun 28–Jul 3) | 48 | 47 (1 unmapped) |
| Stay Belfast | pricelabs | 156 | 6 | 26 | 15 (**11 unmapped**, `listing_id` null) |

Two important corrections to the review brief here. First, **the orchestrator's "all tenants on hostaway-scan, no engine keys in prod" is wrong**: PriceLabs keys are live for Little Feather and Stay Belfast (snapshots with `engine='pricelabs'` require an adapter, which requires a key – registry.ts:192-199; capture no-ops without one – snapshot.ts:125-127). Both profiles also show `engineReaction.available: true`, which only happens for non-scan engines (learnings.ts:169-171). Second, Coorie Doon and Yo's House genuinely run the scan fallback (no snapshots, `engine: "hostaway-scan"` in their profiles).

Stay Belfast's 11 unmapped snapshots matter: unmapped rows are invisible to the peer ladder's base/min lookup (peer-ladder.ts:186-199, filters `listingId: { not: null }`) and to the regret min-proxy (learnings.ts:126-135).

### engine_changes: 0 rows

Six days of daily snapshots, 74 engine listings, zero change events. Root cause is in the data, not just the keys. Lever variance across the 6 days (query grouped per engine listing on distinct values):

| Tenant | listings | base varied | min varied | max varied | min_stay varied | **recommended_base varied** |
|---|---|---|---|---|---|---|
| Little Feather | 48 | 0 | 0 | 0 | 0 | **15** |
| Stay Belfast | 26 | 0 | 0 | 0 | 0 | **4** |

The diff compares only base/min/max/min_stay (snapshot.ts:38-42, 50-74). Those are user-set configuration and did not move for a single listing in six days. What the engine actually does daily – move its recommendation – lives in `recommended_base`, which varied on 19 of 74 listings and is **not diffed**. Sample listing (LF 64892): base 140, min 85, recommended 137, all six days identical, while `last_refreshed_at` advanced every day (engine refreshed daily; levers held). Learning #5 is therefore starved by design even with keys present, not only by key absence.

### peer_controls (1,150 rows)

| Tenant | rows | rung 1 (conf 0.8) | rung 2 (0.5) | rung 3 (0.3) | distinct subject listings | distinct rate_change ids |
|---|---|---|---|---|---|---|
| Coorie Doon | 250 | 0 | 0 | 250 | 4 | 250 |
| Little Feather | 300 | 262 | 0 | 38 | 2 | 300 |
| Stay Belfast | 300 | 0 | 0 | 300 | 2 | 300 |
| Yo's House | 300 | 0 | 0 | 300 | **1** | 300 |

Exactly 50 per tenant per run (CONTROL_MAX_EVENTS = 50, peer-ladder.ts:145), except Coorie Doon on Jul 2 (0 attached; its profile still wrote rev that day, so the run succeeded and the idempotent skip simply found nothing new – peer-ladder.ts:173-179).

- **`moved_pickup` and `control_pickup` are null on 1,150 of 1,150 rows.** `attachControlsForRecentChanges` never passes them (peer-ladder.ts:222-228) and `pickupVelocity` (learnings-core.ts:20) has no caller outside tests (grep across `src/`). Learning #1 – the moved-vs-control question the whole ladder exists for – has never produced a measurement.
- **Coverage is 0.9% and badly biased.** Price drops in the last 14 days: Coorie 26,058, LF 33,481, SB 22,491, Yo 46,246 = 128,276, across 15–44 distinct listings per tenant. Controls cover 1,150 of them, on 9 subject listings total. The `take: 50, orderBy detectedAt desc` slice (peer-ladder.ts:164-168) grabs whatever the latest scan wrote last; `rate_changes` are per calendar date, so 50 "events" is roughly one listing's sweep across 50 dates. Yo's 300 controls sit on a single listing.
- **Rung 3 collapse is structural for scan tenants.** The ladder sources base/min exclusively from `engine_snapshots` (peer-ladder.ts:186-191). Coorie and Yo have none, so every candidate has null base/min, `withinBand` returns false (peer-ladder.ts:47-53), and rung 3 (no counterfactual, confidence 0.3) is the only possible outcome – 100% of their 550 rows confirm it. `rate_states` (134,032 rows of live rates for all tenants) is never consulted. Stay Belfast has snapshots yet is also 100% rung 3: its two control subjects are among the 11 unmapped listings and/or every in-band peer moved within the 14-day window (movers exclusion, peer-ladder.ts:210-214 – with ~2 scans/day and 22k drops in 14 days, essentially every SB listing is a mover). Rung 1 exists only at Little Feather (262 rows, all on one listing, all with a 4-peer control set).

### suggestions: 0 rows. push_logs: 0 rows.

Correct given no client has graduated (all at day 5/30) and Phase 5 was never built.

### global_methodology (1 row)

`revision` 42, `samples` 42, `medianLeadSamples` 35, `regretSamples` 35, `cancellationSignalVotes {cheaper_cancel_more: 35}`, `feeDragSamples` 5, `engineReactionByEngine.pricelabs.samples` 21 (fractions all zero), `pricingPowerVotes` {}.

### Rate-scanner substrate (the input side)

- `rate_scans`: 20 per tenant in the last 10 days (2/day), latest today 11:02–11:06 for all four active tenants. Escape Ordinary and Demo: none (see §2).
- `rate_changes`: 554,431 total, 289,805 drops; per-tenant max detected_at today.
- `booking_rate_contexts`: 1,922 total – Coorie 671 (233 reservations), LF 629 (228), SB 292 (126), Yo 330 (97). By lever: price 1,827 (mean 14.8h since change), availability 90, min_stay 5. Accumulating since 2026-06-03 (predates observe). Freshness: LF/SB max today 06:06–06:08; **Yo's latest is 2026-06-30** – three days without a new context, worth watching but plausibly just no bookings within 48h of a change. Note 245 of the 1,922 contexts (12.7%) belong to reservations that are now cancelled (LF 120/629, Coorie 85/671, SB 30/292, Yo 10/330) and nothing re-links those cancellations to the drop that won them.

---

## 2. The missing tenants: what happened and what happens tomorrow

The brief said 5 tenants on the daily run but only 4 windows exist. The answer is tenant lifecycle, and it has already cost real data:

1. **Escape Ordinary and Demo were deleted and recreated today** (new rows created 2026-07-03 14:38 and 19:49, both after the 04:30 run). All observe models cascade on tenant delete (schema `onDelete: Cascade`, per the run summary), so their windows, profiles, snapshots and controls were wiped.
2. **The forensic trace survives in the global doc.** 42 global merges vs 28 writes attributable to the 4 surviving profiles (4 × revision 7). The only writer is `accumulateLearning` (observe-service.ts:75, sole caller of `bootstrapOrUpdateGlobalMethodology`), which always writes the profile first – so 42 merges means 42 profile writes, 14 of them to rows that no longer exist: **two deleted tenants × 7 runs each** (6 daily + Mon settle). The sub-counts corroborate: `engineReactionByEngine.pricelabs.samples` = 21 = LF 7 + SB 7 + 7 from a deleted PriceLabs tenant (old Escape Ordinary, which the run summary expected on PriceLabs); `medianLeadSamples` = 35 = five tenants with booking history × 7 (the demo predecessor contributing lead-time nothing). So six tenants ran Jun 28–Jul 3; the review brief's "5" and today's "4" are both snapshots of a moving set. Confirmable against worker logs.
3. **The deleted tenants' 7 runs each are permanently baked into the global running means and cannot be unwound** (mergeGlobalMethodology is a running aggregate, global-methodology.ts:156-168).
4. **Tomorrow's runs are broken for both ids.** Schedules are registered only at worker boot (`ensureObserveSchedules` called once in `startWorker`, observe-worker.ts:84-99) from a `tenant.findMany` (observe-worker.ts:73). The queue therefore still holds repeatables for the two dead tenant ids – those jobs will throw `observe: tenant <id> not found` (observe-service.ts:110) at 05:30 daily – and holds nothing for the two new ids. **Escape Ordinary and Demo are unobserved until someone restarts the worker**, and their 30-day clocks restart from zero when it does.

---

## 3. Are the ClientProfiles populated and sane?

Full JSON pulled for all four (query: `SELECT jsonb_pretty(profile::jsonb) FROM client_profiles`).

**Lead time – populated and plausible.** Medians: Coorie 24 days, LF 50, SB 25, Yo 39. Bucket distributions sum to 1 and differ sensibly between clients (LF 37.0% of nights booked 91+ days out vs SB 21.4%). This is the healthiest learning in the system.

**Regret – non-degenerate only where engine snapshots exist.** LF: total 648, heldTooLow 84.9%, heldTooHigh 15.1%. SB: total 109, 65.1%/34.9%. But Coorie (total 89) and Yo (total 88) are **exactly 1.000 heldTooHigh, 0.000 heldTooLow** – degenerate by construction, because heldTooLow needs a min-price proxy that comes only from `engine_snapshots` (learnings.ts:126-135), which scan tenants do not have. Meanwhile heldTooHigh counts every available unbooked night in the next 7 days as regret (learnings.ts:99-112). Consequence: the `tolerates_empty_premium` rule (threshold 0.25, client-profile.ts:94-100) fires unconditionally for every engine-less client forever. Both scan tenants carry it today; it is a tautology, not a learned divergence.

**Pricing power – null for all four, and it can never fire.** `computePricingPower` reads `DailyAgg` (learnings.ts:75-78). **`daily_aggs` has 0 rows in prod** (`SELECT count(*) FROM daily_aggs` → 0). Learning #4 is dead on arrival for every tenant and `pricingPowerVotes` in the global doc is `{}` after 42 merges. Nothing surfaced this: the profile just holds `null` and the run logs success.

**Engine reaction – all-zero everywhere.** All four profiles: fractions {claw_back 0, fight 0, hold 0, unknown 0}, dominant null. Global: 21 pricelabs samples, all zero. Follows from engine_changes = 0 (§1).

**Fee drag – computed weekly, erased daily.** `feeDragPct` is null in all four profiles today (Thursday), yet the global doc has `feeDragPctMean` 0.0130 from 5 samples – the Monday settle computed it (observe-service.ts:211 `includeNetRealised: true`), then Tuesday's daily run rebuilt the doc with `includeNetRealised: false` (observe-service.ts:144) and **overwrote the profile with null**. Learning #6 survives in a client profile for under 24 hours a week. The global keeps it only because running means never subtract.

**Cancellation signal – populated but uniform.** All four say `cheaper_cancel_more`; the global has 35 of 35 votes for it. Plausible (cheap bookings cancelling more is a common STR pattern) but with zero variance it currently discriminates nothing.

**Stability run to run – unauditable.** The profile is a single upserted row; each write replaces `profile` and bumps `revision` (client-profile.ts:148-158). No history is kept, so "are pricing-power labels stable across runs" cannot be answered from the DB at all. Only the current snapshot (revision 7) exists.

## 4. Learning starvation matrix

| # | Learning | Coorie (scan) | Yo (scan) | LF (pricelabs) | SB (pricelabs) | Cause |
|---|---|---|---|---|---|---|
| 1 | Pickup velocity vs control | never measured | never measured | never measured | never measured | no caller; 1,150/1,150 null pickups |
| 2 | Lead-time curve | OK (median 24) | OK (39) | OK (50) | OK (25) | – |
| 3 | Regret | degenerate (1.0/0.0) | degenerate (1.0/0.0) | OK-ish (648) | OK-ish (109) | min proxy needs engine snapshots |
| 4 | Pricing power | dead | dead | dead | dead | `daily_aggs` = 0 rows |
| 5 | Engine reaction | n/a (by design) | n/a (by design) | zero events | zero events | diff ignores `recommended_base`; levers static |
| 6 | Net realised / fee drag | weekly, erased daily | weekly, erased daily | weekly, erased daily | weekly, erased daily | daily overwrite with null |
| 7 | Cancellation quality | uniform | uniform | uniform | uniform | populated; zero variance so far |

## 5. Graduation and the suggestion pipeline

- Graduation is **pure calendar**: `daysObserved >= 30` (observation-window.ts:24-26, config.ts:11). There is no booking floor on graduation itself. All four active windows started 2026-06-28, so **all four graduate on 2026-07-28, the same morning**, and each will immediately write up to 50 pending suggestions (suggestions.ts:125, MAX_SUGGESTIONS) – a 4-client, ~200-suggestion day-one readout burst.
- The "20-booking floor" is actually suggestions.ts:151 – `lead.n < 20` skips generation – where `n` counts occupied NightFacts with a lead time in the trailing 365 days. Per tenant today: Coorie 11,340, LF 25,928, SB 4,514, Yo 7,992 (and Escape Ordinary 13,495). The floor passes by 2–3 orders of magnitude for everyone; it gates nothing in practice.
- Escape Ordinary and Demo graduate 30 days after the worker restart that re-registers them (restart on 2026-07-04 → graduate 2026-08-03).
- Other preconditions are healthy: drops for controls to attach to are abundant (128k in 14 days), `calendar_rates` and `night_facts` are populated (the regret computation already reads them successfully), and booking_rate_contexts accumulate daily.

## 6. Ruling on H6

**H6: PARTIAL – premise overturned, conclusion effectively confirmed and sharpened.**

- Premise wrong: not all tenants run hostaway-scan. Little Feather and Stay Belfast have live PriceLabs keys (444 pricelabs snapshots over 6 days; adapters require keys – registry.ts:192-199).
- Conclusion holds anyway, on the numbers: `engine_changes` = 0, so `inferEngineChangeSource` (snapshot.ts:83-100) – which only runs per detected diff (snapshot.ts:199-205) – **has executed zero times in production**. `rate_changes` has no source column at all (prod schema check), so **0 of 554,431 rate moves have a knowable engine/owner/mark attribution**. Learning #5 fractions are all-zero in all four profiles and in the global doc (21 samples, all zero).
- Sharpened: the starvation is structural, not just missing keys. The diff watches base/min/max/min_stay, which varied on 0 of 74 listings in 6 days, and ignores `recommended_base`, which varied on 19 of 74 – the engine's actual daily behaviour is invisible to the differ. And even when a lever eventually moves, SOURCE_MATCH_WINDOW_HOURS = 24 (config.ts:26) against an engine that refreshes daily (sample listing's `last_refreshed_at` advanced every one of the 6 days, always within 24h of capture) means nearly every change will be classified "engine"; "owner" is close to unreachable and "mark" only via the rate-copy target list. The "what did Mark do differently from the engine" extraction cannot happen with this design regardless of keys.

## 7. Dedupe and aggregation bug classes (the ones that have bitten before)

Checked explicitly:

- **Duplicate peer_controls per rate_change: 0** (`GROUP BY rate_change_id HAVING count(*)>1` → 0 rows). Idempotency works.
- **Duplicate snapshots per listing-day: none.** The 6 apparent (tenant, listing, day) duplicates are Stay Belfast's 11 unmapped engine listings sharing `listing_id` null – 26 rows/day × 6 days = 156, exact. Not double capture.
- **Profile writes: exactly 7 per tenant** (6 daily + 1 settle), no stale-run leakage, no doubling.
- **But two real aggregation defects exist at the global level:** (a) **run-count masquerading as sample-count** – every daily re-merge of the same client counts as a fresh independent sample into the running means (global-methodology.ts:156-168), so `samples` = 42 for what is at most 6 clients, and a client observed longer silently gets proportionally more weight; (b) **deleted-tenant pollution** – 14 of the 42 merges are from tenants that no longer exist and can never be subtracted.
- **The settle/daily overwrite** (feeDragPct nulled daily, §3) is a third instance of the "one row, two writers, full-replace" class already on record in memory (`project-settings-row-clobber-hazard`).

## 8. This is fine – leave it alone

- The daily cadence itself: 05:30 fired all 6 days, one advance per window per day, `days_observed` exactly matches calendar days. No missed or doubled runs for registered tenants.
- Idempotent control attachment (Coorie Jul 2 attached 0 rather than duplicating) and the prune-before-re-add schedule pattern.
- Key hygiene: the readout endpoint returns clean JSON, no key material; 404-without-key confirmed by design and the endpoint output matches the DB exactly (4 clients, day 5, correct timestamps).
- The rate-scan substrate: fresh (max scans today for all active tenants), high-volume, and booking_rate_contexts joining cleanly to reservations.
- Lead-time learning (#2): populated, plausible, per-client differentiated. Do not touch it; it is the one input the day-30 suggestions genuinely need (suggestions.ts:150-153).

## 9. Improvement ideas beyond the current design and hypotheses

1. **Tenant-lifecycle-proof scheduling.** Replace boot-time-only repeatable registration with a single daily dispatcher job that enumerates tenants at run time (or a reconcile step in each run), plus a log/alert when a scheduled tenantId no longer resolves. Today's silent loss of two tenants (§2) – and the stale jobs that will throw daily from tomorrow – is a class of failure, not a one-off: any onboarding, re-add, or demo reset repeats it, and each re-add also silently resets the client's 30-day clock.
2. **A per-run learning ledger with null-reasons.** An append-only table (tenant, run, learning, sampleCount, nullReason) written by `computeClientLearnings`, surfaced in the readout as a starvation matrix (days-since-non-null per learning per client). `daily_aggs` being empty – killing learning #4 for every client – survived six green runs unnoticed because a null learning and a computed learning look identical in the logs. This also fixes profile-stability auditing (§3) for free, since successive values become queryable.
3. **Feed the ladder and the min-proxy from `rate_states` when snapshots are absent.** 134,032 live-rate rows already exist for every tenant; using median observed rate as the band metric and observed floor as the min proxy would unlock rungs 1–2 and non-degenerate regret for scan clients with zero new API surface. Today those clients are structurally condemned to confidence 0.3 and a tautological profile rule.
4. **Sample controls by decision event, stratified per listing, not take-50-newest.** Collapse per-date `rate_changes` into events (listing × scan × contiguous date span), then sample across listings up to the cap. Current coverage is 0.9% of drops concentrated on 9 listings (one listing per tenant in the worst cases) – whatever pickup measurement eventually lands on these controls will describe a couple of noisy properties, not the portfolio.
5. **Recompute the global doc from current per-client contributions instead of running means.** Store each client's latest anonymised contribution (still no tenantId – a random stable key suffices) and rebuild the global from the ≤6 current contributions each run. This fixes run-weighting, deleted-tenant pollution, and the daily/weekly overwrite in one move, and N is tiny so cost is nil.
6. **Diff `recommended_base` (and per-date calendars) as first-class engine behaviour.** `ENGINE_CALENDAR_DAYS = 180` sits unused in config.ts:29. Recording "engine moved its recommendation by X%" – 19 of 74 listings in week one – is the only way learning #5 and the engine-vs-Mark comparison produce anything before a human happens to edit base price in the PriceLabs UI.

## Appendix: key queries

All run 2026-07-03 via `docker exec hostaway-postgres psql "$DATABASE_PUBLIC_URL"`, SELECT-only:

- Census/freshness: `SELECT t.name, count(*), min(x.created_at), max(x.created_at) FROM <table> x JOIN tenants t ... GROUP BY t.name` for each observe table (results in §1).
- Rung distribution: `SELECT t.name, c.rung, c.confidence, count(*) FROM peer_controls c JOIN tenants t ... GROUP BY 1,2,3` → LF 262@rung1/38@rung3; Coorie 250, SB 300, Yo 300 all rung 3.
- Pickup nulls: `SELECT count(*), count(moved_pickup), count(control_pickup) FROM peer_controls` → 1150, 0, 0.
- Drop volume: `SELECT t.name, count(*) FILTER (WHERE lever='price' AND change_pct<0) FROM rate_changes WHERE detected_at >= now()-interval '14 days' GROUP BY 1` → 26,058 / 33,481 / 22,491 / 46,246.
- Lever variance: distinct base/min/max/min_stay/recommended_base per engine listing across 6 days → 0/0/0/0 varied vs 19 recommended_base varied.
- daily_aggs: `SELECT count(*) FROM daily_aggs` → 0.
- Global doc: `SELECT jsonb_pretty(methodology::jsonb), revision FROM global_methodology` → revision 42, samples 42, values quoted in §1/§3.
- Duplicates: `GROUP BY rate_change_id HAVING count(*)>1` → 0; snapshot (tenant, listing, day) groups >1 → only null-listing_id groups (11 unmapped SB engine listings).
