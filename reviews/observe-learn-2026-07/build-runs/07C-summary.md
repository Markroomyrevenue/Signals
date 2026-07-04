> **Update 2026-07-04:** built, independently audited (SAFE, two auditors) and **deployed live** (prod `05a9bdd`). See DECISIONS.md.

# Build run 07 Part C — surfacing the grain to Mark (2026-07-04)

Scope: build prompt 07 items 8-9 (`BUILD-PROMPTS/07-learning-granularity-hierarchy.md`),
on branch `feat/observe-grain-2026-07`, on top of Part A's cohort engine
(`07A-summary.md`) and Part B's richer learnings (`07B-summary.md`).
NOT deployed — deployment is the orchestrator's step.

## What shipped

| Commit | Change |
|---|---|
| `bf8e304` | Readout: per-group and size-band curve summaries with rung/n (`summariseCohortCurveSet`); suggestion rows carry human-readable provenance ("judged against group:Argo curve, n=1,204") |
| `ba3a3b7` | Weekly report: "How your groups book differently" section, "Bookings won by big discounts" per client when material, "New this week" group pattern-change lines vs last week's artefact; hygiene tests extended |
| `efeb390` | Example weekly email re-rendered with the new sections (prod-shaped fixtures: Fitzrovia 22d, student blocks 10d, Argo 54d vs St James 3d, booking.com heavy share 10%) |

Gate: `npm run typecheck`, `lint --max-warnings=0`, `test:tenant-isolation`,
`test:observe` 242/242 (227 after Part B), `test:observe-schedule` 6/6 — all green.

## Readout (item 8)

- New pure `summariseCohortCurveSet` in `cohorts.ts`: every group and
  size-band cohort with `{listingCount, bookings (the gate metric = n),
  medianLeadDays, ownCurve}`. Gate status is asserted equal to what
  `resolveCohortCurve` actually does at the boundary (test).
- `buildReadout` computes the summaries at readout time from the SAME two
  tenant-scoped queries the daily generator's ladder uses (active listings +
  trailing-365d occupied NightFacts with a lead) — nothing persisted, per the
  Part A handoff's suggestion.
- `readSuggestions` now selects `detail` and returns `curveCohort` /
  `occupancyCohort` (`readProvenanceFromDetail`, defensive: pre-cohort rows
  return null and render nothing). Rendered inline in the suggestion table's
  reason cell via `provenanceLabel` — listing rung reads "this listing's own
  curve", tenant rung "the whole-client curve", group/size rungs name the
  cohort, all with a thousands-separated n.

## Weekly report (item 9)

- `WeeklyClientInput.groupCurves` (name with `group:` stripped, median,
  bookings, listings, ownPattern) gathered per tenant from the same
  listing + night-fact queries. Pure sentence builders:
  - `bookingLeadPhrase`: 54d → "about 8 weeks ahead", 3d → "in the final
    days" (the prompt's exact example).
  - `groupBookingSentences`: below-gate groups say "does not have enough
    bookings yet (only N in the last year)" and never quote their noisy median.
  - `promoGapSentences`: quotes the HEAVY share only ("About 1 in 10 of the
    last 214 bookings through booking.com came with a much bigger discount
    than is typical for that channel"), never the raw median gap — the
    structural VAT wedge would read as a fake 26% promo (07B's caveat).
    Material = heavyShare ≥ `PROMO_LINE_MIN_HEAVY_SHARE` (0.05); the
    unknown-channel pool is never named.
  - `groupPatternChangeSentences`: "New this week: Argo now has enough booking
    history to be judged by its own pattern instead of the whole portfolio",
    and the reverse for a lost pattern.
- Rung changes are diffed against LAST WEEK'S REPORT ARTEFACT on disk
  (`loadPreviousGroupPatterns` reads the newest dated
  `learner-weekly-YYYY-MM-DD.json` before today; `WeeklyClientReport.groups`
  is persisted in the JSON precisely so next week can diff). Missing or
  unreadable artefact = no comparison, never an error. Covered by a runner
  test that generates week 1 below-gate, week 2 above-gate, and asserts the
  change line appears in week 2's HTML.
- Both new sections are omitted entirely when no client has content (no empty
  scaffolding in the email). The hygiene test now renders them and bans
  `cohort`, `promo_gap`, `heavyShare`, `size band`, `ownPattern` on top of the
  existing tenantId/NightFact/regret/rung/clientKey/listingId list, plus the
  em-dash check.

## Decisions an auditor should scrutinise

1. **Rung-change grain is per GROUP, not per listing** — "any cohort that
   changed rung" is read as the group gaining/losing its own curve. Listings
   crossing the listing-rung gate are visible in the readout's ladder table
   but not called out in the email (per the audit: keep the email to one line
   per divergence, not 194 listings).
2. **The week-over-week diff source is the report artefact**, not the DB.
   If the artefacts directory is wiped, one week of change lines is silently
   lost (the section still renders; only "New this week" lines skip).
3. **Promo materiality threshold 0.05** is a Part C constant, not prod-fitted
   (prod heavy shares are computed on the settle only after deploy). With the
   channel-relative heavy definition, roughly ~15% of a channel's bookings sit
   above median + 15pp on today's spreads, so most active channels will show a
   line at first; raise the constant if the section reads noisy.
4. **`readSuggestions` return type widened** (adds `curveCohort` /
   `occupancyCohort`); its only consumers are the readout and the key-gated
   HTTP route (which pretty-prints the JSON, so the new fields appear there
   automatically).
5. **Weekly gather got heavier**: two extra tenant-scoped queries per tenant
   (active listings + trailing-365d occupied night facts), same shape/size as
   the daily generation query set, once a week. Judged fine.

## Worked examples (rendered in the committed artefact)

`observe-reports/learner-weekly-example-2026-07-06.html`:
"Your Argo properties book about 8 weeks ahead (from 338 bookings in the last
year)." / "Your St James Apartments properties book in the final days (from 93
bookings in the last year)." / "New this week: St James Apartments now has
enough booking history to be judged by its own pattern instead of the whole
portfolio (93 bookings)." / "About 1 in 10 of the last 214 bookings through
booking.com came with a much bigger discount than is typical for that channel."

## What the next agent needs to know

- New exports: `summariseCohortCurveSet` + `CohortCurveSummary` (`cohorts.ts`);
  `readProvenanceFromDetail` (`suggestions.ts`); `provenanceLabel`
  (`readout.ts`); `bookingLeadPhrase`, `groupBookingSentences`,
  `groupPatternChangeSentences`, `promoGapSentences`,
  `PROMO_LINE_MIN_HEAVY_SHARE`, `WeeklyGroupCurve` (`weekly-report.ts`).
- `ReadoutData` gained `cohortCurves`; `WeeklyClientInput` gained REQUIRED
  `groupCurves` (fixtures must supply it, `[]` is fine);
  `WeeklyClientReport` gained `groups`, `groupSentences`,
  `groupChangeSentences`, `promoSentences`; `buildWeeklyReport` accepts
  optional `previousGroupPatterns` keyed by client name then group name.
- Per-cohort curve summaries are still NOT persisted on the ClientProfile —
  both surfaces compute them from the two queries at render time.
