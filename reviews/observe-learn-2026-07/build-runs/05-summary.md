> **Update 2026-07-04:** everything below was subsequently built, independently audited (SAFE, three auditors) and **deployed live** (prod `7500a9e`, then `9e71e9f` docs). TO DEPLOY blocks below are historical. See DECISIONS.md entry 2026-07-04.

# Build run 05 — Mine the historical rate-change record for drop dose-response

Prompt: `reviews/observe-learn-2026-07/BUILD-PROMPTS/05-mine-historical-drop-outcomes.md`
Branch: `feat/observe-learn-fixes-2026-07` · Starting commit: `44dad1b` · Date: 2026-07-03/04 (overnight, autonomous)

## TO DEPLOY / TO REVIEW (nothing deployed by this run — Mark was asleep)

**Nothing web-facing changed and nothing needs deploying.** This run is analysis-only:
a pure library, a read-only script, and report artefacts. The suggestion engine, workers,
routes and schema are untouched; no migration exists. Recommendation: **keep local** —
deploying `main` later ships the new files harmlessly (nothing imports them at runtime).

**TO REVIEW instead:** the prod dose-response report at
`observe-reports/drop-outcomes-prod-2026-07-03.md` (JSON alongside). It is the first
data-backed answer to "when this client drops X% at lead Y, how often does the night fill
vs matched un-dropped nights" and is the evidence input for the future suggestion-sizing
change (which is out of scope here and was NOT made).

## What was built (one fix per commit)

| Commit | Change |
|---|---|
| `38bf9d3` | **Pure mining lib** `src/lib/observe/drop-outcomes.ts` + 21 unit tests (wired into `test:observe`). Episode collapsing (listing × scan × contiguous stay-date span — a 30-date sweep is ONE episode), the 3% RMS noise floor (median detected change is ~0.9% wiggle), stay-dates-before-detection discarded, drop-size bands 3-7% / 7-15% / 15%+, lead buckets reuse the canonical `LEAD_TIME_BUCKETS`, weekend = Fri/Sat (same rule as `learnings.dateTypeFor`), deterministic stratified sampling spread across FULL history per listing (never newest-first), within-listing matched controls (same listing, same DOW, ±21d, un-dropped, terminal state known, still unbooked at the treated lead), and `(leadBucket, dropSizeBand, dateType)` cell aggregation with per-cell `n` everywhere. |
| `980b60f` | **Runner** `scripts/mine-drop-outcomes.ts`. Tenant-scoped queries only (house rule) over `rate_changes`, `night_facts`, `calendar_rates`, `booking_rate_contexts`; occupied market fill excludes `ownerstay` and ≤£5 artefact rows (build-04 convention); empty nights count only when the calendar visibly showed them still open (blocked/unknown nights are excluded, not counted empty); cancellations from cancelled night facts booked inside the 14-day window. `--prod` reads `DATABASE_PUBLIC_URL`; the script performs `findMany` reads only and persists nothing to any DB — reports under `observe-reports/` per the prompt's v1 preference (no new table, no migration). |
| `30fd06c` | Renderer fix: show the matched-subset treated fill so the matched-pairs Δpp is legible next to its own two inputs. |
| `5c54838` | Report artefacts: local correctness run + the prod read-only run. |
| (this commit) | Build-run summary. |

## Episode counts per tenant (prod, read-only)

| Tenant | Episodes (≥3% drop sweeps) | Listings | Treated settled nights | Skipped: unsettled / unknown-terminal / repeat-drop / no-record |
|---|---|---|---|---|
| Coorie Doon Stays | 6,452 | 42 | 443 | 9,340 / 6 / 634 / 29 |
| Little Feather Management | 5,493 | 39 | 275 | 8,804 / 21 / 993 / 10 |
| Stay Belfast | 3,142 | 15 | 161 | 3,714 / 11 / 352 / 16 |
| Yo's House & Short Stay Harrogate | 5,201 | 31 | 325 | 6,526 / 12 / 551 / 7 |
| Escape Ordinary / Demo PM | 0 | 0 | 0 | scanner does not cover them |
| **Total** | **20,288** | **127** | **1,204** | |

Correctness reconciliation: per tenant, `treated + unknown-terminal + no-record` equals the
SQL `count(DISTINCT (listing_id, date))` of settled qualifying drop rows exactly (prod:
478/306/188/344; local dev DB reconciles the same way). The huge "unsettled" counts are
expected — the scanner only started 2026-06-02, so most dropped stay dates have not passed.

## Headline dose-response (pooled, matched-pairs, honest)

From `observe-reports/drop-outcomes-prod-2026-07-03.md` (Δpp = treated fill − own matched
controls' fill, within listing; cells below the n=20 matched threshold are flagged in the
report, not repeated here):

- **Lead 4-7d:** drops fill ahead of matched controls at every dose — 3-7%: +17.0pp
  (n=61 matched), 7-15%: +11.1pp (n=70), 15%+: +11.0pp (n=37), weekday. Realised rate
  lands ~72-73% of the advertised pre-drop rate; rate ratio vs controls ≈ 0.96-1.11.
- **Lead 8-14d:** 7-15% drops +19.7pp weekday (n=60), +32.7pp weekend (n=26); but 3-7%
  weekday is **-11.0pp** (n=101) — the small-cut band underperforms its controls here.
- **Lead 15-30d:** every weekday band is negative (3-7%: -7.3pp n=75; 7-15%: -13.7pp n=45;
  15%+: -20.8pp n=12) and cancellation rates roughly double (10-21%). With selection-on-
  weakness biasing AGAINST drops, the honest reading is "no demonstrated benefit at this
  lead", not "drops hurt".
- **Lead 0-3d:** everything is insufficient matched controls (n<20) except 2-3d 3-7%
  weekday (+18.8pp, n=20, borderline).
- Larger cuts consistently buy fill, not rate: 15%+ cells realise ~42-72% of pre-drop rate.

Every number above is observational and bounded by the caveats block at the top of the
report (selection on weakness, matching limits, terminal-state proxy, denominator
mismatch, one month of history — long-lead cells are thin by construction).

## Test evidence (full green gate at `5c54838`)

- `npm run typecheck` — exit 0
- `npm run lint -- --max-warnings=0` — exit 0
- `npm run test:tenant-isolation` — "Tenant isolation check passed."
- `npm run test:observe` — **163/163 pass** (142 at baseline; +21 new `drop-outcomes.test.ts`:
  30-date sweep is one episode, gap/scan splits, 3% noise floor incl. boundary and rises,
  stale detections discarded, band boundaries, bucket labels, match-key construction,
  weekend rule, stratified sampler spans history and caps per listing, terminal-state and
  unbooked-at-lead predicates, timestamp + lead fallback fill windows, matching exclusions,
  end-to-end analyse/aggregate incl. repeat-drop attribution and cancellation rate).

## Notes for auditors

- **Prod access was SELECT-only**: Prisma `findMany` reads via `DATABASE_PUBLIC_URL`; the
  only writes were report files in the repo. No migration exists anywhere in this run.
- The suggestion engine (`suggestions.ts`) is untouched per the prompt — this run gathers
  the evidence; a later prompt consumes it.
- Repeat-dropped stay dates (a night cut again in a later scan) are attributed to their
  FIRST episode; later cuts land inside the 14-day outcome window as dose contamination
  (634/993/352/551 such rows per tenant above) — stated in the report caveats.
- `matchKey` exists and is unit-tested as the stratum definition; `matchedControls`
  implements the same stratum directly (DOW loop + lead eligibility) rather than routing
  through the string key.
- The 400-episodes-per-listing sampling cap never bound at current scale (max ~154/listing);
  the stratified sampler is tested and ready for when the record grows.
- Local dev DB `daily_aggs`-free path: terminal empties come from `calendar_rates.available`
  on past dates (46k prod rows) — nights with neither an occupied fact nor a visible open
  calendar day were excluded (50 nights prod-wide), never counted as empty.
- Pre-existing untracked files (`.claude/`, `RELIABILITY-FINDINGS.md`, `trial-reports/`)
  were present before this run and left alone.
