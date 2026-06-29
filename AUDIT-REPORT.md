# Signals — Metric & UI Trust Audit: Report (2026-06-29)

Plain-English summary of the full independent audit, the fixes shipped, and proof.

> **CORRECTION (2026-06-29, independent review).** This report was written at commit
> `f90f50d`. Two further fixes were pushed and auto-deployed afterward, so **prod is now live
> on `b6d31c2`**, not `f90f50d`: `8564c35` (unit_count derived authoritatively from Hostaway
> `listingUnits[]` — Alma Place 20→50, The Edge 100→150) and `b6d31c2` (drilldown
> multi-month export + dashboard labels/filter-loading + booking-window custom range). Both
> were independently verified correct and healthy. Consequence: **Little Feather's corrected
> occupancy is ~20% (20.46%), not the ~28% quoted below** — the unit_count correction lowered
> it further to the accurate figure. Rollback target is unchanged (`backup/prod-live`=`82841b3`).
> See `AUDIT-INDEPENDENT-REVIEW.md`.

## Headline: is the app healthy and live?

**Yes.** All fixes are live on `https://signals.roomyrevenue.com` as of ~18:57 London
on 2026-06-29 and verified healthy (web + background worker on the new code, health
matched the pre-deploy baseline, no errors, no downtime). Rollback target is preserved
(`backup/prod-live` = `82841b3`).

## The big picture

The good news first: **the core money numbers were already correct.** Stay revenue,
ADR, occupied nights, booked revenue, cancellation rate, average length of stay, and the
year-on-year/pace maths all reconciled **to the penny** against both the raw database and
the live Hostaway data, for all five live clients. Your "cancelled-but-still-counted-at-
the-snapshot" rule is working correctly. Your #1 worry — that multi-room bookings inflate
ADR ~N× — turned out **not** to be happening (each room books as its own reservation).

What *was* wrong were a handful of specific, now-fixed issues:

## What was wrong, and the real-world impact

1. **Occupancy & RevPAR were wrong for multi-unit properties.** The calculation didn't
   account for how many rooms a building has, then capped the result at 100% which *hid*
   the error. Impact: **Little Feather's occupancy showed 75% when it was really ~20%**
   (≈28% at this report's commit; lowered to the accurate 20.46% by the later `8564c35`
   unit_count correction — see top), and RevPAR (now ~£23) was ~3-4× too high. Only Little
   Feather was affected.
2. **Occupancy was too low for the other four clients** because newly-onboarded listings
   counted a full year of "empty" availability before they went live. Fixed: occupancy now
   counts a listing only from its first booking. Impact e.g. **Yo's House 54% → 75%**.
3. **The "Reservations" headline double-counted** on week/month views (it counted
   reservation-*days*). Impact: e.g. Little Feather "this month" showed **1,132 instead of
   302**. Revenue/nights were never affected.
4. **"Calendar ADR vs last year" (drilldown) was blank or wrong on past periods** — the bug
   you reported. It used the wrong basis and went empty on finished months. Now shows the
   correct figure.
5. **Business-review PDF lost its identity across pages** — page 4-5 of a long table had no
   title/client/period and there were no page numbers. Fixed: every page now has a running
   header + "Page X of Y." Test listings ("Mark Test Listing", etc.) are stripped from
   client exports.
6. **The Ex-VAT toggle didn't remove VAT** from the overview headline. Fixed.
7. **Housekeeping:** the dead AirROI integration was removed; the broken "Signal Lab" tab
   (which showed impossible numbers like 409% occupancy, and was already hidden from the
   menu) was retired; the tenant-isolation audit went from 4 flags to **0**.

## What shipped vs deferred

**Shipped & live:** all of 1–7 above.

**Deferred (with reason):**
- **Expanded date-range presets** (Last 30/90, MTD/QTD/YTD, Next 30/60/90, etc.). The design
  is done, but wiring them correctly needs a per-tab decision (forward-looking presets belong
  on Pace/Sales, not on a "booking date" filter) and a small integration. The picker was left
  untouched so there's no half-working UI. **One-action next step:** a follow-up session to
  wire `resolvePreset` into each tab + your call on which presets appear where.
- **"Alma Place" room count:** it had 44 bookings overlap one night but is set to 20 units —
  likely the unit count is understated (or genuine overbooking). **Your check:** confirm the
  real room count and I'll set it (data only, no code).
- **Permanently removing test listings** from Little Feather's tenant (they're only hidden
  from exports now) — a data decision for you.
- **Deleting the now-unreachable Signal Lab code + the `external_api_cache` table** — safe
  cleanup for a later pass (needs a DB migration for the table).

## Confirmed-correct list (positively verified against Hostaway + raw DB, all 5 clients)

Stay revenue · ADR · occupied nights · booked revenue & bookings · booked-date attribution ·
cancellation rate · average LOS · year-on-year & pace ADR · pace on-books · cancelled-at-cutoff
inclusion · multi-room reservation ADR · tenant isolation.

## Why our numbers differ from Hostaway's own dashboard (for clients)

Signals' incl-fees revenue and occupied nights match Hostaway to the penny. Where a Hostaway
report differs, it's **definitional, not an error**: Signals attributes revenue to the *stay*
date (not booking date), removes refundable deposits, counts £0 for cancelled/declined bookings,
does **not** deduct channel (OTA) commission (figures are gross of OTA fees), includes VAT by
default (toggle to exclude), and converts everything to one display currency. (Full note:
`AUDIT-A7-reconcile.md`.)

## Tags & rollback

- Prod live commit: **`b6d31c2`** (deployed 2026-06-29 21:42:51; was `f90f50d` when this
  report was first written — see CORRECTION at top).
- Rollback target: **`backup/prod-live` = `82841b3`**.
- Local rollback: `git reset --hard backup/main-audit-2026-06-29`.
- Prod rollback: `git push --force-with-lease origin backup/prod-live:main` → redeploy + restart `signals-worker`.

## What still needs you

1. **Rotate the old `AIRROI_API_KEY`** (it fed dead code; now removed from code).
2. Confirm **Alma Place's** real room count.
3. Decide on the **date-preset placement** so the follow-up can wire them.
4. (Optional) tell me to **unset the dead `AIRROI_*` env vars** on Railway — left in place to
   avoid an extra redeploy; they're now unread by the code so harmless.

Full evidence: `AUDIT-FINDINGS.md` (triage) and the per-discipline `AUDIT-A1/A2/A3/A7/UI/DEADWOOD` files.
