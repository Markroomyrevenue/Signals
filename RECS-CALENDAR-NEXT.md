# Recs calendar — outstanding asks (handover 2026-07-22)

Read this + `CLAUDE.md`, `DECISIONS.md`, `BUILD-LOG.md`, and the memory index
first. The Pricing Recommendations **calendar view** is LIVE and heavily
iterated. This file is the next batch of Mark's asks, with enough spec + code
pointers to build them.

## Where things are (architecture)

- Server payload: `src/lib/recs/calendar-data.ts` → `loadRecsCalendar()`, route
  `app/api/recs/calendar/route.ts`. Per-night: `nights` (LIVE tiles = pending +
  unresolved mismatch), `history` (blue-dot decisions), `booked`/`bookedAt`
  (green dot), `live`, `minStay`, `min`/`base`, `runs`. See `CalendarNight` /
  `CalendarListing` / `CalendarHistory` types there.
- UI: `app/components/recs/recs-calendar-view.tsx` (~2.7k lines, `NightTile`,
  `AgendaCard`, `RunRibbon`, `PushModal`, `UserSetForm`) + `recs-calendar.css`
  (all classes `rcal-` prefixed).
- Actions: `/api/recs/action` (approve/reject/revert/retry), `/api/recs/run-action`
  (edited run total), `/api/recs/user-set` (operator price on an open date),
  `/api/recs/regenerate` (manual refresh), `/api/recs/overrides` (red-dot read).
- Generation + reason strings: `src/lib/observe/suggestions.ts`.
- Standing rule: pushes go to PriceLabs/Wheelhouse ONLY (never Hostaway); every
  Prisma query filters `tenantId`; live-pricing changes get a checkpoint + an
  adversarial review before deploy (see the pattern in recent DECISIONS entries).

## The asks

### 1. Drag-select multiple dates → bulk "set price" or "% drop"
Hold + drag across a listing's day cells (grid) to highlight a range, then a
popover to apply EITHER an exact price ("set price") OR a percentage drop (−X%)
to every selected night. Should feed the existing basket/push pipeline (each
night becomes a staged edit / user-set, then Review & Push). Percentage applies
to each night's own current/rec price. Reuse `submitUserSet` / `commitUserSpan`
/ the edit-staging path. New: drag-select state + a bulk popover.

### 2. Plain-English "why" notes
The generator's reason strings are jargon-y (e.g. "empty at 2d out; curve
expects ~65% booked by now; occupancy-scaled 29% < 50%"). Mark wants host
language. Rewrite the reason/`whyShort`/`whyFull` builders in
`src/lib/observe/suggestions.ts` (search `reason =` / `pushHold(` / the curve/
occupancy strings) and the hold reasons. Low risk (display text) — but keep the
numbers, just say them plainly. See memory `user-non-technical-clarity`.

### 3. Uniform live-box colour
Mark wants every LIVE tile (open, drop-rec, hold) to be the SAME base colour —
the ONLY visual difference being the blue history dot. Today drop tiles carry an
amber `.rcal-rpill`, holds are quiet green, open is green-soft, etc. Make the
live tiles one consistent colour; keep the drop price legible (a pill/arrow is
fine) but not a different tile colour. CSS + `NightTile` branches in
recs-calendar-view.tsx. Design pass — don't lose the approve/edit/ignore
affordances or the min-stay/override marks.

### 4. Late drops don't re-suggest (DIAGNOSED — Mark's call on the fix)
Confirmed cause: `already_actioned` guard in `suggestions.ts` (~line 183): "No
compounding: a night a human already actioned never gets a fresh drop." It fires
whenever a night has an approved/applied suggestion, **regardless of whether the
price is already optimal** — so it is SUPPRESSION, not "would land anyway."
There is no "is the price already low enough?" check. So a near-term empty night
you dropped yesterday will NOT get a fresh drop rec today (Mark can still
manually re-drop it via the open box → user-set). Options for Mark:
  (a) Relax the guard for NEAR-TERM nights (e.g. allow a fresh drop within N days
      of stay if the night is still empty and the last drop was > X hours ago),
      keeping the anti-ratchet cap (`cumulativeDropPct`, `CUMULATIVE_CAP_WINDOW_DAYS`)
      so it can't spiral.
  (b) Just SURFACE the suppression on the calendar ("held — dropped yesterday")
      so he understands why and re-drops manually when he wants.
This is pricing-sensitive → confirm the policy with Mark before changing the
generator.

## Suggested order
2 (plain English) and 3 (uniform colour) are low-risk display changes — quick
wins. 1 (drag-select) is a self-contained UI feature. 4 needs Mark's policy
decision first. Green-gate + adversarial-review + deploy-and-verify each batch
per the standing protocol.
