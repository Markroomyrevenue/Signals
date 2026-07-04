# 07 — Learning granularity: what grain does the shipped system actually learn at?

Reviewer: revenue management science pass, 2026-07-04. Question from Mark, verbatim:
"Can you check that this is learning per listing as well? Wider portfolio, city, per
listing and whatever else the revenue scientist might think it needs?"

Scope: every learned artefact in the live observe-and-learn system (deployed to prod
tonight, branch main). Every code claim carries file:line; every data claim carries the
query shape and the numbers, from a read-only SELECT against prod on 2026-07-04.

Short answer: **the system learns almost everything at client (tenant) grain.** The only
per-listing mechanisms are the safety plumbing (floors, anti-ratchet caps, unsold units),
the peer-ladder control builder (which currently feeds nothing), and the drop-mining
counterfactual matching. No artefact learns at group grain, none at city or market grain,
and the global doc blends Belfast, the Ayrshire coast, Fermanagh, Harrogate and London
into one curve. The prod data says the within-tenant differences are not small: on the
same tenant, one building's median booking lead is 3 days and another's is 54.

---

## 1. The grain table

Levels checked: listing / group (`group:` tag) / client (tenant) portfolio / city-market /
global (cross-client); plus date-type and lead-time bucket where relevant.

| Artefact | Stored per | Computed over | Date-type split | Lead-time split |
|---|---|---|---|---|
| #1 Pickup velocity | not stored — never wired (`learnings.ts:433-437`) | n/a | no | no |
| #2 Lead-time curve | tenant (`learnings.ts:96-104`: `nightFact.findMany({tenantId})`, no listing grouping) | all occupied nights pooled across listings, trailing 365d | no | yes — 8 buckets (`learnings-core.ts:33-42`) |
| #3 Regret | tenant (`learnings.ts:210-307`) | 90d settled nights pooled; baseline is tenant pace-YoY or tenant same-DOW (`learnings.ts:134-197`) | DOW only inside the baseline | no |
| #4 Pricing power | tenant (`learnings.ts:107-122`); rows are listing-days from `DailyAgg` (per listing-date, `schema.prisma:402-422`) but pooled before output | trailing 365d listing-days | yes — holiday/weekend/weekday (`learnings.ts:41-47`) | no |
| #5 Engine reaction | tenant (`learnings.ts:314-350`; per-`engineListingId` lookups, counts pooled) | last 200 human moves | no | no |
| #6 Net realised / fee drag | tenant (`learnings.ts:357-375`) | 90d reservations pooled | no | no |
| #7 Cancellation quality | tenant (`learnings.ts:382-411`) | 365d reservations pooled | no | no |
| ClientProfile | tenant + clientKey, and clientKey **is** the tenantId (`config.ts:14-16`; upsert `client-profile.ts:196-206`) | the seven tenant-grain learnings | inherits #4's | inherits #2's |
| Suggestion trigger curve (`expectedCumulativeFill`) | tenant — the generator calls `computeLeadTime(tenantId)` (`suggestions.ts:644`) and judges every listing-night against that one curve (`suggestions.ts:60-68, 279-290`) | tenant lead curve | no | yes (implicit) |
| Occupancy scaling of the trigger | tenant × DOW (`computeDowOccupancy`, `suggestions.ts:502-539`: one 7-slot array per tenant, unit-weighted) | all listings' unit-nights pooled | DOW | no |
| Cumulative drop cap + already-actioned guard | **listing-night** (`suggestions.ts:549-614`, keys `listingId\|date`) | prior Suggestion rows | n/a | n/a |
| Min-price floor | **listing** (`resolveListingFloors`, `suggestions.ts:441-490`) | engine snapshot / settings / observed min | n/a | n/a |
| Unsold-units risk scaling | **listing** (`suggestions.ts:684-703`, unitCount-aware) | calendar + night facts | n/a | n/a |
| Ghost scorer rows | **listing-night** (`suggestion-scoring.ts:381-403`, score written to each suggestion's `detail`) | that night's facts | n/a | n/a |
| Calibration report | tenant + clientKey pooled (`readout.ts:258-312` fetches by `{tenantId, clientKey}`; `assembleCalibration`, `suggestion-scoring.ts:300-339`) | last 200 scored rows across all listings | no | yes — drop-size × lead buckets (`suggestion-scoring.ts:260-273`) |
| Drop dose-response mining | matching **within listing** (`drop-outcomes.ts:93-98` matchKey = `listingId\|dow\|leadBucket`; controls same listing `drop-outcomes.ts:360-380`); cells then pooled per tenant (`drop-outcomes.ts:566-621`, key = leadBucket × dropBand × weekday/weekend — no listing/group dimension) and again all-clients (`scripts/mine-drop-outcomes.ts:388`) | settled treated nights | weekday/weekend | yes |
| Peer ladder | **listing** — per-drop control set from bedrooms + `group:` tag (`peer-ladder.ts:60-105`, reusing `selectPortfolioPeerSetListingIds`, `peer-set.ts:35-57`), three rungs with confidence 0.8/0.5/0.3 (`peer-ladder.ts:30`) | portfolio snapshot | no | no |
| GlobalMethodology | one global row, no tenant (`global-methodology.ts:21, 275-302`); equal weight per client (`global-methodology.ts:194-258`) | latest profile of every current tenant | pricing-power votes only | lead buckets only |
| Weekly report | client (tenant) sections only (`weekly-report.ts:626-718, 510-521`); listing names appear only in the readout's suggestion table (`readout.ts:318-329`) | persisted tenant artefacts | no | no |

Two grain notes worth pinning:

- The peer ladder is the one genuinely per-listing learning mechanism, and **it feeds
  nothing today**: `PeerControl.movedPickup`/`controlPickup` are optional and never
  measured (`peer-ladder.ts:112-140` callers pass neither; `attachControlsForRecentChanges`,
  `peer-ladder.ts:218-228`, records the control set only), and learning #1 is explicitly
  "not wired" (`learnings.ts:433-437`). Evidence engine built, engine idle.
- GlobalMethodology's whitelist (`global-methodology.ts:41-61`) carries no market or city
  label, so the blend has no market identity at all — Belfast, St Andrews and Harrogate
  clients average into one lead curve and one regret pattern. `Listing.city` exists
  (`prisma/schema.prisma:151`) and could supply a coarse market label without touching
  the anonymisation guarantees (a city cohort label identifies no client).

---

## 2. What the prod data supports (read-only SELECTs, 2026-07-04)

Tenants, active listings, cities (`SELECT t.name, COUNT(l.id) FILTER (WHERE l.removed_at
IS NULL), COUNT(DISTINCT l.city) ... FROM tenants t LEFT JOIN listings l ...`):

| Tenant | Active listings | Cities | Market shape |
|---|---|---|---|
| Coorie Doon Stays | 46 | 15 | Ayrshire/Fife coast towns, 3 in St Andrews |
| Escape Ordinary | 53 | 17 | Northern Ireland spread, 6 in Belfast |
| Little Feather Management | 50 | 2 | Belfast |
| Stay Belfast | 14 | 3 | 11 Belfast + Bryansford/Rostrevor |
| Yo's House & Short Stay Harrogate | 35 | 7 | Harrogate/N. Yorks + a London cluster |
| Demo Property Manager | 0 | 0 | — |

**Per-listing booking depth, trailing 365d** (occupied night_facts with a lead time,
distinct reservations per listing):

| Tenant | Listings w/ history | ≥20 res | ≥50 res | ≥100 res | Median res/listing | Median occupied nights |
|---|---|---|---|---|---|---|
| Coorie Doon | 45 | 38 | 17 | 0 | 46 | 203 |
| Escape Ordinary | 53 | 41 | 33 | 0 | 59 | 190 |
| Little Feather | 48 | 32 | 24 | 13 | 45 | 306 |
| Stay Belfast | 15 | 15 | 14 | 9 | 122 | 253 |
| Yo's House | 33 | 21 | 20 | 2 | 62 | 121 |

Rule of thumb: a stable 8-bucket lead-time curve wants roughly 100+ bookings (bucket
shares to about ±3-5pp); 50+ gives a usable coarse curve; below 20 it is noise. So a
**pure per-listing curve is supportable today for only a minority** (Stay Belfast almost
entirely; roughly half of Escape Ordinary and Yo's House; a third of Coorie Doon and
Little Feather). Everything else needs a fallback grain — which the estate already has:

**`group:` tags usable as an intermediate grain** (`SELECT ... unnest(l.tags) WHERE tag
LIKE 'group:%'`): Little Feather `group:Student Accomodation` (3 listings — the
multi-unit blocks; LF has 3 multi-unit listings and 253 total units), Stay Belfast
`group:Fitzrovia` (7), Yo's House `group:St James Apartments` (8) and `group:Argo` (5).
Three of five live tenants have a ready-made group grain.

**And the groups genuinely differ** — median booking lead, trailing 365d occupied nights:

| Tenant | Segment | Nights | Median lead (days) |
|---|---|---|---|
| Little Feather | student blocks | 1,809 | **10** |
| Little Feather | everything else | 12,366 | **21** |
| Stay Belfast | Fitzrovia | 1,849 | **22** |
| Stay Belfast | rest | 1,842 | **12** |
| Yo's House | Argo | 1,481 | **54** |
| Yo's House | St James Apartments | 408 | **3** |
| Yo's House | no group | 4,712 | **27** |

That last tenant is the smoking gun: one tenant curve is being fitted over a building
that books 54 days out and a building that books 3 days out. The tenant-pooled trigger
(`suggestions.ts:644`) will flag St James nights "behind pace" at 20 days out (they
always fill last-minute — false drops) and will sit silent on Argo nights that are
genuinely dying (missed drops). The Little Feather occupancy scaler has the same
problem in a different coat: `computeDowOccupancy` is unit-weighted, and the ~200
student-block units dominate the ~50 flats, so the flats' trigger is calibrated against
block occupancy.

**City/market grain in-house**: Belfast is the only multi-tenant market — Little
Feather (50) + Stay Belfast (11) + Escape Ordinary (6) = 67 Belfast listings across
three tenants. Any cross-tenant market learning must go through the anonymised global
path (the tenant-isolation rule, CLAUDE.md); a market-stratified GlobalMethodology is
the compliant way to get it.

**Ghost-scoring volume**: 55 Suggestion rows exist across 4 tenants and **0 have a
score** (`SELECT ... COUNT(*) FILTER (WHERE detail ? 'score')` = 0 everywhere) — the
system shipped tonight and the scorer settles nights ~2 days after stay. Any calibration
re-graining is a decision about where rows will pool, not a migration; the rows are
already listing-night grain so re-slicing later is free.

---

## 3. RM judgement — which decisions need which grain

A daily-drop method has one live decision (is THIS listing-night behind ITS curve, and
how big a drop) and a set of slow-moving traits. Those need different grains.

**Needs listing/group grain (miscalibrated today):**

1. **The trigger curve.** The decision is per listing-night; the curve is per tenant. A
   1-bed city-centre flat and a student block do not share a booking curve, and the
   Argo-vs-St-James numbers above show pooling miscalibrates the trigger in both
   directions at once (false drops on late-booking stock, missed drops on early-booking
   stock). This is the artefact that will move money wrongly first once suggestions are
   approved.
2. **The occupancy scaler.** Same argument; plus the unit-weighting bug-by-construction
   at Little Feather. The right denominator is the listing's own (or its group's) DOW
   occupancy, not the tenant's.
3. **Pickup velocity / drop evidence.** Already designed per listing (peer ladder) —
   it just needs to be fed. Without it, every "booked after drop" claim stays
   confounded exactly as `drop-outcomes.ts:17-23` warns.

**Fine at portfolio (tenant) grain — do not re-grain:**

- **Fee drag / net realised** (#6): fees are channel- and PM-level economics; per
  listing adds noise, not signal.
- **Cancellation quality** (#7): needs n≥10 at tenant grain already; per listing would
  abstain everywhere.
- **Engine reaction** (#5): the engine and its configuration are per client.
- **Regret** (#3) as a client trait ("tolerates empty premium nights"): it describes
  the human's behaviour, which is client-level. Per-listing regret over a 90d window
  would be noise.
- **Calibration report**: keep pooled per tenant until scored n per tenant reaches a
  few hundred; the buckets (drop size × lead) are the right first cuts. Add a
  group/date-type cut later — no schema change needed.
- **Weekly report grain**: Mark should keep seeing one section per client. Add a single
  line when a group diverges from its tenant curve, nothing more.
- **Drop-mining counterfactual**: within-listing matching is the correct design; the
  thin cells are a data-age problem, not a grain problem.

**Where listing grain would be noise:** everything in the second list, plus per-listing
lead curves for the long tail (median 45-62 bookings/listing/year). Do not build a
per-listing curve as the default — build the fallback ladder and let sample size decide.

---

## 4. Recommended hierarchy and the priority order

The codebase already contains the exact pattern needed, twice: the trial's booking-curve
grain decision — per-`group:` curve where ≥3 single-unit listings and ≥500 observations
per lead anchor, tenant fallback below the gate, per-DOW partition with its own gate of
300 (`src/lib/agents/pricing-comparison/booking-curve.ts:27-32, 89-96, 113, 294-344,
356-372`) — and the four-rung confidence ladder that slides weight by sold-night count
(`src/lib/pricing/trial-pricing.ts:69-72, 495-530`). Mark has already made this grain
call once (2026-05-26, Castle Buildings: tenant-wide read −2% to −13%, building grain
+43% to +71%). The observe system should inherit it, not re-litigate it.

**Recommended grain ladder for anything curve-shaped, with sample-size gates:**

    listing (n ≥ ~100 bookings/365d)
      → group: tag (≥3 listings and pooled n over threshold)
        → tenant portfolio
          → market (city label, anonymised, cross-client)
            → global

Record the rung used and its n on whatever consumes it — the peer ladder and the trial
both already do this; the learning ledger (`learnings.ts:75-79`) is the natural place.

**Priority order of changes:**

1. **Group-grain trigger curve** — resolve each listing's curve via
   listing→group→tenant fallback in `generateSuggestionsForClient`
   (`suggestions.ts:644`), reusing the trial loader's construction and gates. Highest
   revenue impact; the machinery exists.
2. **Listing/group-grain occupancy factor** — replace the tenant DOW array
   (`suggestions.ts:502-539`) with the listing's own DOW occupancy, group→tenant
   fallback when thin; fixes the Little Feather unit-weighting distortion at the same
   time.
3. **Wire pickup velocity to the peer ladder** — measure moved-vs-control pickup on the
   `PeerControl` rows already being written (`peer-ladder.ts:112-140`), filling
   learning #1's permanent null (`learnings.ts:433-437`). Turns the only per-listing
   learner from scaffolding into evidence.
4. **Market-stratify GlobalMethodology** — add a coarse market label (derived from
   `Listing.city`, e.g. belfast / ni-other / scotland-coast / yorkshire / london) to
   `AnonymisedContribution` (`global-methodology.ts:24-34`) and aggregate per market as
   well as per engine, exactly as `engineReactionByEngine` already does per engine
   (`global-methodology.ts:239-251`). This is also the only compliant route to a
   Belfast market grain (67 listings across three tenants).
5. **Per-group lead-time entries in the profile/ledger** — store the group curves the
   trigger uses (step 1) on the ClientProfile so the readout and weekly report can show
   "Fitzrovia books 22d out, the rest 12d" instead of one blended median.
6. **Calibration by group/date-type** — once scored volume arrives (a few hundred per
   tenant), add group and weekday/weekend cuts to `assembleCalibration`
   (`suggestion-scoring.ts:300-339`). Nothing to do now beyond not deleting rows —
   which the supersede-never-delete design already guarantees (`suggestions.ts:34-44`).

Explicitly fine as-is, no action: fee drag, cancellation quality, engine reaction,
tenant-grain regret, the listing-night safety guards (floors, cumulative cap,
already-actioned, unsold units), the within-listing drop-mining design, and the weekly
report's per-client voice.
