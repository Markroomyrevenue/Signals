# Drop dose-response — retrospective mining of the rate-change record

Generated 2026-07-03T22:04:57.202Z against the **prod** database (read-only). Settled nights only (stay date before 2026-07-03). Noise floor 3%; fill window 14 days after detection; controls matched within ±21 days, same listing, same day-of-week, still unbooked at the treated lead; episode cap 400/listing (stratified across full history).

## Read this first — caveats that bound every number below

- **Observational, not causal.** Nobody randomised these drops. Every comparison inherits the decision rule that produced the drop.
- **Selection on weakness.** Drops happen to nights that look weak (empty, behind pace). Matched controls of the same listing were, by construction, nights the engine/host chose NOT to cut — typically stronger. Uncorrected deltas are therefore biased AGAINST drops: a true drop benefit will look smaller than it is, and a negative delta does not prove drops hurt.
- **Matching limits.** Same listing + day-of-week + ±21d + still-unbooked-at-lead kills between-listing selection and coarse seasonality only. It does not control within-listing time-varying demand (an event week vs a dead week three weeks apart), repeat cuts landing inside the 14-day window (dose contamination — repeat-dropped stay dates are attributed to their FIRST episode), multi-unit part-availability, or cancelled-then-rebooked control eligibility edge cases.
- **Terminal state proxy.** An empty night counts only when the calendar visibly showed it still open (available) at last observation; nights that ended blocked or unobserved are excluded, not counted empty.
- **Denominator mismatch.** "Realised % of pre-drop rate" divides realised net revenue per night (revenue_allocated) by the advertised pre-drop rate — channel fees and discounts sit in the numerator only, so the level is deflated; compare cells against each other, not against 100%.
- **History depth.** The scanner has been recording since 2026-06-02; settled treated nights are short-lead by construction (a June drop for a December stay has not settled). Long-lead cells will stay thin until the record ages.
- **Reading Δ fill pp.** The delta is MATCHED-PAIRS: each treated night against its own controls, averaged over the matched subset only. Compare it with "Treated fill (matched)" vs "Control fill 14d"; the all-treated fill column includes unmatched nights and can disagree in sign.

## All clients pooled (1204 treated settled nights)

| Lead (d) | Drop size | Date type | Episodes | Treated n | Treated fill 14d | Treated fill (matched) | Control fill 14d (matched/controls) | Δ fill pp | Realised % of pre-drop | Rate ratio vs controls | Cancel rate | Mean days to book | Note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0-1 | 3-7% | weekday | 11 | 12 | 25.0% | 33.3% | 11.1% (n=9/15) | 22.2 | 75.8% (n=3) | — (n=0) | 0.0% (n=3) | 0.3 | insufficient matched controls |
| 0-1 | 3-7% | weekend | 2 | 2 | 0.0% | — | — (n=0/0) | — | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 0-1 | 7-15% | weekday | 7 | 10 | 10.0% | 0.0% | 0.0% (n=4/5) | 0.0 | 101.1% (n=1) | — (n=0) | 0.0% (n=1) | 0.1 | insufficient matched controls |
| 0-1 | 7-15% | weekend | 6 | 7 | 14.3% | 50.0% | 50.0% (n=2/2) | 0.0 | 53.1% (n=1) | — (n=0) | 0.0% (n=1) | 0.1 | insufficient matched controls |
| 0-1 | 15%+ | weekday | 13 | 15 | 33.3% | 16.7% | 0.0% (n=6/7) | 16.7 | 71.1% (n=5) | — (n=0) | 0.0% (n=5) | 0.5 | insufficient matched controls |
| 0-1 | 15%+ | weekend | 4 | 4 | 25.0% | 50.0% | 0.0% (n=2/3) | 50.0 | 48.0% (n=1) | — (n=0) | 0.0% (n=1) | 0.1 | insufficient matched controls |
| 2-3 | 3-7% | weekday | 26 | 29 | 34.5% | 40.0% | 21.3% (n=20/30) | 18.8 | 86.5% (n=10) | 1.22 (n=3) | 0.0% (n=10) | 1.2 |  |
| 2-3 | 3-7% | weekend | 4 | 5 | 60.0% | 66.7% | 66.7% (n=3/3) | 0.0 | 77.6% (n=3) | 0.87 (n=1) | 0.0% (n=3) | 0.3 | insufficient matched controls |
| 2-3 | 7-15% | weekday | 8 | 10 | 30.0% | 50.0% | 25.0% (n=6/12) | 25.0 | 85.6% (n=3) | 0.86 (n=1) | 0.0% (n=3) | 0.7 | insufficient matched controls |
| 2-3 | 7-15% | weekend | 8 | 8 | 75.0% | 66.7% | 11.1% (n=3/5) | 55.6 | 68.1% (n=6) | 0.75 (n=1) | 0.0% (n=6) | 1.4 | insufficient matched controls |
| 2-3 | 15%+ | weekday | 6 | 7 | 28.6% | 40.0% | 0.0% (n=5/8) | 40.0 | 69.5% (n=2) | — (n=0) | 0.0% (n=2) | 1.1 | insufficient matched controls |
| 2-3 | 15%+ | weekend | 13 | 15 | 73.3% | 80.0% | 33.3% (n=10/18) | 46.7 | 63.2% (n=11) | 0.71 (n=6) | 0.0% (n=11) | 1.1 | insufficient matched controls |
| 4-7 | 3-7% | weekday | 67 | 95 | 58.9% | 55.7% | 38.7% (n=61/123) | 17.0 | 72.6% (n=56) | 0.96 (n=23) | 1.8% (n=57) | 3.1 |  |
| 4-7 | 3-7% | weekend | 21 | 23 | 47.8% | 70.0% | 56.7% (n=10/21) | 13.3 | 60.7% (n=11) | 0.86 (n=6) | 9.1% (n=11) | 3.9 | insufficient matched controls |
| 4-7 | 7-15% | weekday | 89 | 116 | 53.4% | 44.3% | 33.2% (n=70/111) | 11.1 | 73.2% (n=62) | 1.00 (n=16) | 4.6% (n=65) | 3.4 |  |
| 4-7 | 7-15% | weekend | 24 | 24 | 79.2% | 90.0% | 56.7% (n=10/12) | 33.3 | 64.5% (n=19) | 0.80 (n=5) | 10.5% (n=19) | 3.1 | insufficient matched controls |
| 4-7 | 15%+ | weekday | 40 | 57 | 54.4% | 51.4% | 40.3% (n=37/59) | 11.0 | 72.4% (n=31) | 1.11 (n=9) | 6.1% (n=33) | 2.0 |  |
| 4-7 | 15%+ | weekend | 9 | 10 | 90.0% | 80.0% | 46.7% (n=5/9) | 33.3 | 41.7% (n=9) | 0.55 (n=3) | 0.0% (n=9) | 3.2 | insufficient matched controls |
| 8-14 | 3-7% | weekday | 125 | 146 | 49.3% | 43.6% | 54.5% (n=101/171) | -11.0 | 71.4% (n=72) | 1.06 (n=35) | 4.1% (n=74) | 5.8 |  |
| 8-14 | 3-7% | weekend | 30 | 31 | 67.7% | 73.7% | 68.9% (n=19/28) | 4.8 | 56.0% (n=21) | 0.95 (n=12) | 9.1% (n=22) | 7.6 | insufficient matched controls |
| 8-14 | 7-15% | weekday | 62 | 98 | 63.3% | 66.7% | 46.9% (n=60/105) | 19.7 | 74.1% (n=62) | 1.09 (n=22) | 10.9% (n=64) | 6.1 |  |
| 8-14 | 7-15% | weekend | 35 | 42 | 88.1% | 88.5% | 55.8% (n=26/42) | 32.7 | 61.1% (n=37) | 0.99 (n=13) | 8.1% (n=37) | 6.9 |  |
| 8-14 | 15%+ | weekday | 27 | 38 | 52.6% | 42.9% | 34.9% (n=21/35) | 7.9 | 62.7% (n=20) | 1.01 (n=4) | 10.0% (n=20) | 4.9 |  |
| 8-14 | 15%+ | weekend | 9 | 11 | 27.3% | 0.0% | 50.0% (n=4/6) | -50.0 | 65.8% (n=3) | — (n=0) | 0.0% (n=3) | 3.7 | insufficient matched controls |
| 15-30 | 3-7% | weekday | 151 | 183 | 31.7% | 38.7% | 46.0% (n=75/108) | -7.3 | 76.9% (n=58) | 1.20 (n=18) | 9.8% (n=61) | 7.6 |  |
| 15-30 | 3-7% | weekend | 41 | 47 | 42.6% | 59.3% | 61.7% (n=27/47) | -2.5 | 57.8% (n=20) | 1.02 (n=13) | 22.7% (n=22) | 8.4 |  |
| 15-30 | 7-15% | weekday | 66 | 100 | 27.0% | 37.8% | 51.5% (n=45/56) | -13.7 | 68.3% (n=27) | 1.14 (n=12) | 21.2% (n=33) | 7.0 |  |
| 15-30 | 7-15% | weekend | 17 | 21 | 57.1% | 85.7% | 64.3% (n=7/9) | 21.4 | 60.6% (n=12) | 0.95 (n=4) | 14.3% (n=14) | 7.8 | insufficient matched controls |
| 15-30 | 15%+ | weekday | 14 | 29 | 55.2% | 50.0% | 70.8% (n=12/15) | -20.8 | 57.7% (n=16) | 1.28 (n=4) | 11.1% (n=18) | 5.1 | insufficient matched controls |
| 15-30 | 15%+ | weekend | 4 | 9 | 66.7% | 66.7% | 33.3% (n=3/4) | 33.3 | 57.3% (n=6) | — (n=0) | 0.0% (n=6) | 5.2 | insufficient matched controls |

## Coorie Doon Stays

Episodes found: 6452 (sampled 6452) across 44 listings. Treated settled nights: 443 (skipped — not yet settled: 9340, terminal state unknown/blocked: 6, repeat drops on an already-treated night: 634, no night record: 29).

| Lead (d) | Drop size | Date type | Episodes | Treated n | Treated fill 14d | Treated fill (matched) | Control fill 14d (matched/controls) | Δ fill pp | Realised % of pre-drop | Rate ratio vs controls | Cancel rate | Mean days to book | Note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0-1 | 3-7% | weekday | 3 | 3 | 0.0% | 0.0% | 0.0% (n=1/1) | 0.0 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 0-1 | 3-7% | weekend | 1 | 1 | 0.0% | — | — (n=0/0) | — | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 0-1 | 7-15% | weekday | 1 | 1 | 0.0% | — | — (n=0/0) | — | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 0-1 | 7-15% | weekend | 4 | 5 | 0.0% | 0.0% | 100.0% (n=1/1) | -100.0 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 0-1 | 15%+ | weekday | 1 | 1 | 0.0% | — | — (n=0/0) | — | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 2-3 | 3-7% | weekday | 16 | 18 | 22.2% | 20.0% | 32.5% (n=10/16) | -12.5 | 89.1% (n=4) | 0.82 (n=2) | 0.0% (n=4) | 1.6 | insufficient matched controls |
| 2-3 | 3-7% | weekend | 1 | 1 | 0.0% | 0.0% | 100.0% (n=1/1) | -100.0 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 2-3 | 7-15% | weekday | 5 | 7 | 28.6% | 50.0% | 37.5% (n=4/8) | 12.5 | 75.7% (n=2) | 0.86 (n=1) | 0.0% (n=2) | 0.7 | insufficient matched controls |
| 2-3 | 7-15% | weekend | 3 | 3 | 100.0% | — | — (n=0/0) | — | 70.2% (n=3) | — (n=0) | 0.0% (n=3) | 1.6 | insufficient matched controls |
| 2-3 | 15%+ | weekend | 3 | 3 | 0.0% | 0.0% | 0.0% (n=2/4) | 0.0 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 4-7 | 3-7% | weekday | 27 | 39 | 48.7% | 41.7% | 53.1% (n=24/31) | -11.5 | 71.6% (n=19) | 1.02 (n=6) | 5.0% (n=20) | 2.8 |  |
| 4-7 | 3-7% | weekend | 13 | 15 | 40.0% | 80.0% | 60.0% (n=5/10) | 20.0 | 62.2% (n=6) | 0.75 (n=3) | 0.0% (n=6) | 4.1 | insufficient matched controls |
| 4-7 | 7-15% | weekday | 25 | 34 | 55.9% | 56.0% | 40.7% (n=25/44) | 15.3 | 74.1% (n=19) | 0.91 (n=8) | 9.5% (n=21) | 4.0 |  |
| 4-7 | 7-15% | weekend | 10 | 10 | 60.0% | 100.0% | 50.0% (n=2/2) | 50.0 | 74.1% (n=6) | 0.75 (n=1) | 0.0% (n=6) | 2.9 | insufficient matched controls |
| 4-7 | 15%+ | weekday | 8 | 12 | 66.7% | 25.0% | 0.0% (n=4/5) | 25.0 | 69.5% (n=8) | — (n=0) | 0.0% (n=8) | 2.3 | insufficient matched controls |
| 4-7 | 15%+ | weekend | 1 | 1 | 0.0% | 0.0% | 0.0% (n=1/2) | 0.0 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 8-14 | 3-7% | weekday | 52 | 62 | 43.5% | 38.6% | 51.5% (n=44/67) | -12.9 | 77.4% (n=27) | 1.11 (n=14) | 3.7% (n=27) | 5.6 |  |
| 8-14 | 3-7% | weekend | 12 | 13 | 69.2% | 75.0% | 78.1% (n=8/14) | -3.1 | 58.2% (n=9) | 0.79 (n=6) | 11.1% (n=9) | 8.8 | insufficient matched controls |
| 8-14 | 7-15% | weekday | 18 | 35 | 65.7% | 72.0% | 45.3% (n=25/44) | 26.7 | 76.7% (n=23) | 1.05 (n=9) | 4.3% (n=23) | 6.1 |  |
| 8-14 | 7-15% | weekend | 14 | 15 | 100.0% | 100.0% | 50.0% (n=9/13) | 50.0 | 66.3% (n=15) | 1.12 (n=5) | 0.0% (n=15) | 8.1 | insufficient matched controls |
| 8-14 | 15%+ | weekday | 5 | 9 | 66.7% | 40.0% | 20.0% (n=5/7) | 20.0 | 61.6% (n=6) | — (n=0) | 16.7% (n=6) | 4.4 | insufficient matched controls |
| 8-14 | 15%+ | weekend | 2 | 3 | 33.3% | 0.0% | 0.0% (n=2/2) | 0.0 | 65.6% (n=1) | — (n=0) | 0.0% (n=1) | 4.9 | insufficient matched controls |
| 15-30 | 3-7% | weekday | 67 | 90 | 30.0% | 35.1% | 38.7% (n=37/49) | -3.6 | 73.7% (n=27) | 0.96 (n=6) | 10.0% (n=30) | 8.8 |  |
| 15-30 | 3-7% | weekend | 9 | 9 | 22.2% | 50.0% | 50.0% (n=4/7) | 0.0 | 63.7% (n=2) | 1.01 (n=1) | 0.0% (n=2) | 12.4 | insufficient matched controls |
| 15-30 | 7-15% | weekday | 17 | 29 | 37.9% | 40.0% | 46.7% (n=15/18) | -6.7 | 70.6% (n=11) | 1.11 (n=5) | 0.0% (n=11) | 6.5 | insufficient matched controls |
| 15-30 | 7-15% | weekend | 6 | 7 | 57.1% | 75.0% | 62.5% (n=4/5) | 12.5 | 58.6% (n=4) | 0.84 (n=2) | 0.0% (n=4) | 6.6 | insufficient matched controls |
| 15-30 | 15%+ | weekday | 2 | 13 | 61.5% | 50.0% | 0.0% (n=2/2) | 50.0 | 60.2% (n=8) | — (n=0) | 0.0% (n=8) | 3.4 | insufficient matched controls |
| 15-30 | 15%+ | weekend | 1 | 4 | 75.0% | 100.0% | 0.0% (n=2/2) | 100.0 | 56.5% (n=3) | — (n=0) | 0.0% (n=3) | 7.3 | insufficient matched controls |

## Demo Property Manager

Episodes found: 0 (sampled 0) across 0 listings. Treated settled nights: 0 (skipped — not yet settled: 0, terminal state unknown/blocked: 0, repeat drops on an already-treated night: 0, no night record: 0).

No settled treated nights yet — nothing to tabulate.

## Escape Ordinary

Episodes found: 0 (sampled 0) across 0 listings. Treated settled nights: 0 (skipped — not yet settled: 0, terminal state unknown/blocked: 0, repeat drops on an already-treated night: 0, no night record: 0).

No settled treated nights yet — nothing to tabulate.

## Little Feather Management

Episodes found: 5493 (sampled 5493) across 33 listings. Treated settled nights: 275 (skipped — not yet settled: 8804, terminal state unknown/blocked: 21, repeat drops on an already-treated night: 993, no night record: 10).

| Lead (d) | Drop size | Date type | Episodes | Treated n | Treated fill 14d | Treated fill (matched) | Control fill 14d (matched/controls) | Δ fill pp | Realised % of pre-drop | Rate ratio vs controls | Cancel rate | Mean days to book | Note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0-1 | 7-15% | weekday | 3 | 4 | 25.0% | 0.0% | 0.0% (n=2/3) | 0.0 | 101.1% (n=1) | — (n=0) | 0.0% (n=1) | 0.1 | insufficient matched controls |
| 0-1 | 7-15% | weekend | 1 | 1 | 0.0% | — | — (n=0/0) | — | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 0-1 | 15%+ | weekday | 6 | 8 | 37.5% | 33.3% | 0.0% (n=3/4) | 33.3 | 72.1% (n=3) | — (n=0) | 0.0% (n=3) | 0.1 | insufficient matched controls |
| 0-1 | 15%+ | weekend | 2 | 2 | 0.0% | 0.0% | 0.0% (n=1/2) | 0.0 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 2-3 | 3-7% | weekday | 1 | 1 | 0.0% | 0.0% | 0.0% (n=1/1) | 0.0 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 2-3 | 3-7% | weekend | 1 | 1 | 0.0% | — | — (n=0/0) | — | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 2-3 | 15%+ | weekday | 2 | 3 | 0.0% | 0.0% | 0.0% (n=2/5) | 0.0 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 2-3 | 15%+ | weekend | 2 | 2 | 100.0% | 100.0% | 0.0% (n=1/1) | 100.0 | 68.7% (n=2) | — (n=0) | 0.0% (n=2) | 0.1 | insufficient matched controls |
| 4-7 | 3-7% | weekday | 6 | 7 | 57.1% | 33.3% | 16.7% (n=3/5) | 16.7 | 62.8% (n=4) | 0.74 (n=1) | 0.0% (n=4) | 5.4 | insufficient matched controls |
| 4-7 | 7-15% | weekday | 18 | 20 | 40.0% | 37.5% | 43.8% (n=8/11) | -6.3 | 62.4% (n=8) | 0.75 (n=2) | 0.0% (n=8) | 3.7 | insufficient matched controls |
| 4-7 | 7-15% | weekend | 5 | 5 | 100.0% | 100.0% | 88.9% (n=3/5) | 11.1 | 52.3% (n=5) | 0.81 (n=3) | 20.0% (n=5) | 4.5 | insufficient matched controls |
| 4-7 | 15%+ | weekday | 12 | 19 | 31.6% | 38.5% | 23.1% (n=13/20) | 15.4 | 70.3% (n=6) | 1.03 (n=1) | 25.0% (n=8) | 2.3 | insufficient matched controls |
| 4-7 | 15%+ | weekend | 3 | 3 | 100.0% | 100.0% | 0.0% (n=1/2) | 100.0 | 50.4% (n=3) | — (n=0) | 0.0% (n=3) | 5.0 | insufficient matched controls |
| 8-14 | 3-7% | weekday | 36 | 39 | 48.7% | 38.1% | 40.5% (n=21/28) | -2.4 | 59.1% (n=19) | 1.00 (n=5) | 9.5% (n=21) | 6.2 |  |
| 8-14 | 3-7% | weekend | 12 | 12 | 66.7% | 66.7% | 58.3% (n=6/7) | 8.3 | 56.3% (n=8) | 1.13 (n=3) | 11.1% (n=9) | 7.7 | insufficient matched controls |
| 8-14 | 7-15% | weekday | 19 | 24 | 75.0% | 90.9% | 51.5% (n=11/17) | 39.4 | 62.0% (n=18) | 1.15 (n=6) | 15.8% (n=19) | 7.2 | insufficient matched controls |
| 8-14 | 7-15% | weekend | 9 | 10 | 80.0% | 83.3% | 83.3% (n=6/9) | 0.0 | 45.8% (n=8) | 0.88 (n=4) | 37.5% (n=8) | 6.7 | insufficient matched controls |
| 8-14 | 15%+ | weekday | 9 | 9 | 55.6% | 50.0% | 44.4% (n=6/13) | 5.6 | 58.0% (n=5) | 0.93 (n=2) | 20.0% (n=5) | 6.3 | insufficient matched controls |
| 8-14 | 15%+ | weekend | 2 | 2 | 0.0% | 0.0% | 100.0% (n=2/4) | -100.0 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 15-30 | 3-7% | weekday | 38 | 45 | 24.4% | 14.3% | 64.3% (n=14/16) | -50.0 | 80.9% (n=11) | 2.13 (n=2) | 0.0% (n=11) | 6.8 | insufficient matched controls |
| 15-30 | 3-7% | weekend | 9 | 12 | 16.7% | 40.0% | 100.0% (n=5/5) | -60.0 | 30.1% (n=2) | 0.88 (n=2) | 0.0% (n=2) | 12.0 | insufficient matched controls |
| 15-30 | 7-15% | weekday | 19 | 29 | 10.3% | 30.0% | 85.0% (n=10/11) | -55.0 | 58.3% (n=3) | 1.50 (n=2) | 60.0% (n=5) | 7.6 | insufficient matched controls |
| 15-30 | 7-15% | weekend | 2 | 4 | 0.0% | — | — (n=0/0) | — | — (n=0) | — (n=0) | 100.0% (n=1) | — | insufficient matched controls |
| 15-30 | 15%+ | weekday | 6 | 8 | 50.0% | 57.1% | 92.9% (n=7/10) | -35.7 | 65.8% (n=4) | 1.28 (n=4) | 20.0% (n=5) | 3.1 | insufficient matched controls |
| 15-30 | 15%+ | weekend | 3 | 5 | 60.0% | 0.0% | 100.0% (n=1/2) | -100.0 | 58.0% (n=3) | — (n=0) | 0.0% (n=3) | 3.1 | insufficient matched controls |

## Stay Belfast

Episodes found: 3142 (sampled 3142) across 15 listings. Treated settled nights: 161 (skipped — not yet settled: 3714, terminal state unknown/blocked: 11, repeat drops on an already-treated night: 352, no night record: 16).

| Lead (d) | Drop size | Date type | Episodes | Treated n | Treated fill 14d | Treated fill (matched) | Control fill 14d (matched/controls) | Δ fill pp | Realised % of pre-drop | Rate ratio vs controls | Cancel rate | Mean days to book | Note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0-1 | 3-7% | weekday | 2 | 2 | 0.0% | 0.0% | 0.0% (n=2/5) | 0.0 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 0-1 | 7-15% | weekday | 2 | 3 | 0.0% | 0.0% | 0.0% (n=2/2) | 0.0 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 0-1 | 15%+ | weekday | 2 | 2 | 0.0% | 0.0% | 0.0% (n=2/2) | 0.0 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 2-3 | 3-7% | weekday | 2 | 2 | 50.0% | 50.0% | 0.0% (n=2/5) | 50.0 | 68.0% (n=1) | — (n=0) | 0.0% (n=1) | 0.3 | insufficient matched controls |
| 2-3 | 7-15% | weekday | 1 | 1 | 0.0% | 0.0% | 0.0% (n=1/3) | 0.0 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 2-3 | 7-15% | weekend | 2 | 2 | 50.0% | 0.0% | 0.0% (n=1/1) | 0.0 | 49.8% (n=1) | — (n=0) | 0.0% (n=1) | 1.4 | insufficient matched controls |
| 2-3 | 15%+ | weekday | 1 | 1 | 0.0% | 0.0% | 0.0% (n=1/1) | 0.0 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 2-3 | 15%+ | weekend | 3 | 3 | 100.0% | 100.0% | 44.4% (n=3/7) | 55.6 | 46.6% (n=3) | 0.55 (n=3) | 0.0% (n=3) | 2.1 | insufficient matched controls |
| 4-7 | 3-7% | weekday | 15 | 21 | 57.1% | 50.0% | 10.7% (n=14/33) | 39.3 | 67.9% (n=12) | 0.96 (n=1) | 0.0% (n=12) | 2.5 | insufficient matched controls |
| 4-7 | 3-7% | weekend | 4 | 4 | 75.0% | 100.0% | 50.0% (n=1/2) | 50.0 | 49.1% (n=3) | 0.81 (n=1) | 33.3% (n=3) | 3.6 | insufficient matched controls |
| 4-7 | 7-15% | weekday | 20 | 27 | 37.0% | 23.5% | 13.2% (n=17/27) | 10.3 | 69.1% (n=10) | — (n=0) | 0.0% (n=10) | 3.3 | insufficient matched controls |
| 4-7 | 7-15% | weekend | 5 | 5 | 80.0% | 50.0% | 100.0% (n=2/2) | -50.0 | 52.1% (n=4) | 0.81 (n=1) | 25.0% (n=4) | 2.4 | insufficient matched controls |
| 4-7 | 15%+ | weekday | 6 | 6 | 33.3% | 33.3% | 33.3% (n=3/5) | 0.0 | 55.6% (n=2) | — (n=0) | 0.0% (n=2) | 1.6 | insufficient matched controls |
| 4-7 | 15%+ | weekend | 3 | 3 | 100.0% | 100.0% | 77.8% (n=3/5) | 22.2 | 46.6% (n=3) | 0.55 (n=3) | 0.0% (n=3) | 2.1 | insufficient matched controls |
| 8-14 | 3-7% | weekday | 13 | 13 | 46.2% | 40.0% | 61.7% (n=10/18) | -21.7 | 51.3% (n=6) | 1.47 (n=3) | 0.0% (n=6) | 6.9 | insufficient matched controls |
| 8-14 | 3-7% | weekend | 4 | 4 | 100.0% | 100.0% | 58.3% (n=4/6) | 41.7 | 50.1% (n=4) | 1.09 (n=3) | 0.0% (n=4) | 4.6 | insufficient matched controls |
| 8-14 | 7-15% | weekday | 6 | 7 | 14.3% | 16.7% | 25.0% (n=6/13) | -8.3 | 58.9% (n=1) | — (n=0) | 0.0% (n=1) | 8.0 | insufficient matched controls |
| 8-14 | 7-15% | weekend | 2 | 2 | 50.0% | 50.0% | 50.0% (n=2/4) | 0.0 | 41.5% (n=1) | — (n=0) | 0.0% (n=1) | 2.3 | insufficient matched controls |
| 8-14 | 15%+ | weekday | 4 | 7 | 0.0% | 0.0% | 25.0% (n=4/4) | -25.0 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 8-14 | 15%+ | weekend | 1 | 1 | 0.0% | — | — (n=0/0) | — | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 15-30 | 3-7% | weekday | 11 | 11 | 54.5% | 71.4% | 57.1% (n=7/14) | 14.3 | 52.6% (n=6) | 1.45 (n=4) | 33.3% (n=6) | 5.5 | insufficient matched controls |
| 15-30 | 3-7% | weekend | 9 | 10 | 40.0% | 60.0% | 70.0% (n=5/6) | -10.0 | 38.1% (n=4) | 1.36 (n=3) | 40.0% (n=5) | 10.5 | insufficient matched controls |
| 15-30 | 7-15% | weekday | 12 | 14 | 35.7% | 28.6% | 28.6% (n=7/8) | 0.0 | 54.6% (n=5) | 0.94 (n=1) | 16.7% (n=6) | 7.3 | insufficient matched controls |
| 15-30 | 7-15% | weekend | 6 | 6 | 83.3% | 100.0% | 50.0% (n=2/2) | 50.0 | 54.0% (n=5) | 1.22 (n=1) | 16.7% (n=6) | 9.8 | insufficient matched controls |
| 15-30 | 15%+ | weekday | 4 | 4 | 25.0% | 0.0% | 100.0% (n=2/2) | -100.0 | 49.0% (n=1) | — (n=0) | 0.0% (n=1) | 4.2 | insufficient matched controls |

## Yo's House & Short Stay Harrogate

Episodes found: 5201 (sampled 5201) across 32 listings. Treated settled nights: 325 (skipped — not yet settled: 6526, terminal state unknown/blocked: 12, repeat drops on an already-treated night: 551, no night record: 7).

| Lead (d) | Drop size | Date type | Episodes | Treated n | Treated fill 14d | Treated fill (matched) | Control fill 14d (matched/controls) | Δ fill pp | Realised % of pre-drop | Rate ratio vs controls | Cancel rate | Mean days to book | Note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0-1 | 3-7% | weekday | 6 | 7 | 42.9% | 50.0% | 16.7% (n=6/9) | 33.3 | 75.8% (n=3) | — (n=0) | 0.0% (n=3) | 0.3 | insufficient matched controls |
| 0-1 | 3-7% | weekend | 1 | 1 | 0.0% | — | — (n=0/0) | — | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 0-1 | 7-15% | weekday | 1 | 2 | 0.0% | — | — (n=0/0) | — | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 0-1 | 7-15% | weekend | 1 | 1 | 100.0% | 100.0% | 0.0% (n=1/1) | 100.0 | 53.1% (n=1) | — (n=0) | 0.0% (n=1) | 0.1 | insufficient matched controls |
| 0-1 | 15%+ | weekday | 4 | 4 | 50.0% | 0.0% | 0.0% (n=1/1) | 0.0 | 69.5% (n=2) | — (n=0) | 0.0% (n=2) | 1.1 | insufficient matched controls |
| 0-1 | 15%+ | weekend | 2 | 2 | 50.0% | 100.0% | 0.0% (n=1/1) | 100.0 | 48.0% (n=1) | — (n=0) | 0.0% (n=1) | 0.1 | insufficient matched controls |
| 2-3 | 3-7% | weekday | 7 | 8 | 62.5% | 71.4% | 14.3% (n=7/8) | 57.1 | 88.2% (n=5) | 2.03 (n=1) | 0.0% (n=5) | 1.0 | insufficient matched controls |
| 2-3 | 3-7% | weekend | 2 | 3 | 100.0% | 100.0% | 50.0% (n=2/2) | 50.0 | 77.6% (n=3) | 0.87 (n=1) | 0.0% (n=3) | 0.3 | insufficient matched controls |
| 2-3 | 7-15% | weekday | 2 | 2 | 50.0% | 100.0% | 0.0% (n=1/1) | 100.0 | 105.6% (n=1) | — (n=0) | 0.0% (n=1) | 0.6 | insufficient matched controls |
| 2-3 | 7-15% | weekend | 3 | 3 | 66.7% | 100.0% | 16.7% (n=2/4) | 83.3 | 74.1% (n=2) | 0.75 (n=1) | 0.0% (n=2) | 1.0 | insufficient matched controls |
| 2-3 | 15%+ | weekday | 3 | 3 | 66.7% | 100.0% | 0.0% (n=2/2) | 100.0 | 69.5% (n=2) | — (n=0) | 0.0% (n=2) | 1.1 | insufficient matched controls |
| 2-3 | 15%+ | weekend | 5 | 7 | 85.7% | 100.0% | 50.0% (n=4/6) | 50.0 | 69.7% (n=6) | 0.86 (n=3) | 0.0% (n=6) | 1.0 | insufficient matched controls |
| 4-7 | 3-7% | weekday | 19 | 28 | 75.0% | 80.0% | 44.3% (n=20/54) | 35.8 | 78.0% (n=21) | 0.95 (n=15) | 0.0% (n=21) | 3.3 |  |
| 4-7 | 3-7% | weekend | 4 | 4 | 50.0% | 50.0% | 54.2% (n=4/9) | -4.2 | 73.8% (n=2) | 1.04 (n=2) | 0.0% (n=2) | 3.8 | insufficient matched controls |
| 4-7 | 7-15% | weekday | 26 | 35 | 71.4% | 50.0% | 36.7% (n=20/29) | 13.3 | 77.7% (n=25) | 1.19 (n=6) | 3.8% (n=26) | 2.8 |  |
| 4-7 | 7-15% | weekend | 4 | 4 | 100.0% | 100.0% | 0.0% (n=3/3) | 100.0 | 78.0% (n=4) | — (n=0) | 0.0% (n=4) | 2.2 | insufficient matched controls |
| 4-7 | 15%+ | weekday | 14 | 20 | 75.0% | 70.6% | 64.2% (n=17/29) | 6.4 | 77.1% (n=15) | 1.12 (n=8) | 0.0% (n=15) | 1.8 | insufficient matched controls |
| 4-7 | 15%+ | weekend | 2 | 3 | 100.0% | — | — (n=0/0) | — | 28.2% (n=3) | — (n=0) | 0.0% (n=3) | 2.5 | insufficient matched controls |
| 8-14 | 3-7% | weekday | 24 | 32 | 62.5% | 57.7% | 68.3% (n=26/58) | -10.6 | 81.2% (n=20) | 0.94 (n=13) | 0.0% (n=20) | 5.5 |  |
| 8-14 | 3-7% | weekend | 2 | 2 | 0.0% | 0.0% | 100.0% (n=1/1) | -100.0 | — (n=0) | — (n=0) | — (n=0) | — | insufficient matched controls |
| 8-14 | 7-15% | weekday | 19 | 32 | 62.5% | 61.1% | 53.7% (n=18/31) | 7.4 | 82.7% (n=20) | 1.07 (n=7) | 14.3% (n=21) | 4.9 | insufficient matched controls |
| 8-14 | 7-15% | weekend | 10 | 15 | 86.7% | 88.9% | 44.4% (n=9/16) | 44.4 | 66.1% (n=13) | 0.92 (n=4) | 0.0% (n=13) | 5.9 | insufficient matched controls |
| 8-14 | 15%+ | weekday | 9 | 13 | 69.2% | 66.7% | 44.4% (n=6/11) | 22.2 | 66.1% (n=9) | 1.09 (n=2) | 0.0% (n=9) | 4.4 | insufficient matched controls |
| 8-14 | 15%+ | weekend | 4 | 5 | 40.0% | — | — (n=0/0) | — | 65.9% (n=2) | — (n=0) | 0.0% (n=2) | 3.1 | insufficient matched controls |
| 15-30 | 3-7% | weekday | 35 | 37 | 37.8% | 52.9% | 42.2% (n=17/29) | 10.8 | 90.3% (n=14) | 0.98 (n=6) | 7.1% (n=14) | 6.9 | insufficient matched controls |
| 15-30 | 3-7% | weekend | 14 | 16 | 75.0% | 69.2% | 47.4% (n=13/29) | 21.8 | 68.1% (n=12) | 0.91 (n=7) | 23.1% (n=13) | 6.5 | insufficient matched controls |
| 15-30 | 7-15% | weekday | 18 | 28 | 28.6% | 46.2% | 43.6% (n=13/19) | 2.6 | 77.5% (n=8) | 1.05 (n=4) | 27.3% (n=11) | 7.3 | insufficient matched controls |
| 15-30 | 7-15% | weekend | 3 | 4 | 75.0% | 100.0% | 100.0% (n=1/2) | 0.0 | 74.3% (n=3) | 0.91 (n=1) | 0.0% (n=3) | 6.2 | insufficient matched controls |
| 15-30 | 15%+ | weekday | 2 | 4 | 75.0% | 100.0% | 0.0% (n=1/1) | 100.0 | 43.3% (n=3) | — (n=0) | 25.0% (n=4) | 12.4 | insufficient matched controls |

_Cells with fewer than 20 matched treated nights are marked "insufficient matched controls" — read them as anecdotes, not signal. Produced by `scripts/mine-drop-outcomes.ts`; pure logic in `src/lib/observe/drop-outcomes.ts`._
