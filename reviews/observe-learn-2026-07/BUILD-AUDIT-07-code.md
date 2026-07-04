# BUILD-AUDIT-07 — code and constraints (independent adversarial audit)

- **Auditor:** independent session, no build-agent context (deliberate).
- **Date:** 2026-07-04.
- **Branch:** `feat/observe-grain-2026-07`, 14 commits after the prompt-07 docs commit
  (`689ed09..05a9bdd`; diff `main..HEAD`: 33 files, +3,927 / −177).
- **Contract:** `reviews/observe-learn-2026-07/BUILD-PROMPTS/07-learning-granularity-hierarchy.md`.
- **Verdict: SAFE.** No blockers. Full green gate re-run passes. All nine contract
  items implemented (one deliberate, correctly justified deviation on the ladder's
  terminal rung). Seven non-blocking findings below.

## 1. Green gate — re-run by the auditor

| Check | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run lint -- --max-warnings=0` | exit 0 |
| `npm run test:tenant-isolation` | exit 0 — "Tenant isolation check passed." |
| `npm run test:observe` | exit 0 — **242 tests, 242 pass, 0 fail** (new suites `cohorts`, `actual-paid`, `pickup` added to the script in `package.json`) |
| `npm run test:observe-schedule` | exit 0 — 6 tests, 6 pass |

## 2. Contract items 1–9

| # | Item | Status | Evidence |
| --- | --- | --- | --- |
| A1 | Cohort resolver, independent dimensions with crossover | **Implemented** | `src/lib/observe/cohorts.ts:176` `resolveCohortMemberships` — listing, `group:` tags, size band (0-1/2/3+), normalised city, stock (multi-unit flag), tenant. Crossover test `cohorts.test.ts:41`. |
| A2 | Curve ladder with named, prod-calibrated sample gates + `{rung, cohortKey, n}` | **Implemented, one deliberate deviation** | Gates at `cohorts.ts:61,69,81,90,104`; ladder `resolveCohortCurve` (`cohorts.ts:332`): listing (≥100 bookings) → group (≥3 listings AND ≥60 pooled) → tenant × size band (≥100, single-unit only) → tenant. Boundary tests `cohorts.test.ts:77,90,119,240`. Deviation: the prompt's example ladder ended `… → tenant → global`; the build stops at tenant and documents why (`cohorts.ts:35-39`) — a global rung inside per-client generation would need cross-tenant reads, which the prompt's own constraints forbid outside the anonymised aggregation paths. Right call. |
| A3 | Trigger + occupancy consume the ladder; provenance on `Suggestion.detail` | **Implemented** | `suggestions.ts:727-751` (per-night resolved curve + occupancy), `detail.curveCohort` / `detail.occupancyCohort` (`suggestions.ts:346-347`); cohort-scoped occupancy replaces the deleted tenant-wide `computeDowOccupancy` (commit `e024e9`); block-vs-flats test `cohorts.test.ts:259`; worked Argo/St James trigger test `cohorts.test.ts:192`. |
| B4 | Actual-paid promo signal from synced data, per channel + cohort, into the ghost scorer | **Implemented** | `actual-paid.ts` (new, tenant-scoped, read-only; nothing under `src/lib/hostaway/**` touched — verified zero diff). Rrelative-to-channel-median heavy flag (structural VAT wedge cancels). Scorer integration `suggestion-scoring.ts:493-508,157-172`; calibration separates `bookedHeavyPromo` / `bookedNoIntervention`. |
| B5 | Pickup velocity measured on the weekly settle, learning #1 with n | **Implemented** | `pickup.ts` (new); settle wiring `observe-service.ts:240-242` (before the learnings recompute, so the same settle's profile includes it); writes only `PeerControl.movedPickup/controlPickup` + detail merge, idempotent via `movedPickup: null` filter; profile field `client-profile.ts` `pickupVelocity` with `eventsWithControl` as n; ledger #1 no longer hard-coded "not wired". |
| B6 | Calibration + dose-response re-cuts by group and size band, min-n suppressed | **Implemented** | `suggestion-scoring.ts:364-390` (`MIN_CALIBRATION_COHORT_N = 10`), `drop-outcomes.ts:623-660` (`MIN_COHORT_CELL_TREATED = 20`), `scripts/mine-drop-outcomes.ts` re-cut section. Suppression tests `suggestion-scoring.test.ts:366`, `drop-outcomes.test.ts:356`. |
| B7 | Market-stratified GlobalMethodology, whitelist intact | **Implemented** | `learnings.ts` `computeLeadTime` now also returns per-market curves gated at `MARKET_LEAD_MIN_NIGHTS = 300`; `global-methodology.ts` `leadTimeByMarket` (equal weight per contributing client per market, like per-engine). Whitelist extended by exactly one key; the promo-gap block (whose `byCohort` keys carry `group:` labels that can embed client names) is **not** whitelisted, and the leak test now asserts `SECRET-GROUP` never reaches the global doc (`global-methodology.test.ts:89-95,217-224`). |
| C8 | Readout: cohort curve summaries + human-readable provenance | **Implemented** | `readout.ts` `cohortCurves` section + `provenanceLabel` ("judged against group:Argo curve, n=1,204" shape); calibration re-cut tables rendered. |
| C9 | Weekly report: groups section, promo line when material, rung changes, host language | **Implemented** | `weekly-report.ts` `groupBookingSentences` / `groupPatternChangeSentences` (vs last week's artefact on disk) / `promoGapSentences` (heavy share only, never the raw structural wedge; `PROMO_LINE_MIN_HEAVY_SHARE = 0.05`). The existing no-jargon/no-id/no-em-dash renderer test covers the new sections (`weekly-report.test.ts:407-443`); example artefacts re-rendered. |

## 3. Constraint sweep

- **Protected paths:** `git diff main..HEAD -- src/lib/hostaway src/lib/sync/pace.ts src/lib/reports/service.ts prisma` → **0 lines**. No migrations, no new tables (profile JSON + suggestion detail + report artefacts, as the prompt preferred). No AirROI references.
- **`package.json`:** test-list change only.
- **Secrets:** none in the diff (the `SECRET_*` strings are leak-test fixtures).
- **Tenant isolation:** every new query touching guarded models carries `tenantId` — traced by hand through `actual-paid.ts` (reservations :276, rateChange :315, rateState :324, listing :328), `pickup.ts` (peerControl :183/:249/:277, rateChange :197, reservation :223 — the `updateMany` is `{ id, tenantId }`), `suggestions.ts` (listing :648, nightFact :652/:702, calendarRate :698, engineSnapshot/pricingSetting/rateState in floors, suggestion guards), `readout.ts` (:314,:318,:351) and `weekly-report.ts` (:843,:847). The **only** cross-tenant reads are the two pre-existing sanctioned paths: the estate readout (`readout.ts:267-271`) and `recomputeGlobalMethodology` (`global-methodology.ts:326-341`), which strips identity through `anonymiseForGlobal` before aggregation. **The market grain specifically:** per-client learning never reads another tenant — `leadTimeByMarket` is computed inside `computeLeadTime(tenantId)` from that tenant's own facts; the two Belfast tenants' curves only ever meet inside the anonymised global doc, keyed by lower-cased city label. No breach.
- **Customer-facing prices:** suggestion rows stay `pending`/`shadow`; `applySuggestionRegeneration` semantics unchanged; no push-service or Hostaway write anywhere in the diff.
- **Anonymisation:** whitelist test passing and extended; city labels are `normaliseCityKey` output (trimmed lower-cased city), no tenant/listing identity; the 300-night market gate keeps one-listing villages from publishing a de-facto per-client curve under a place name.

## 4. Grain-logic review

- **Gates are real and the cited prod numbers check out.** Verified SELECT-only against prod (2026-07-04): group members / pooled distinct bookings = Argo 5/338, Fitzrovia 7/907, St James Apartments 8/93, Student Accomodation 3/522 — exactly the numbers quoted at `cohorts.ts:67,75-79`; 25 of 190 listings clear the 100-booking listing gate ("deep-history minority (25 listings estate-wide)", `cohorts.ts:57`); `reservationCouponId` on 220 of 41,984 reservations, matching the `actual-paid.ts:13` justification for the fallback design.
- **Deterministic fallback:** ties inside a rung break on smallest member pool then `cohortKey` `localeCompare` — total order, same input ⇒ same rung. Falls back exactly at the gate (boundary tests).
- **Provenance:** recorded on every draft (`curveCohort`, `occupancyCohort`), parsed defensively for pre-ladder rows (`readProvenanceFromDetail`), surfaced in readout and (as host language) the weekly report.
- **Occupancy scaler genuinely cohort-scoped:** per-listing accumulators (numerator capped at unitCount, denominator = unitCount × active-window DOW dates from the listing's first occupied fact) roll up into group/band/tenant; a 200-unit block only reaches a flat's judgement if the flat fails listing, group AND band gates — and even the tenant fallback is no longer distorted by removed listings' orphan numerators. Test `cohorts.test.ts:259`.
- **Promo-gap guards:** `bookingPromoGap` returns null (excluded, not zero-filled) on non-positive fare, non-positive nights, zero resolvable stay nights, or non-positive mean listed rate (`actual-paid.ts:132-140`); channels/cohorts below min-n are omitted entirely. Tests at `actual-paid.test.ts:74,164`.

## 5. House bug classes

- **BullMQ repeatable hygiene:** no diff under `src/workers/**`; no schedule changed. N/A.
- **Daily-vs-weekly overwrites:** the global doc is safe (settle-only recompute), but see finding F1 for the client-profile row.
- **Append-only reads:** ledger consumers still dedupe newest-per-learning; weekly report reads the newest artefact only.
- **Per-date sweeps as episodes:** episode collapse untouched; the cohort re-cut pools existing treated nights (crossover counting is intentional and documented).

## 6. Findings (all non-blocking)

**F1 — Daily runs null the settle-only profile fields.** `accumulateLearning` rebuilds and overwrites the whole `ClientProfile` doc on every daily run (`observe-service.ts:88-93`); with `includeNetRealised: false` the doc lands with `pickupVelocity: null`, `promoGap: null` (and the pre-existing `feeDragPct: null`). Nothing currently mis-reads it — the weekly report and the global recompute both run on the settle path right after the settle's own profile write, and the readout takes #1/#6/#8 from the deduped ledger — but any future consumer reading the profile mid-week sees the settle learnings as null. Suggest merging settle-only fields forward (or splitting the doc) in a follow-up.

**F2 — Promo-unknown conflated with promo-clean in the calibration boolean.** `scoreSuggestionNight` sets `heavyPromo: promo?.heavy ?? false` (`suggestion-scoring.ts:170-172`). A booking created more than `PROMO_TRAILING_DAYS` (90) days before the settle has no promo evidence, so it scores `heavyPromo: false` and counts toward `bookedNoIntervention` — mild optimism in the "honest no-intervention wins" number for long-lead bookings. `paidVsListedGapPct: null` does preserve the distinction on the row; only the aggregate boolean loses it.

**F3 — Tenant fallback curve is not "exactly" the old curve.** The trigger's fact load bounds `date: { gte: −365d, lt: today }` (`suggestions.ts:653`), while the old `computeLeadTime` (and still learning #2 at `learnings.ts:124`) has **no upper bound**, so it included future-dated booked nights (censored, long-lead-biased). The new bound is statistically better — but the comment "matching the old `computeLeadTime` exactly" (`cohorts.ts:243-246`) overstates it, and learning #2's published curve now differs subtly from the trigger's tenant rung. Worth reconciling.

**F4 — Weekly-report copy: below-gate groups say "judged with the whole portfolio"** (`groupBookingSentences`), but the ladder may actually resolve those listings at the size-band rung. Cosmetic host-language imprecision, safe direction.

**F5 — Ladder terminates at tenant, not the prompt's sketched "… → global".** Deliberate, documented (`cohorts.ts:35-39`) and required by the tenancy constraint. Recording it so a future session does not "fix" it.

**F6 — Em dashes.** 6 of 14 commit subjects and most new comment blocks use em dashes, against the prompt's "no em dashes (en dashes fine)" rule. Consistent with the pre-existing codebase comment style, so cosmetic — but the rule was in the contract.

**F7 — `loadPreviousGroupPatterns` keys clients by display name** (`weekly-report.ts`). A tenant rename silently drops that client's rung-change comparison for one week (no wrong output, just a missed "new this week" line).

## 7. Prod evidence run (SELECT-only)

```sql
-- group gates (matches cohorts.ts comments exactly)
group:Argo|5|338  group:Fitzrovia|7|907  group:St James Apartments|8|93  group:Student Accomodation|3|522
-- listing gate: 25 of 190 listings clear 100 distinct bookings / trailing 365d
25|190
-- coupon sparsity behind the actual-paid fallback design
220|41984
```

No credentials printed; queries run through the read-only env per the audit brief.
