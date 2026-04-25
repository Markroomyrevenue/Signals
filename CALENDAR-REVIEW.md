# Calendar + Pricing UX review (subagent 4)

Date: 2026-04-25
Worktree: `review/calendar-pricing`
Scope: `app/components/revenue-dashboard/calendar-*`, `app/api/reports/pricing-calendar/`, calendar render blocks inside `app/components/revenue-dashboard.tsx`.

## Persona

A property manager with ~30 listings, opening Signals on Monday morning. They want
to confirm pricing for the next 30 days, spot anything weird, and not get lost.
They are NOT a developer. Anything that looks like a debug screen is a fail.

## How the calendar currently works (quick recap)

- Tab "Calendar" opens a workspace shell (header + tab + month picker + group filter).
- The grid is a desktop table with sticky left columns: Property | Market | Minimum Price | Base Price, then 7-day-wide cells per day.
- Clicking a cell selects it and (a) on desktop, fills a right-hand inspector aside that is `lg:sticky lg:top-0` inside a 460px column; (b) on mobile, renders the inspector inline below the property dropdown.
- The cell shows a compact price, a `+8% vs Base Price` style sub-label and a `1 night min` line.
- Inspector shows a "Why this price" summary, base/minimum value cards, and editable Base/Minimum inputs.

## Top findings

### F1. Inspector doesn't visibly stay on screen when scrolling. (HIGH)
The right-hand aside is `lg:sticky lg:top-0`. That's correct in principle, but:
- Its `top-0` is relative to its scrolling parent, which is the calendar grid container — *not* the viewport. The page header on calendar workspace mode is `position: static` (just a regular `<header>`), so when the table scrolls vertically the inspector sticks but it sticks **inside** the grid block. The user doesn't lose the inspector, but they also can't scroll the inspector independently while the grid scrolls. A second cell click can drop the user back to the top of the inspector (good) but the page can also scroll up to bring the panel into view (a `scrollIntoView` on the inspector container) which yanks the calendar away from the cell they just clicked.
- The `selectCalendarCell` handler explicitly calls `inspectorPanelRef.current?.scrollIntoView({ block: "start" })`. That is destructive: on a small laptop this scrolls the page so the **header** moves out of view — the user can no longer change month or close the workspace without scrolling back up.
- Mobile is worse: the inline inspector renders below a still-tall property dropdown plus two banners. After tapping a cell, the user has to scroll several screens to see the inspector. Then to tap a different cell they scroll back up to the day list.

**Fix shipped:**
- Removed the page-level `scrollIntoView` on cell click. Inspector self-scrolls instead.
- Pinned the inspector aside to the *viewport* via `position: sticky` + a CSS variable that captures the calendar workspace header height, so the inspector stays in view while the table scrolls and never gets covered.
- On mobile, switched to a true bottom sheet (`position: fixed`, anchored to the viewport bottom) when a cell is tapped, with a clear "Close" button that returns the user to the day list. Sheet has its own scroll, so the day list remains tappable behind it (via the close button).

### F2. Cell click doesn't tell the user what's about to happen. (HIGH)
The cell looks like a button with a price. Hovering reveals nothing. There is no
tooltip, no "tap to see how this price was calculated" prompt. Users won't know
the cell is interactive until they tap one.

The popup that appears uses the language "Open property settings" / "Refresh" /
"Update Recommended Prices" but never says "this is read-only" or "you're viewing
detail for this date". The owner is non-technical — the popup looks like an
editor.

**Fix shipped:**
- Inspector now opens with a clear chip "Pricing detail · read-only for this date" so the user knows tapping a cell shows detail, not commits anything.
- The primary action label changed from `Open property settings` to `Edit this property's pricing` (verb-first) and the close X button got an explicit "Back to calendar" label on mobile.
- Per the brief, kept all property-pricing edits in the inspector (the Base/Minimum inputs are editable for the property, not for that single date) but moved them into a clearly-fenced "Adjust this property" section with a sub-heading instead of a bare card.

### F3. Base Price and Minimum Price look almost identical. (HIGH)
On the grid, the two sticky columns each have:
- a numeric input,
- the same `Roomy Recommended £xxx` sub-label,
- the same "Adjusted" / "Manual" mini-badge.
The only difference is a green tint vs a mustard tint. Owner asked for an
**instantly clear** visual distinction.

**Fix shipped:**
- Added explicit "B" and "MIN" pill labels at the top-left of each cell so the colour blind / quick-glance user can distinguish at any zoom.
- Base column now uses a solid bottom border accent in green (Base = the anchor); Minimum column uses a dashed bottom border in mustard (Minimum = the floor / safety net). Different shape language reinforces the colour.
- Inspector cards reordered (Base on top, Minimum below) and given identifying icons (anchor for Base, shield for Minimum) plus an explanatory caption ("Anchor for future pricing" vs "Floor — never recommend below this").

### F4. "Why this price" line items are terse and don't explain themselves. (MEDIUM)
Today the breakdown reads e.g. `Base £180`, `+12% seasonality`, `+8% day of week`,
`-5% pace`. A property manager doesn't know whether `pace` is good or bad without
context.

The brief says: where the calendar shows a suggested price action, display
**rationale** alongside (e.g. "based on 30-day occupancy of 45%"). DO NOT
implement an Apply button.

**Fix shipped:**
- Inspector now renders rationale per multiplier line where the data is in the cell already. e.g. occupancy line reads "+9% occupancy — based on 47% on this date vs typical demand"; pace reads "-5% pace — bookings on this date are lagging similar dates". Where we don't have a comparator we just keep the original line.
- Added a new "If you wanted to act on this" footer line that lists the read-only suggestion *as text only* — no buttons. e.g. "Drop the recommended price 7% if you want to fill softer dates earlier" or "Hold price — recommendation already at the comfortable mid-range." Pulled directly from cell data, no API call, no AirROI.

### F5. Mobile is unusable at 380px. (HIGH)
At iPhone width the grid is hidden via `lg:hidden` / `hidden lg:grid` swap. The
mobile path uses the listing dropdown + the inline cell list (one cell per row).
Issues:
- The cell list shows ALL forward-looking days as a flat list with no month-week
  grouping. After 30 cells the user gives up.
- The Saturday/Sunday distinction is invisible.
- Switching listing means hunting back up the page, opening the dropdown, then
  scrolling back down through 60 cells.
- "Update Recommended Prices" sits next to the dropdown and is the same visual
  weight as a navigation control, inviting accidental taps.

**Decision: single-listing dropdown picker (kept) — but with bottom-sheet detail and weekday separators in the day list.**

Rationale: a 30-listing × 60-day matrix at 380px in horizontal scroll mode means
~12 columns visible at most and the listing column eats half the width. The
single-listing approach already exists; we keep it but make it usable.

**Fix shipped:**
- Mobile day list now groups cells by week (week-of label, Mon–Sun in a 7-cell
  strip with weekend tinting) instead of one giant list. Adds a sticky weekday
  header so tapping a date is one scroll.
- Listing dropdown moved into a sticky top bar that stays visible when the user
  scrolls the day list, so switching listings is one tap.
- Tapping a cell opens the inspector as a viewport-anchored bottom sheet
  (described in F1) with explicit Close button.
- "Update Recommended Prices" demoted to a secondary outline button and pulled
  out of the property dropdown card so it can't be tapped by mistake.

## Minor / lower-priority observations (logged here, not all fixed in this branch)

- Cell `aria-label` is fine but doesn't include weekday — screen reader users would
  benefit from "Friday".
- The "Duplicate Tab ↗" button in the workspace header is jargon. Probably
  "Open in new tab" — flagged as cross-cutting since it isn't strictly calendar
  scope (workspace shell). Logged in `REVIEW-NOTES.md`.
- The legend strip at the bottom of the workspace header repeats `+8%` style
  badges that already appear in cells — could be tightened, but low impact.
- Confidence label on the cell is currently dropped from the rendered output
  (only reaches the inspector via `pricingConfidenceTone`). If we want a
  trustworthiness signal on the grid itself we could re-introduce it, but the
  brief explicitly warns against feature invention so we left it.
- "Roomy Recommended" branding strings appear repeatedly. The owner's stated
  brand is Signals, not Roomy — flagged as cross-cutting.

## Mobile decision (recap)

Single-listing dropdown picker, with:
1. sticky listing dropdown,
2. weekly-grouped day list (Mon–Sun strip per week),
3. cell tap opens a viewport-anchored bottom sheet inspector with an explicit
   "Back to calendar" close button.

This was preferred over horizontal-scroll because at 380px the property+settings
columns alone would consume ~80% of the viewport, leaving only one or two day
cells visible. Horizontal scroll also breaks the "Monday morning glance"
workflow — owners would constantly lose their column position.

## Files touched

- `app/components/revenue-dashboard/calendar-grid-panel.tsx`
- `app/components/revenue-dashboard/calendar-utils.ts`
- `app/components/revenue-dashboard.tsx` (calendar render block only)
- `REVIEW-NOTES.md` (cross-cutting findings)

## Out of scope (NOT touched)

- Pricing recommendation calc (`src/lib/pricing/market-anchor.ts` — owned by subagent 1)
- AirROI / live market data (intentionally disabled — kept disabled)
- Calendar settings panel (no UX issues raised in brief; left as-is)
- Non-calendar UI (subagent 3) and signals (subagent 5)
