# Drop dose-response — retrospective mining of the rate-change record

Generated 2026-07-03T22:04:56.693Z against the **local** database (read-only). Settled nights only (stay date before 2026-07-03). Noise floor 3%; fill window 14 days after detection; controls matched within ±21 days, same listing, same day-of-week, still unbooked at the treated lead; episode cap 400/listing (stratified across full history).

## Read this first — caveats that bound every number below

- **Observational, not causal.** Nobody randomised these drops. Every comparison inherits the decision rule that produced the drop.
- **Selection on weakness.** Drops happen to nights that look weak (empty, behind pace). Matched controls of the same listing were, by construction, nights the engine/host chose NOT to cut — typically stronger. Uncorrected deltas are therefore biased AGAINST drops: a true drop benefit will look smaller than it is, and a negative delta does not prove drops hurt.
- **Matching limits.** Same listing + day-of-week + ±21d + still-unbooked-at-lead kills between-listing selection and coarse seasonality only. It does not control within-listing time-varying demand (an event week vs a dead week three weeks apart), repeat cuts landing inside the 14-day window (dose contamination — repeat-dropped stay dates are attributed to their FIRST episode), multi-unit part-availability, or cancelled-then-rebooked control eligibility edge cases.
- **Terminal state proxy.** An empty night counts only when the calendar visibly showed it still open (available) at last observation; nights that ended blocked or unobserved are excluded, not counted empty.
- **Denominator mismatch.** "Realised % of pre-drop rate" divides realised net revenue per night (revenue_allocated) by the advertised pre-drop rate — channel fees and discounts sit in the numerator only, so the level is deflated; compare cells against each other, not against 100%.
- **History depth.** The scanner has been recording since 2026-06-02; settled treated nights are short-lead by construction (a June drop for a December stay has not settled). Long-lead cells will stay thin until the record ages.
- **Reading Δ fill pp.** The delta is MATCHED-PAIRS: each treated night against its own controls, averaged over the matched subset only. Compare it with "Treated fill (matched)" vs "Control fill 14d"; the all-treated fill column includes unmatched nights and can disagree in sign.

## All clients pooled (78 treated settled nights)

| Lead (d) | Drop size | Date type | Episodes | Treated n | Treated fill 14d | Treated fill (matched) | Control fill 14d (matched/controls) | Δ fill pp | Realised % of pre-drop | Rate ratio vs controls | Cancel rate | Mean days to book | Note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0-1 | 3-7% | weekday | 4 | 5 | 0.0% | 0.0% | 8.3% (n=4/10) | -8.3 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 0-1 | 7-15% | weekday | 13 | 15 | 0.0% | 0.0% | 0.0% (n=10/20) | 0.0 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 0-1 | 15%+ | weekday | 14 | 16 | 0.0% | 0.0% | 0.0% (n=10/27) | 0.0 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 2-3 | 3-7% | weekday | 14 | 15 | 0.0% | 0.0% | 10.3% (n=13/30) | -10.3 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 2-3 | 7-15% | weekday | 13 | 16 | 0.0% | 0.0% | 6.4% (n=13/34) | -6.4 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 2-3 | 15%+ | weekday | 7 | 10 | 0.0% | 0.0% | 12.5% (n=8/17) | -12.5 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 4-7 | 3-7% | weekday | 1 | 1 | 0.0% | 0.0% | 0.0% (n=1/1) | 0.0 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |

## Avantio Demo

Episodes found: 0 (sampled 0) across 0 listings. Treated settled nights: 0 (skipped — not yet settled: 0, terminal state unknown/blocked: 0, repeat drops on an already-treated night: 0, no night record: 0).

No settled treated nights yet — nothing to tabulate.

## Coorie Doon Stays

Episodes found: 1061 (sampled 1061) across 42 listings. Treated settled nights: 17 (skipped — not yet settled: 1642, terminal state unknown/blocked: 0, repeat drops on an already-treated night: 3, no night record: 0).

| Lead (d) | Drop size | Date type | Episodes | Treated n | Treated fill 14d | Treated fill (matched) | Control fill 14d (matched/controls) | Δ fill pp | Realised % of pre-drop | Rate ratio vs controls | Cancel rate | Mean days to book | Note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0-1 | 7-15% | weekday | 2 | 2 | 0.0% | 0.0% | 0.0% (n=2/5) | 0.0 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 0-1 | 15%+ | weekday | 6 | 6 | 0.0% | 0.0% | 0.0% (n=5/14) | 0.0 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 2-3 | 3-7% | weekday | 4 | 4 | 0.0% | 0.0% | 0.0% (n=4/10) | 0.0 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 2-3 | 7-15% | weekday | 2 | 3 | 0.0% | 0.0% | 0.0% (n=3/8) | 0.0 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 2-3 | 15%+ | weekday | 2 | 2 | 0.0% | 0.0% | 0.0% (n=2/5) | 0.0 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |

## Escape Ordinary

Episodes found: 0 (sampled 0) across 0 listings. Treated settled nights: 0 (skipped — not yet settled: 0, terminal state unknown/blocked: 0, repeat drops on an already-treated night: 0, no night record: 0).

No settled treated nights yet — nothing to tabulate.

## Little Feather Management

Episodes found: 1684 (sampled 1684) across 39 listings. Treated settled nights: 33 (skipped — not yet settled: 3458, terminal state unknown/blocked: 4, repeat drops on an already-treated night: 17, no night record: 4).

| Lead (d) | Drop size | Date type | Episodes | Treated n | Treated fill 14d | Treated fill (matched) | Control fill 14d (matched/controls) | Δ fill pp | Realised % of pre-drop | Rate ratio vs controls | Cancel rate | Mean days to book | Note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0-1 | 3-7% | weekday | 3 | 4 | 0.0% | 0.0% | 11.1% (n=3/8) | -11.1 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 0-1 | 7-15% | weekday | 9 | 11 | 0.0% | 0.0% | 0.0% (n=6/10) | 0.0 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 0-1 | 15%+ | weekday | 4 | 4 | 0.0% | 0.0% | 0.0% (n=1/2) | 0.0 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 2-3 | 3-7% | weekday | 5 | 5 | 0.0% | 0.0% | 33.3% (n=4/8) | -33.3 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 2-3 | 7-15% | weekday | 7 | 7 | 0.0% | 0.0% | 20.8% (n=4/9) | -20.8 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 2-3 | 15%+ | weekday | 2 | 2 | 0.0% | 0.0% | 50.0% (n=2/2) | -50.0 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |

## Stay Belfast Apartments

Episodes found: 547 (sampled 547) across 15 listings. Treated settled nights: 11 (skipped — not yet settled: 711, terminal state unknown/blocked: 2, repeat drops on an already-treated night: 16, no night record: 1).

| Lead (d) | Drop size | Date type | Episodes | Treated n | Treated fill 14d | Treated fill (matched) | Control fill 14d (matched/controls) | Δ fill pp | Realised % of pre-drop | Rate ratio vs controls | Cancel rate | Mean days to book | Note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0-1 | 3-7% | weekday | 1 | 1 | 0.0% | 0.0% | 0.0% (n=1/2) | 0.0 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 0-1 | 7-15% | weekday | 2 | 2 | 0.0% | 0.0% | 0.0% (n=2/5) | 0.0 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 0-1 | 15%+ | weekday | 2 | 2 | 0.0% | 0.0% | 0.0% (n=2/5) | 0.0 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 2-3 | 3-7% | weekday | 3 | 4 | 0.0% | 0.0% | 0.0% (n=4/10) | 0.0 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 2-3 | 7-15% | weekday | 2 | 2 | 0.0% | 0.0% | 0.0% (n=2/5) | 0.0 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |

## Yo's House/Short Stay Harrogate

Episodes found: 841 (sampled 841) across 31 listings. Treated settled nights: 17 (skipped — not yet settled: 1089, terminal state unknown/blocked: 0, repeat drops on an already-treated night: 6, no night record: 9).

| Lead (d) | Drop size | Date type | Episodes | Treated n | Treated fill 14d | Treated fill (matched) | Control fill 14d (matched/controls) | Δ fill pp | Realised % of pre-drop | Rate ratio vs controls | Cancel rate | Mean days to book | Note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0-1 | 15%+ | weekday | 2 | 4 | 0.0% | 0.0% | 0.0% (n=2/6) | 0.0 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 2-3 | 3-7% | weekday | 2 | 2 | 0.0% | 0.0% | 0.0% (n=1/2) | 0.0 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 2-3 | 7-15% | weekday | 2 | 4 | 0.0% | 0.0% | 0.0% (n=4/12) | 0.0 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 2-3 | 15%+ | weekday | 3 | 6 | 0.0% | 0.0% | 0.0% (n=4/10) | 0.0 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 4-7 | 3-7% | weekday | 1 | 1 | 0.0% | 0.0% | 0.0% (n=1/1) | 0.0 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |

_Cells with fewer than 20 matched treated nights are marked "insufficient matched controls" — read them as anecdotes, not signal. Produced by `scripts/mine-drop-outcomes.ts`; pure logic in `src/lib/observe/drop-outcomes.ts`._
