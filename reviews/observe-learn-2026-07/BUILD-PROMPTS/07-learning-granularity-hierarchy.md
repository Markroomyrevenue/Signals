# Build prompt 07 – Learning granularity: cohort hierarchy, actual-paid signal, richer dimensions

Copy-paste this whole file into a fresh Claude Code session at the `signals` repo root.
It is written in three parts (A, B, C) that can be built by one session or three sequential ones.

## Context (self-contained; assume no memory of prior sessions)

The observe-and-learn system (`src/lib/observe/**`, live in prod) learns almost everything at
whole-client grain, pooled across all of a client's listings. The granularity audit
(`reviews/observe-learn-2026-07/07-learning-granularity.md`) proved with prod data why that
miscalibrates the daily-drop trigger: on one client, the `group:Argo` listings' median booking
lead is 54 days while `group:St James` is 3 days; Little Feather's student blocks book at 10
days lead, its flats at 21. One client-level expected-fill curve fires false drops on
late-booking stock and misses dying nights on early-booking stock. The occupancy scaler is
unit-weighted, so a ~200-unit student block drowns 50 flats. The one per-listing learner (the
peer ladder's pickup fields) has never been measured. The global doc blends cities.

Mark's direction, verbatim: "Group is good and definitely would like to know. Size of property
i.e. 1 bed, 2 bed per group, city, global etc. Any other sub group that would enrich our data -
there can be crossover. The more the system learns the better the recs will be." Plus: the
system "should also be able to check actual reservation amount via Hostaway i.e. there might be
external promos active etc".

Precedent to reuse: the KeyData trial already solved the fallback-ladder problem once
(per-`group:` booking curves with sample gates in
`src/lib/agents/pricing-comparison/booking-curve.ts`, the four-rung confidence ladder in
`src/lib/pricing/trial-pricing.ts`). Follow that pattern; do not invent a new one.

## Part A – Cohort grain engine for the trigger and occupancy scaling

1. **Cohort resolver.** New module `src/lib/observe/cohorts.ts` (pure core, unit-tested): given
   a listing, resolve its cohort memberships along independent dimensions (crossover is
   expected and fine):
   - listing itself;
   - `group:` tag(s) (`Listing.tags`, the existing convention; a listing can be in several);
   - size band (`Listing.bedroomsNumber`: 0-1 / 2 / 3+ or per-bedroom where n allows);
   - city/market (`Listing.city`, normalised - e.g. the two Belfast tenants share a market);
   - tenant (the current behaviour, as fallback);
   - room type / multi-unit flag (`unitCount >= 2`) where it changes behaviour.
2. **Curve ladder.** Booking-lead curves (the `expectedCumulativeFill` input in
   `src/lib/observe/suggestions.ts`) and the DOW occupancy scaler resolve through a
   most-specific-first ladder with explicit sample gates, e.g.:
   listing (>= ~100 trailing-365d bookings) -> group (>= 3 listings AND pooled gate) ->
   tenant x size band -> tenant -> global. Gates are named constants; calibrate the exact
   values against prod counts (audit found median 45-62 bookings/listing/365d; Stay Belfast
   median 122). Every resolved value records `{rung, cohortKey, n}`.
3. **Consume it.** The suggestion trigger and occupancy scaling use the resolved cohort curve
   instead of the flat tenant curve; each `Suggestion.detail` records the rung/cohort/n it was
   judged against (provenance a human can read). The occupancy scaler must stop letting block
   units drown flats: scale within the listing's cohort, not the whole tenant.

## Part B – Richer learning dimensions and the actual-paid signal

4. **Actual-paid (promo) signal.** Use the Hostaway reservation amounts ALREADY SYNCED into
   this app (`Reservation` fields such as `accommodationFare`/total, plus its `rawJson` payload
   - inspect real prod rows read-only to find discount/promotion/coupon fields if present). Do
   NOT add or modify anything under `src/lib/hostaway/**`; the synced data is the Hostaway
   truth. Compute per booking: gross nightly actually paid vs the listed rate in force near the
   booking time (nearest `rate_states`/`RateChange` observation). The gap is the
   promo/discount drag. Learn it per channel (`Reservation` channel field), per cohort
   dimension where n allows, and feed it into the ghost scorer's `realisedVsProposed` so a
   night "filled" by a heavy external promo is not scored as a full-rate win.
5. **Wire pickup velocity at last.** The peer ladder (`src/lib/observe/peer-ladder.ts`) writes
   `PeerControl` rows whose `moved_pickup`/`control_pickup` have never been measured (audit:
   0 of 1,150+). On the weekly settle, compute pickup (bookings gained in the 7 days after the
   change, subject listing vs its recorded control set) for controls old enough to measure,
   and store it. Feed the aggregate into the client profile as learning #1 with its n.
6. **Cohort-cut calibration and mining.** The ghost-scorer calibration report and the
   drop-dose-response cells gain group and size-band dimensions (report-level re-cuts; keep
   per-cell n and suppress cells below a minimum n rather than showing noise).
7. **Market-stratified global doc.** `GlobalMethodology` learns per city/market as well as per
   engine (Belfast has 67 listings across 3 tenants - the one in-house market grain). Keep
   `anonymiseForGlobal` and its whitelist intact: cohort labels must stay anonymous (city name
   is fine; tenant/listing identity is not).

## Part C – Surface it to Mark

8. **Readout:** per-group and size-band curve summaries with rung/n; suggestion provenance
   visible ("judged against group:Argo curve, n=1,204").
9. **Weekly report (`src/lib/observe/weekly-report.ts`):** a plain-English "how your groups
   book differently" section (the audit's Argo-54d-vs-St-James-3d insight is exactly what Mark
   said he wants to know), the promo-gap line per client when material, and any cohort that
   changed rung this week. Keep the report's host language and phone-readable rules; numbers
   carry their n; no jargon (say "your Argo apartments book about 8 weeks out; St James books
   in the final days", not "cohort rung 2").

## Constraints (house rules, non-negotiable)

- Every Prisma query touching `Listing`, `Reservation`, `NightFact`, `PaceSnapshot`,
  `CalendarRate`, `DailyAgg`, or `SyncRun` MUST filter by `tenantId`; any new model gets
  `@@index([tenantId, ...])`. Cross-tenant reads are allowed ONLY inside the market/global
  aggregation paths that already exist for that purpose (estate readout, GlobalMethodology),
  never in per-client learning.
- Do NOT touch `src/lib/hostaway/**`, `src/lib/sync/pace.ts`, or the pace queries in
  `src/lib/reports/service.ts`. No AirROI. No customer-facing price change; suggestions stay
  pending-only.
- Prefer no new tables (profile JSON + suggestion detail + report artefacts); if a table is
  genuinely needed, additive migration only, never `migrate dev` against prod.
- Prod access is SELECT-only, for calibrating gates and inspecting `rawJson` shapes.
- UK English, no em dashes (en dashes fine). One fix per commit.

## Green gate (all must pass)

```
npm run typecheck
npm run lint -- --max-warnings=0
npm run test:tenant-isolation
npm run test:observe
npm run test:observe-schedule
```

Plus unit tests: cohort resolution with crossover membership; ladder gate boundaries (falls
back exactly at the gate); provenance recorded on suggestions; promo gap computed from a
fixture reservation with a discount vs listed rate; pickup computed for a seeded control set;
calibration cells suppressed below minimum n; weekly-report copy for the new sections passes
the existing no-jargon/no-id renderer tests.

## Finish

Report what changed, the before/after trigger behaviour on the audit's worked examples (Argo
vs St James; LF blocks vs flats), the test evidence, and the commit list. Then ask Mark
explicitly: **deploy to the live webapp or keep local?** If autonomous and Mark cannot answer,
do NOT auto-deploy; leave a TO DEPLOY block. If Mark has already said deploy, follow the
standing deploy & self-heal protocol in CLAUDE.md end to end (backup tags, green gate,
baseline, push, migrations via `migrate deploy` if any, worker restart, verify against
baseline, bounded self-heal, report).
