# AUDIT-UI — UI/UX audit (Agent 4+5+6)

Scope: (1) Business Review PDF/PPTX generator, (2) date-range presets, (3) layout/overlap
across pages. **Calendar tab excluded** per charter. Repo: `/Users/markmccracken/Documents/signals`.
Audit date 2026-06-29. READ-ONLY against prod.

## What was verified LIVE vs STATICALLY

| Area | Method | Status |
| --- | --- | --- |
| Business Review PDF | **RENDERED a real PDF** from live Little Feather data (`scripts/audit/ui-business-review.ts` → `scripts/audit/out/business-review-sample.pdf`, 5 pages) and visually inspected it page-by-page | LIVE-RENDERED |
| Business Review PPTX | Static read of `src/lib/powerpoint.ts` (browser-only `PptxGenJS` via CDN — cannot run headless) | STATIC |
| Date-range presets | Static read of `date-range-picker.tsx` + dashboard resolvers; **date math executed in Node** anchored to 2026-06-29 | VERIFIED (computed) |
| Page layout / overlap | Static analysis of `revenue-dashboard.tsx` (9.4k lines). App **not booted** — see infra note | STATIC |

**Infra note (app boot):** Docker `hostaway-postgres` + `hostaway-redis` containers are
running, but the local dev DB is a *separate, likely-empty* database from prod (per memory
`reference-local-vs-railway.md`), and the prod DB is read-only behind the audit harness — not
wired to a local Next.js dev server. Booting `npm run dev` would render against empty/disconnected
data, giving no useful visual signal on the data-heavy defects. Per the charter's "bounded effort"
instruction I did **not** boot the app or scaffold Playwright; layout findings below are static.
The PDF generator, by contrast, **was** driven end-to-end on real data because the report builders
are callable headlessly through the harness.

---

## Severity summary

| Sev | Count | Findings |
| --- | --- | --- |
| P1 | 2 | UI-1 (multi-page table loses all title/context), UI-2 (dead manual-pagination code → no real pagination control) |
| P2 | 4 | UI-3 (no page numbers), UI-4 (% vs pts mixed columns), UI-5 (fixed business-review panel overlaps on narrow viewports), UI-6 (date presets are UTC not Europe/London) |
| P3 | 3 | UI-7 (inconsistent mobile table treatment), UI-8 (PPTX checklist/keystat silent truncation), UI-9 (missing high-value date presets) |

Evidence PDF: `scripts/audit/out/business-review-sample.pdf` (regenerate with
`bash scripts/audit/run.sh scripts/audit/ui-business-review.ts`).

---

# 1. Business Review generator

## UI-1 — Multi-page tables lose their title, subtitle, filters and report identity (P1)

**Evidence (rendered PDF):** The Property Drilldown section (50 properties × 9 columns) spans
**pages 3, 4 and 5**. Page 3 shows the full header block ("Property Drilldown report — Little
Feather Management", subtitle "Jun 2026 · per-property · 50 properties", the Filters line, and the
"Detailed view · Jun 2026" table title). **Pages 4 and 5 show only the repeated column-header row
and data rows — no report title, no client name, no period, no filters, no "Detailed view" caption.**
A reader who opens to page 4 cannot tell which client, which report, or which period they are looking
at. (Mark's "overlap when you try to create a business review" maps here: the section content runs
together across page breaks with no per-page re-orientation.)

**Root cause:** `src/lib/business-review.ts:130-232`. Each section is drawn once with a manual
cursor; the section title/subtitle/filters are drawn *before* the table (`:135-160`), then the table
is handed to `autoTable` which paginates internally via `addPage`. autoTable repeats the **column
head** on each new page but knows nothing about the section-level title block, so that context is
printed only on the section's first page. `didDrawPage` (`:208-214`) only draws the footer, never a
running header.

**Fix:** Give `autoTable` a `didDrawPage` that also renders a compact running header on every page
(e.g. `"{section.title} — {table.title} (cont.)"` at the top margin when `data.pageNumber > 1`), and
reserve top margin for it (`margin.top`). Alternatively, switch the whole renderer to autoTable's
`willDrawPage`/`didDrawPage` hooks as the single pagination authority and stop hand-rolling cursor
math. Risk: low (additive draw calls; no data change).

## UI-2 — Manual table-pagination branch is dead code; real pagination is unmanaged (P1)

**Evidence/root cause:** `src/lib/business-review.ts:219-222`:
```
if (cursorY > pageHeight - 120 && tableIndex < section.tables.length - 1) {
  doc.addPage("a4", "landscape");
  cursorY = 42;
}
```
This only fires when there is a *next* table in the same section (`tableIndex < tables.length - 1`).
But `buildBusinessReviewTables` (`app/components/revenue-dashboard.tsx:3953-4020`) returns a
**single-element array for every tab** — pace/sales/booked, booking_behaviour, and
property_drilldown each produce exactly one table. So `tableIndex` is always `0` and
`tables.length - 1` is always `0`; the condition is **never true**. All multi-page behaviour is
therefore delegated wholesale to autoTable with no app-level control over where breaks land or what
repeats — which is *why* UI-1 happens. The "cleaner layout" the charter asks for starts by deleting
this dead branch and owning pagination through autoTable hooks.

**Fix:** Remove the dead branch; drive pagination + running header via autoTable `margin.top` +
`didDrawPage`. Risk: low.

## UI-3 — No page numbers anywhere in a multi-page deck (P2)

**Evidence:** All 5 rendered pages carry the footer "Generated 29 Jun 2026, 16:00 … Roomy Revenue"
(`:42-84`) but **no "Page X of Y"**. For a 5-page business review handed to an owner this is a basic
gap. **Fix:** add page number to `drawFooter` using `doc.getNumberOfPages()` / `data.pageNumber`
(jsPDF page count is known after the doc is built; use `doc.internal.getNumberOfPages()` in a final
loop, or autoTable's `data.pageNumber`). Risk: low.

## UI-4 — Adjacent columns mix percentages and points without unit cues in headers (P2)

**Evidence (rendered PDF, page 3+):** the drilldown table shows `Occupancy = 100.0%` immediately
next to `Occupancy vs LY = +26.7 pts`, and revenue/ADR deltas as `-100.0% / +33.8%`. A column reads
"Occupancy" (a level, %) then "Occupancy vs LY" (a delta, **points**). This is the exact mislabel
risk the inventory flagged (occupancy delta in *points* while revenue/ADR deltas are *percent*). It
is correct underneath but invites misreading "−82.3 pts" as "−82.3 %". Source of the formatting:
`formatPercent`/`formatSignedPoints`/`formatSignedPercent`
(`app/components/revenue-dashboard.tsx:781-795`); table assembly `:3999-4017`.

**Fix:** keep the `pts`/`%` suffixes (good), but make the header explicit:
`"Occupancy vs LY (pts)"` vs `"ADR vs LY (%)"`, so the unit is in the header not only the cell.
Risk: low (cosmetic/string).

## UI-5 — Zero-revenue / 100%-occupancy rows look like data errors in the export (P2, data-adjacent)

**Evidence (rendered PDF, page 3):** `zzA - 203 Somerset Studios` shows **Revenue £0.00, ADR £0.00,
Revenue vs LY −100.0%, but Occupancy 100.0%, Occupancy vs LY +26.7 pts**. Several "test"/placeholder
listings (Mark Test Listing 2, Alma 6 bed test, Alma Place Short Stays) show £0 revenue yet appear in
a client-facing business review. Two issues for the *export* specifically: (a) 100% occupancy with £0
revenue/ADR is internally contradictory to a reader; (b) obvious test listings ("Mark Test Listing",
"Alma 6 bed test", "zzz - …", "zzA - …") leak into the client PDF. Root cause for the £0/100% combo
is in the metrics engine (out of this agent's lane — flag to the metrics agents), but the **export
should not ship test listings**. **Fix (UI side):** filter out listings whose name matches the known
test/placeholder prefixes (or an `is_test`/excluded flag) before building drilldown export rows in
`buildBusinessReviewTables`. Risk: medium (need a reliable "test listing" signal; coordinate with
owner on the allowlist).

## UI-PPTX — PowerPoint path notes (static, P3 each)

`src/lib/powerpoint.ts` cannot be rendered headlessly (loads `PptxGenJS` from a CDN into `window`).
Static review:
- **Silent truncation (P3):** checklist slide renders only the first **8** items
  (`:358 checklist.slice(0, 8)`); report slides cap key-stats at **4** (`:460 slice(0,4)`), filters
  at **6** (`:486 slice(0,6)`), legend at **5** (`:487 slice(0,5)`). Anything beyond is dropped with
  no "+N more" indicator. For a portfolio with many filters this silently hides context.
- **Fixed-geometry text boxes (P3):** summary box `h: 0.98` (`:474-484`) and bullet lists with fixed
  heights (`addBulletList` `:120-155`) do not grow; long summaries/filter strings will clip inside
  the box rather than wrap onto another slide. No measured-overflow handling exists (unlike the PDF,
  which at least flows).
- **Stale authorship metadata (P3, cosmetic):** `pptx.author = "OpenAI Codex"` (`:564`) on a
  Roomy-Revenue-branded deck — should be "Roomy Revenue".

---

# 2. Date-range presets

## Where the math actually lives (important)

`app/components/date-range-picker.tsx` is **presentation only** — `selectPreset` (`:141-146`) just
sets `value.preset` and never computes `from`/`to`. The real date math is **duplicated across three
separate resolvers** in `revenue-dashboard.tsx`:
- reservations: `reservationsDateRange` memo `:1925-1953` and `applyReservationsPreset` `:3702-3732`
- booked: `applyBookedPreset` `:3734-3766`
- home/overview windows: server-side in `src/lib/reports/service.ts:3399-3690`
  (`startOfUtcWeek`, `thisMonthStart`, `yesterday`).

There is **no shared preset→range function**; the same preset name (`last_7_days`) is implemented in
two places. That duplication is itself a defect risk (the two `last_7_days` happen to agree today,
but nothing enforces it).

## Current presets — VERIFIED date math (anchor today = 2026-06-29 UTC, a Monday)

All ranges are **inclusive on both ends** and computed in **UTC** via `toDateOnly(new Date())` →
`.toISOString().slice(0,10)`.

| Surface | Preset | from | to | Notes |
| --- | --- | --- | --- | --- |
| Reservations | today | 2026-06-29 | 2026-06-29 | single day |
| Reservations | yesterday | 2026-06-28 | 2026-06-28 | |
| Reservations | last_7_days | 2026-06-23 | 2026-06-29 | `today-6 … today` = 7 days **incl. today** |
| Reservations | this_month | 2026-06-01 | 2026-06-29 | MTD (1st → today) |
| Booked | last_day | 2026-06-29 | 2026-06-29 | label "last day" but = today |
| Booked | last_7_days | 2026-06-23 | 2026-06-29 | 7 days incl today |
| Booked | last_30_days | 2026-05-31 | 2026-06-29 | `today-29 … today` = 30 days incl today |
| Booked | last_90_days | 2026-04-01 | 2026-06-29 | `today-89 … today` = 90 days incl today (default) |
| Booked | last_year | 2025-06-30 | 2026-06-29 | `today-364 … today` = 365 days incl today |
| Overview | this_week | 2026-06-29 | 2026-06-29 | **Monday-anchored** (`startOfUtcWeek`); today *is* Monday → degenerate 1-day range |

**Two verified issues:**

### UI-6 — Presets are UTC, not Europe/London (P2)
`toDateOnly(new Date())` truncates to the **UTC** calendar date. During BST (UTC+1, the whole
summer), between 00:00 and 01:00 London time the UTC date is still *yesterday*, so "Today"/"Yesterday"
and every `today-N` window silently shift by one day for a UK user in the early hours. The codebase
is explicitly UK-facing (Europe/London is the stated app timezone in CLAUDE.md). **Fix:** compute
"today" in Europe/London (e.g. `Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London'})`) in a single
shared helper, and have all three resolvers use it. Risk: low-medium (touches 3 call sites; verify no
report query assumes UTC).

### UI-2b — `this_week` degenerates to one day on Mondays (P3 within presets)
Because `this_week` runs Monday→today and the audit date is a Monday, the range is a single day. This
is arguably correct ("week-to-date") but the label "This week" will read as a 7-day window to a user;
worth a "Week to date" label.

## UI-9 — High-value presets a revenue manager expects but are missing (P3)

The picker's `DEFAULT_OPTIONS` (`date-range-picker.tsx:28-34`) offers only Today / Yesterday /
Last 7 days / This month / Custom. The `DateRangePreset` type (`:6-15`) already *declares*
`last_30_days`, `this_week`, `this_year`, `last_year` but they are not all surfaced consistently, and
several core revenue-management presets are absent. Proposed additions with exact, inclusive,
**Europe/London**-anchored math (anchor `T` = local today; `T` shown as 2026-06-29 for worked values):

| Proposed preset | from | to | Math | Worked (T=2026-06-29) |
| --- | --- | --- | --- | --- |
| Last 30 days | T−29 | T | trailing 30 incl today | 2026-05-31 → 2026-06-29 |
| Last 90 days | T−89 | T | trailing 90 incl today | 2026-04-01 → 2026-06-29 |
| MTD | first-of-month(T) | T | month-to-date | 2026-06-01 → 2026-06-29 |
| Last month | first-of-prev-month | last-of-prev-month | full previous calendar month | 2026-05-01 → 2026-05-31 |
| QTD | first-of-quarter(T) | T | quarter-to-date (Q3 starts 1 Jul → here Q2 = 1 Apr) | 2026-04-01 → 2026-06-29 |
| YTD | first-of-year(T) | T | year-to-date | 2026-01-01 → 2026-06-29 |
| Trailing 12 months | T−364 | T | 365 days incl today (or `addUtcYears(T,-1)+1 … T` for a clean year) | 2025-06-30 → 2026-06-29 |
| Next 30 (forward pace) | T | T+29 | forward 30 incl today | 2026-06-29 → 2026-07-28 |
| Next 60 (forward pace) | T | T+59 | forward 60 incl today | 2026-06-29 → 2026-08-27 |
| Next 90 (forward pace) | T | T+89 | forward 90 incl today | 2026-06-29 → 2026-09-26 |
| Compare to LY (toggle) | — | — | for any chosen range, also fetch `[from−1y, to−1y]` (clamp Feb-29 like `addUtcYearsClamped`, `service.ts:592`) | range−1 calendar year |

Forward presets (Next 30/60/90) are the biggest gap: this is a *pace* product and the picker offers
no forward window at all. "Compare to LY" should be a toggle layered on any range rather than a
separate preset, mirroring the existing `addUtcYearsClamped` LY logic already used in pace.
**Fix:** add a single shared `resolvePreset(preset, today)` returning `{from,to}` (Europe/London),
extend `DEFAULT_OPTIONS`, and route all three current resolvers through it. Risk: medium (consolidates
duplicated logic — net simplification, but touches every dated tab; needs regression check that
`last_year`/`this_week` keep their current values where already shipped).

---

# 3. Layout / overlap across pages (static)

Overall the dashboard is **mostly responsive-safe**: data tables are wrapped in `overflow-x-auto`
containers with `min-w-full` (lines 6247, 8328, 8806, 9298, 9364), the sidebar uses a proper
`fixed … md:static` drawer pattern (`:7003`), and the main column is capped `max-w-[1440px] mx-auto`
(`:7099`). No clipped fixed-width tables found. Specific findings:

## UI-5 (layout) — `fixed` business-review panel overlaps content on narrow viewports (P2)
`revenue-dashboard.tsx:7156`: the queued-sections panel is
`fixed right-6 top-24 z-50 w-[360px]`. At 360px width + 24px right inset it needs ≥384px of viewport;
on phones (375px) it overflows the left edge, and being `fixed`/`z-50` it **floats over** the main
content and the sidebar toggle rather than flowing. The `pace`/`booking_behaviour` floating popups at
`:7156` family share this. **Fix:** make it `inset-x-4 bottom-4 w-auto md:right-6 md:top-24 md:w-[360px]`
(full-width sheet on mobile, floating card on desktop). Risk: low.

## UI-7 — Inconsistent mobile treatment of data tables (P3)
The **reservations** table uses the correct dual pattern — desktop table `hidden … sm:block`
(`:6247`) **plus** a `sm:hidden` mobile card list (`:6314`). But **deep-dive (`:8328`),
booked (`:8806`), and sales/pace (`:9298`,`:9364`)** tables provide **only** `overflow-x-auto` with
**no mobile card fallback**, so on a phone the user horizontally scrolls a 9-column table. Not broken
(no clipping), but an inconsistent experience — reservations gets cards, the other (wider) tables do
not. **Fix:** either add card fallbacks to the wide tables for parity, or drop the reservations cards
and standardise on horizontal-scroll. Risk: low-medium (new render branches).

## Things checked and found OK (no defect)
- Date-range popup uses a portal with viewport-rect positioning and clamps to `vw - margin`
  (`date-range-picker.tsx:96-108`) and closes on scroll/resize rather than chasing — no overlap bug.
- All report tables prevent horizontal clipping via `overflow-x-auto`.
- Sidebar drawer, expand-overlay (`:1190`), and selection dropdowns (`max-h-* overflow-auto`) are
  contained.

---

## Reproduction

```
bash scripts/audit/run.sh scripts/audit/ui-business-review.ts
# -> scripts/audit/out/business-review-sample.pdf  (5 pages, real Little Feather data)
```
Date math recomputation: `node scratchpad/datecalc.mjs` (anchored 2026-06-29).
