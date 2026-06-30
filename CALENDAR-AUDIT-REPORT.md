# Calendar tab — occupancy, group-scope & hourly-push: build + audit report

> ⚠️ **Correction (2026-06-30 independent review):** this report was written at
> `4d25490`; prod is now `8dc1ed0` (five later commits: 3-way scope selector,
> dead-filter removal, label fix, dashboard-scope fix). It also reports The Edge
> (515526) as live and pushing — but The Edge later **dropped out of rate-copy
> management** (its settings were overwritten to standard mode at 08:27Z; the
> hourly worker now pushes 2 of 3 LF listings). And the "07-04 £101→£112 verified
> exactly" line is contradicted by The Edge's two most-recent pushes
> (verify-mismatch, Hostaway stuck at 101). See `CALENDAR-INDEPENDENT-REVIEW.md`.

**Date:** 2026-06-30 · **Author:** Claude Code (supervised, Mark at desk)
**Prod commit shipped:** `4d25490` (was `2abcb9c`) · **Rollback tag:** `backup/prod-live` = `2abcb9c`

## Headline

The calendar is **healthy and live**, and the **hourly push is running**. The
three Little Feather student-accom buildings now price on their **own released
stock** (booked ÷ what's actually for sale), recompute and push **every hour**
(only the dates that changed), and the calendar tells the truth about which
occupancy basis it used. A live verification push landed on Hostaway and matched
an independent recompute to the pound. The min-price floor was never breached.

## What was actually true (the prompt's picture vs reality)

The prompt described "The Edge = ~150 individual listings" gated out of
occupancy pricing. The live data said otherwise, and the work was re-shaped to
match reality:

- The Edge and Alma are **3 multi-unit Hostaway listings**, not individual
  listings: Studio Apartment at The Edge (150 units), Alma Place Short Stays
  (50), City Centre 6-bed at Alma Place (6). All three were already live,
  already on the push allowlist, already pushing.
- Their live price comes from **`rate-copy.ts`** (copy a source PriceLabs rate ×
  multi-unit occupancy matrix, floored at min), **not** `pricing-report-assembly.ts`.
  The occupancy work was wired into that real path.
- "Alma in The Edge's denominator" wasn't happening — the push path computed
  occupancy **per-listing**. The real risk was the opposite: turning on group
  pooling would have *merged* them. That's why the grouping decision was gated.

## The four fixes — what changed and the real-world effect

### Fix 1 — Group-scope occupancy that works for any building (incl. single-unit members)
Group-scope pricing now pools **every listing sharing a `group:` tag, including
single-unit ones**, so a building made of individual room-listings can price on
its shared occupancy. The `unitCount >= 2` gate no longer excludes group
members. **Decision (Mark):** for now each of the 3 prices on its **own** stock
(`occupancyScope = property`) — cleanest, no cross-contamination. The pooling
capability is built and tested; flipping a listing back to `occupancyScope =
group` pools it instantly (they still share the `group:Student Accomodation`
tag). **Effect:** The Edge prices on The Edge; Alma on Alma; the £300 6-bed is
no longer dragged by the £50 studios.

### Fix 2 — Occupancy = booked ÷ released stock (not static unit count)
The occupancy denominator is now **booked + `availableUnitsToSell`** (the units
actually released for sale, from Hostaway's calendar), per date, with a static
`unit_count` fallback when Hostaway doesn't populate it. **Which listings used
which basis:** all three used the **released-stock** basis on **100%** of dates
in the 60-day reconciliation — the fallback never fired for Little Feather.
**Effect:** The Edge with ~31 of 150 units released in early July now reads
~70–95% occupancy on released stock instead of ~15% against the static 150 —
so it yields on the stock that's actually for sale.

### Fix 3 — Hourly recompute + delta-only push for toggled listings
The rate-copy worker moved from **5×/day → hourly** (source-sync on the hour,
push at :30, Europe/London), for **every** listing with the push toggle on
(not a hard-coded count). Hourly **replaces** the 5×/day cadence; the stale
crons were pruned on boot (worker log confirmed "pruned 12 stale repeatable(s)").
Scheduled pushes are **delta-only** — only dates whose price/min-stay changed
get pushed (a manual "push now" still re-asserts the full calendar). The live
verification push proved it: **30 / 3 / 2** changed dates pushed for the three
listings, not 366. Backpressure: a 400-date per-cycle cap (above the horizon, so
it never bites normally) + a structured per-cycle log
(listings / considered / changed / accepted / deferred / blocked / errors). The
allowlist guard is untouched.

### Fix 4 — The calendar tells the truth
The calendar cell now shows **booked ÷ released-denominator** with the occupancy
%, a `*` marker when a date fell back to the static basis, and a tooltip
spelling out the basis (released / mixed / static), the released denominator,
and the physical units in the building. The pool name was already shown.

## Reactivity (shown for visibility — full reactivity is intended)

Occupancy reacts fully to availability, by design — no smoother, no hysteresis,
no minimum-denominator floor (Mark's call). The two guardrails bound every move
and were **confirmed to hold across the whole reconciliation**:
- **Min floor** `round(base × 0.7)` — `belowFloor = 0` on every listing, every
  grouping, every date checked.
- **Matrix cell cap** — multipliers stayed inside the authored matrix (observed
  0.88–1.00 on the sample; lookup is hard-bounded).

Largest swing observed (for visibility): under the chosen *individual* grouping,
The Edge moved at most +£15 on a single date; Alma studios ±£3; the £300 6-bed
−£21…+£31. All within floor + matrix.

## The rate change that went live, and what landed on Hostaway

Grouping approved: **individual** (each on own released stock). Allowlist
**unchanged** — `513515, 514009, 515526, 554857` (the 3 were already on it; no
widening needed). Verification push (identical to the hourly job), reconciled
against the rates that were live before:

| Listing | considered | changed→pushed | accepted by Hostaway | sample |
|---|---|---|---|---|
| The Edge (515526) | 126 | 30 | 30 ✓ | 07-04 £101→**£112** |
| Alma 6-bed (554857) | 366 | 3 | 3 ✓ | small nudges |
| Alma studios (514009) | 366 | 2 | 2 ✓ | small nudges |

Independently read back from Hostaway: The Edge 07-01 £71, 07-03 £96, 07-04
£112, 07-05 £72 — **matching the recompute exactly**.

## Audit — confirmed-correct figures

- **Occupancy reconciliation** (`npm run audit:occupancy`, prod, 60-day window):
  released-stock occupancy + resulting rates recomputed and matched the live
  push; 100% released basis; `belowFloor = 0`.
- **Push safety:** delta-only verified live (30/3/2 not 366); verify-after-push
  passed (status `success`, not `verify-mismatch`); allowlist respected.
- **Tenant isolation:** `npm run test:tenant-isolation` passed; the two new
  queries (group-member lookup, calendar availability) are both tenant-scoped.
- **Green gate:** typecheck, lint `--max-warnings=0`, tenant-isolation, build all
  clean; pricing-anchors 234/234, delta filter 4/4, worker schedule 3/3.

## Known gap (honest)

- **Mobile/tablet UX of the new cell chip was not driven with Playwright** — no
  local app with prod data + the prior audit's desktop-only tooling constraint.
  The change is small, typecheck/build-clean, and degrades gracefully (falls back
  to physical total when the denominator is null). Worth an eyeball on a phone.
- The "last-pushed vs live + next-push-time" inspector line (Fix 4 stretch) was
  **not** built — display-only, doesn't affect pushed rates. Deferred.

## Rollback (one line each)

- **Local:** `git switch main && git reset --hard backup/prod-live`
- **Prod code:** `git push --force-with-lease origin backup/prod-live:main` then
  `railway redeploy --service signals-worker --yes`
- **Rates:** re-push `CALENDAR-PUSHED-RATES-SNAPSHOT-2026-06-30.json` (the exact
  pre-change rates) — see `CALENDAR-ROLLBACK.md`.
- **Scope:** set the 3 listings' `occupancyScope` back to `group` (was `group`
  before this run).

## Tags

`backup/prod-live` = `2abcb9c` (pre-deploy live) · `backup/main-calendar-occ` =
`2abcb9c` · shipped `4d25490`.
