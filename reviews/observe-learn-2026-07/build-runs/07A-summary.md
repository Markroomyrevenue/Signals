> **Update 2026-07-04:** built, independently audited (SAFE, two auditors) and **deployed live** (prod `05a9bdd`). See DECISIONS.md.

# Build run 07 Part A — cohort grain engine (2026-07-04)

Scope: build prompt 07 items 1-3 (`BUILD-PROMPTS/07-learning-granularity-hierarchy.md`),
on branch `feat/observe-grain-2026-07`. Evidence base: the granularity audit
(`../07-learning-granularity.md`). NOT deployed — deployment is the orchestrator's step.

## What shipped

| Commit | Change |
|---|---|
| `689ed09` | `src/lib/observe/cohorts.ts` + tests: pure membership resolver (crossover), lead-curve ladder, DOW-occupancy ladder, prod-calibrated named gates |
| `d01435d` | Suggestion trigger judges each night against its resolved cohort curve; `Suggestion.detail.curveCohort` provenance |
| `e024de9` | Occupancy scaling resolves through the same ladder; `Suggestion.detail.occupancyCohort` provenance; lifecycle-aware denominators |

Gate: typecheck, lint (0 warnings), tenant-isolation, `test:observe` 200/200
(was 183 before this part), `test:observe-schedule` 6/6 — all green.

## The ladder (both curves and occupancy)

listing → `group:` tag (smallest member pool wins) → tenant × size band
(single-unit stock only; multi-unit listings skip the rung) → tenant.
`market`/`global` rungs are reserved in `CohortRung` but never produced —
cross-tenant grain must come from the anonymised GlobalMethodology path
(Part B item 7). The tenant rung reproduces the old `computeLeadTime`
distribution exactly, and the old n ≥ 20 generation skip gate is kept
(`MIN_TENANT_LEAD_NIGHTS`).

Gates (named constants in `cohorts.ts`, prod SELECTs 2026-07-04 quoted at each):

- `LISTING_CURVE_MIN_BOOKINGS = 100` — 25 listings estate-wide clear it (LF 13, SB 10, Yo's 2).
- `GROUP_CURVE_MIN_LISTINGS = 3`, `GROUP_CURVE_MIN_BOOKINGS = 60` — all four live
  groups clear (St James 93, Argo 338, Student Accomodation 522, Fitzrovia 907).
- `SIZE_BAND_CURVE_MIN_BOOKINGS = 100` — thinnest live band (LF 3+) is 165.
- `OCCUPANCY_MIN_SLOTS_PER_DOW = 20` — 160/194 listings resolve at their own rung.

## Worked examples (now test fixtures)

- `cohorts.test.ts` "worked example": Argo-shaped group (54d lead) vs
  St-James-shaped group (3d) on one tenant — the same empty night 20d out
  triggers on Argo, stays quiet on St James, and the pooled tenant curve
  judges both at risk (the old false drop).
- "Little Feather case": a full block next to a Sundays-only flat — the flat's
  Monday factor is 0 at listing rung where the tenant pool said ~0.91.

## Decisions an auditor should scrutinise

1. **`GROUP_CURVE_MIN_BOOKINGS = 60`** is below the audit's ~100 stability rule —
   chosen deliberately so St James (93 pooled bookings, the smoking gun) keeps its
   own curve; the audit calls 50+ "usable coarse".
2. **Size-band cohorts exclude multi-unit stock** (blocks are not flat peers);
   multi-unit listings skip that rung entirely (listing → group → tenant).
3. **Occupancy denominators changed**: per-listing active window starts at the
   listing's first occupied fact (old scaler divided by the full 365d, understating
   new listings — harmless pooled, badly biased at listing grain), and removed
   listings' facts are excluded (they used to inflate the numerator only). Tenant-rung
   factors therefore shift slightly vs the shipped scaler.
4. **Threshold semantics sharpened**: with listing-grain occupancy, a listing whose
   DOW final occupancy is below `RISK_FILL_THRESHOLD` (0.5) can never trigger on that
   DOW (scaledFill = fill × occupancy < 0.5). Already true per-tenant; now per-listing.
   Judged correct (an empty night on a usually-empty listing is normal, and a drop
   suggestion is not the cure for chronic softness) but it is a behaviour change on
   weak listings.
5. **Bookings gate counts distinct `NightFact.reservationId`s** (null ids count
   zero); distribution n stays occupied nights, matching the old tenant gate.

## What parts B/C need to know

- Exports from `src/lib/observe/cohorts.ts` (all pure): `resolveCohortMemberships`
  (dimensions: listing / group / size_band / **city** / **stock** / tenant — city +
  stock are built for Part B's cuts and unused by the ladder), `buildCohortCurveSet`
  / `resolveCohortCurve`, `buildCohortOccupancySet` / `resolveCohortOccupancy`,
  `normaliseCityKey` (use this for the market-stratified global doc so the two
  Belfast tenants share one market key), the gate constants, and types
  `CohortProvenance { rung, cohortKey, n }`, `CohortRung` (includes reserved
  `"market" | "global"`), `ResolvedCohortCurve { buckets, medianLeadDays, provenance }`,
  `ResolvedCohortOccupancy { factors[7], provenance }`.
- `suggestions.ts` exports `SuggestionDetail { floorUnknown?, floor?, curveCohort?,
  occupancyCohort? }`; provenance is on every draft whose listing resolved (in
  practice: all). The ghost scorer's detail merge preserves these keys — Part B's
  calibration re-cuts can read `detail.curveCohort.rung`/`cohortKey` off scored rows.
- `SuggestionNightInput` gained optional `curve` and `occupancyProvenance`; the pure
  `buildSuggestionDrafts` falls back to the shared `buckets` when `curve` is absent.
- For Part C's readout/weekly-report copy: `ResolvedCohortCurve.medianLeadDays` is
  the per-cohort median ("your Argo apartments book about 8 weeks out"); build the
  set once per tenant via the same two queries used in `generateSuggestionsForClient`
  (listings + trailing-365d occupied NightFacts, both tenant-scoped).
- Per-cohort curve summaries are NOT yet persisted on the ClientProfile — Part C
  should compute them at readout/report time or add them to the profile then.
