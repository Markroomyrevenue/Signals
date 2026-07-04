# Build audit 07 – behavioural (independent)

- **Auditor:** independent adversarial session, no context from the build agents.
- **Date:** 2026-07-04.
- **Scope:** commits after `d0f81af` ("docs(review): build prompt 07") on `feat/observe-grain-2026-07`:
  `689ed09..05a9bdd` (10 feat + 4 docs commits; 33 files, +3,927/-177).
- **Contract:** `reviews/observe-learn-2026-07/BUILD-PROMPTS/07-learning-granularity-hierarchy.md`;
  evidence base `reviews/observe-learn-2026-07/07-learning-granularity.md`.
- **Method:** the real code was exercised end to end against the local dev DB with two seeded
  throwaway tenants (`audit07-t1`, `audit07-t2`); prod was touched SELECT-only for calibration
  checks. Harness: `scratchpad/audit07-seed-and-run.ts` (22 assertions, all pass); seed data
  deleted afterwards (verified 0 rows remain). No source file was modified; the only file this
  session writes is this report.

## Verdict: SAFE. No blockers found.

All five gate commands green on the branch tip:

```
npm run typecheck                      # exit 0
npm run lint -- --max-warnings=0       # exit 0
npm run test:tenant-isolation          # "Tenant isolation check passed."
npm run test:observe                   # 242 tests, 0 fail (pickup/actual-paid/cohorts suites added)
npm run test:observe-schedule          # 6 tests, 0 fail
```

No touches to `src/lib/hostaway/**`, `src/lib/sync/pace.ts`, `src/lib/reports/service.ts`, or
anything AirROI (`git diff --name-only d0f81af..HEAD` grep: no hits). All suggestions remain
pending-only; nothing customer-facing changes a price.

---

## 1. Grain ladder – same forward night, different judgements (PROVED)

Seeded on `audit07-t1`: a late-booking group (`group:LateBlock`, 3 listings, 90 pooled bookings,
lead 50–58d), an early-booking group (`group:EarlySt`, 3 listings, 90 bookings, lead 2–3d), and a
thin group (`group:ThinGrp`, 3 listings, exactly 59 pooled bookings, lead 54d). One identical
forward night per listing: empty, 10 days out, rate 100 (`CalendarRate`). Then the real generator,
`generateSuggestionsForClient` (`src/lib/observe/suggestions.ts:622`):

```
PASS  late1 night(+10d) fires a drop under the late-booking group curve
PASS  late1 provenance names cohort + n  :: {"n":90,"rung":"group","cohortKey":"group:LateBlock"}
PASS  early1 SAME night(+10d) does NOT fire under the early-booking group curve
late1 reason: empty at 10d out; curve expects ~100% booked by now (raw curve 100%)
```

The same night, judged under the late curve, is behind pace and gets a drop; under the early curve
it is early on curve and stays silent. This is exactly the audit's Argo-54d-vs-St-James-3d fix.
Provenance is persisted on `Suggestion.detail.curveCohort` (`suggestions.ts:249-255,346-347`) and
rendered human-readable by `provenanceLabel` (`src/lib/observe/readout.ts`, "judged against
group:Argo curve, n=1,204" style), plus `occupancyCohort` for the scaler.

**Exact-gate fallback.** With 59 pooled bookings (one below `GROUP_CURVE_MIN_BOOKINGS = 60`,
`src/lib/observe/cohorts.ts:81`) the thin listing's suggestion recorded
`{"rung":"tenant","cohortKey":"tenant","n":314}`. Adding ONE booking (59 → 60) and regenerating:

```
PASS  thin group at EXACTLY 60 pooled bookings flips to its own group rung  :: {"n":60,"rung":"group","cohortKey":"group:ThinGrp"}
```

**Tenant isolation in the new grain.** `audit07-t2` was seeded with the SAME group tag
(`group:LateBlock`) and 200 lead-0 bookings. `audit07-t1`'s group curve stayed at n=90 with median
53d – no cross-tenant pollution (every load in `generateSuggestionsForClient`,
`suggestions.ts:648-655`, and the pure ladder is tenant-fed only). The dedicated isolation suite
also passes.

**Gate calibration honesty.** The constants' comments quote prod counts; re-checked SELECT-only:

```
group:Argo 5 listings / 335 bookings; group:Fitzrovia 7/904;
group:St James Apartments 8/93; group:Student Accomodation 3/517
```

matching the quoted 338/907/93/522 within a day's drift. All four live groups clear the gates,
including the St James smoking gun at 93.

## 2. Occupancy scaler – flats no longer inherit the block (PROVED)

Seeded a 200-unit block (`unitCount=200`, 100% occupied for 60 days, 12,000 unit-night facts) plus
3 flats at ~7% occupancy with a late-booking curve (`group:Flats`, n=75). The flat's forward night
(10d out, curve fill ~100%):

```
PASS  flat1 night(+10d), late-booking curve but ~7% own occupancy, does NOT fire
flat1 resolved occupancy rung=listing key=listing:audit07-t1-flat1 factor(dow)=0.000
tenant-pool factor(dow) incl. 200-unit block = 0.936
PASS  old behaviour WOULD have fired the flat (tenant factor >= 0.5) – regression the ladder fixes
```

Under the old tenant-pool scaler the block-dominated factor (0.94) would have pushed the flat's
scaled fill over the 0.5 threshold and fired a false drop; the cohort ladder
(`resolveCohortOccupancy`, `cohorts.ts:574-594`) resolves the flat at its own listing rung and the
trigger stays silent. The block itself still resolves at its own rung (100% occupancy), so genuine
block emptiness still fires with `unsoldUnits`-scaled revenue at risk.

## 3. Promo gap – actual-paid vs listed, no fabrication (PROVED)

Seeded three settled reservations with `RateState` rows at 100 for two of them:
paid 80/night (gap 0.20), paid 60/night (gap 0.40), and one with NO rate observation at all.
`computePromoGap` (`src/lib/observe/actual-paid.ts:268`):

```
PASS  promoA gap = 0.20 (paid 80 vs listed 100 near booking)
PASS  promoB gap = 0.40
PASS  promoC (no rate observation) EXCLUDED – no fabricated gap
learning: bookings=36 withListedRate=2 byChannel={}
PASS  channels below min-n suppressed from byChannel (no noisy medians)
```

The scorer then ran for real (`scoreSettledSuggestions`) against seeded superseded suggestions
(proposed 90) on those nights:

```
PASS  scored A realisedVsProposed = 80/90 (actual paid, not the 100 listed)  :: {"rvp":0.889,"realised":80}
PASS  scored A carries paidVsListedGapPct=0.2, heavy=false (below 0.3 abs fallback)
PASS  scored B (gap 0.4) flagged heavyPromo=true via the absolute fallback
```

`realisedVsProposed` is built from `NightFact.revenueAllocated` (actual paid,
`suggestion-scoring.ts:151-173`), and the heavy-promo flag feeds the calibration's new
`bookedHeavyPromo` / `bookedNoIntervention` split so promo-filled nights are not read as
full-rate "booked anyway" evidence.

**Prod rawJson check (SELECT-only).** The module header claims explicit discount fields are too
sparse to learn from and justifies the paid-vs-listed fallback. Verified:

```
total=41,984  reservationCouponId set=220  raw_json ILIKE '%DISCOUNT%'=46
```

The implementation therefore deliberately does NOT parse rawJson promo fields (nothing to learn
from 0.5% coverage); absent fields cannot mis-parse because they are never read. The per-channel
median baseline (structural VAT/fee wedge cancels out) is the right defence against the
booking.com ~26% structural gap being read as a promo.

## 4. Pickup velocity – learning #1 finally measured (PROVED)

Seeded a `PeerControl` row whose `RateChange` was detected 12 days ago (past the 7+1-day settle
gate) with 2 recorded controls; subject bookings 2-in-window (plus one cancelled-in-window and one
created-after-window, both correctly excluded), control bookings 1-in-window on one of two
controls. A second control detected 3 days ago proves the settle gate:

```
measureSettledPickups: {"measured":1,"withControl":1}
PASS  settled control measured: movedPickup = 2/7 (cancelled + late bookings excluded)
PASS  controlPickup = 1/(7*2) across the 2 recorded controls
PASS  too-recent control (detected 3d ago) left unmeasured
profile.pickupVelocity: {"movedPerListingDay":0.285714,"controlPerListingDay":0.071429,
  "liftPct":2.99997,"eventsWithControl":1,"windowDays":7}
PASS  ledger records pickup_velocity sampleCount=1
```

The profile carries learning #1 with its n (`client-profile.ts` `pickupVelocity` block) and the
ledger's permanent "not wired" entry is gone. The settle path calls `measureSettledPickups` BEFORE
the learnings recompute (`observe-service.ts:240-242`), so the same settle's profile includes the
newly measured events. (liftPct is 2.99997 rather than 3.0 exactly because `moved_pickup` is
stored as Decimal(18,6); storage precision, not a logic error.)

**Prod (SELECT-only): how many existing controls become measurable?**

```
peer_controls: 1,350 total, 0 already measured, all with listing/rate_change/event_date
joined rate_changes detected_at: 2026-06-27 .. 2026-07-03 (about 200/day)
measurable at the 8-day gate TODAY (2026-07-04): 0
```

The peer ladder only began writing controls on 2026-06-27, so nothing clears the 7+1-day gate yet.
At the next Monday settle (2026-07-06) roughly 400 rows become measurable, and with
`PICKUP_MEASURE_BATCH = 500` per settle the backlog drains over about two to three weekly settles.
Expectation-setting, not a defect: learning #1 stays null in prod until 2026-07-06 at the
earliest.

## 5. Weekly report – host language (PROVED)

Re-rendered the example email (`npx tsx scripts/render-weekly-report-example.ts`); output is
byte-identical to the committed artefact (`git status` clean on `observe-reports/`). The new
sections read as plain host language:

> "Your Argo properties book about 8 weeks ahead (from 338 bookings in the last year)."
> "Your St James Apartments properties book in the final days (from 93 bookings in the last year)."
> "New this week: St James Apartments now has enough booking history to be judged by its own
> pattern instead of the whole portfolio (93 bookings)."
> "About 1 in 10 of the last 214 bookings through booking.com came with a much bigger discount
> than is typical for that channel, so those filled nights were not full-rate wins."

Mechanical checks on the rendered HTML: 0 em dashes, 0 occurrences of "cohort" or "rung", 0
cuid-like ids, 0 tables. Every number carries its n. The renderer guard test bans "rung",
"cohort", listing cuids and em dashes explicitly (`weekly-report.test.ts:407-443`), and seven new
tests cover the group sentences, pattern-change lines, promo lines, material-only suppression and
the last-week-artefact comparison. No failing sentence to quote.

## 6. End state

- Working tree: no tracked modifications; untracked files are pre-existing session artefacts
  (`.claude/`, `RELIABILITY-FINDINGS.md`, `trial-reports/`) plus the sibling audit report.
- Commits: 14, one concern per commit, imperative subjects, coherent A/B/C progression with a
  docs handoff after each part.
- Gate: green end to end (section above).
- Anonymisation: `anonymiseForGlobal` whitelists city-keyed `leadTimeByMarket` only; the promo-gap
  learning (whose cohort keys include `group:` tags) is deliberately NOT whitelisted into the
  global doc, and the leak tests assert no tenantId / listing name / raw rate escapes
  (`global-methodology.test.ts:83-106`).

### Non-blocking findings

1. **Scanner-era claim in `actual-paid.ts` is not enforced by the caller.**
   `listedNightlyAtBooking` (`src/lib/observe/actual-paid.ts:82-106`) justifies the bare
   `RateState` fallback with "the booking window is bounded to the scanner's era by the caller",
   but `computePromoGap` bounds only to `PROMO_TRAILING_DAYS = 90`; prod's rate scanning era began
   2026-06-02 (first `rate_changes.detected_at`), i.e. 32 days. Bookings created 2026-04-05 to
   2026-06-02 for stays inside the scanned window resolve "listed at booking" from a post-booking
   scan, so their gaps are approximate. Effects are confined to a min-n-gated learning statistic
   (no price path), and the window self-heals by ~2026-08-31 when the era exceeds 90 days. Worth a
   one-line era clamp (`createdAt >= min(detectedAt)`) or an honest comment.
2. **Fallback copy slightly over-simplifies the ladder.** The weekly report's below-gate sentence
   says the group's nights are "judged with the whole portfolio"
   (`weekly-report.ts` `groupBookingSentences`), but the actual fallback can land on the
   tenant-by-size-band rung, and an individual listing above 100 bookings is judged by its own
   curve regardless of its group. It also quotes "not enough bookings" even when the failed gate
   is the 3-listing membership gate. Host-honesty nit; the numbers shown are true.
3. **A zero-booked day of week mutes the trigger at listing rung.** A listing that clears the
   20-slot occupancy gate but has never had (say) a Tuesday booked gets factor 0 for that DOW, so
   the trigger can never fire on Tuesdays for it (observed in the harness: flat1 factor 0.000).
   This is the design reading its own history ("that DOW never books") and errs in the safe,
   no-drop direction, but a floor (e.g. min factor or falling back for zero cells) may be worth
   considering once real data hits it.
4. **Prod pickup backlog timing** (section 4): learning #1 will read null until the 2026-07-06
   settle; nobody should mistake that for the wiring being dead again.

### Judgement: would I put these suggestions in front of a paying client, versus the flat tenant curve?

Yes. On the audit's own worked failure modes the cohort ladder is strictly better than the flat
tenant curve: the early-booking group's empty near-term nights no longer draw false drops, the
late-booking group's dying nights are still caught, and a 200-unit block no longer manufactures
false drops on flats (proved end to end above, not just in unit tests). Fallback is exact at the
gates, so thin cohorts get the old behaviour, never noise; every judgement carries readable
provenance; the safety gates (floor, event shield, anti-ratchet, already-actioned) are unchanged
and everything stays pending-only behind human approval. The remaining weaknesses (promo-gap era
approximation, muted zero-history DOWs) both err in the direction of fewer or better-founded
drops, not worse ones.
