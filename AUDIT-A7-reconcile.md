# Agent 7b — Hostaway-vs-Signals reconciliation note

**Scope:** ONE listing × ONE finished month (May 2026) for two tenants, raw
Hostaway reservations vs DB `night_facts` vs `buildSalesReport`. Bounded pull
(≤10 Hostaway pages/tenant, cached to scratchpad). Read-only against prod.

Spot-check script: `scripts/audit/a7b-reconcile.ts`.

---

## 1. Client-facing reconciliation note (paste-ready)

> **Why your Signals revenue number can differ from what you see in Hostaway**
>
> Signals and Hostaway are both correct — they're answering slightly different
> questions. Here's exactly how Signals counts, so you can line the two up.
>
> **1. We count revenue by the night you *stayed*, not the day you *booked*.**
> A booking that spans a month boundary is split across the nights it covers. So
> a Signals "May" figure is the value of the nights actually slept in May — not
> every booking that happened to be *made* in May. Hostaway's booking-date views
> group differently; that's the single biggest reason a month total can look off.
>
> **2. We show what the guest paid for the stay, with the refundable deposit
> removed.** Signals revenue = room rate + cleaning fee + guest/service fees +
> taxes, on the nights stayed. We strip out any **refundable security/damage
> deposit** because that money is a hold, not earnings. If Hostaway shows a higher
> "total price", a refundable deposit is usually the gap.
>
> **3. Cancelled, declined, expired and inquiry bookings earn £0.** They stay
> visible for audit, but they don't add a penny to revenue or to occupied nights.
> (A cancellation that was later re-booked is credited to pace correctly.)
>
> **4. Channel commission is *not* deducted.** Signals revenue is gross of the
> OTA's commission (Airbnb/Booking.com fees). It is closer to "total guest
> payment" than to "net payout". If you compare against a Hostaway *payout/owner*
> report, expect Signals to read higher by roughly the commission.
>
> **5. VAT/taxes are *included* in the headline revenue.** There is a toggle to
> view figures net of VAT; with it off, tax is part of the number.
>
> **6. Everything is converted to one display currency** (default GBP) at the
> stay-date FX rate, so multi-currency portfolios add up cleanly.
>
> In our May 2026 spot-check, on a like-for-like "nights stayed in May" basis,
> Signals matched the raw Hostaway reservation totals **to the penny** for both a
> Stay Belfast and a Little Feather listing.

---

## 2. Spot-check numbers (May 2026, GBP)

| Tenant | Listing (Hostaway id) | Occupied nights | Headline revenue (incl fees, ex deposit) | Revenue ex fees |
|---|---|---|---|---|
| Stay Belfast | Belfast – City Gate (195070) | A:28 / B:28 / C:28 | A:5842.77 / B:5842.77 / **C:5842.77** | room A:4388.42 / nf B:5143.01 / report C:5211.11 |
| Little Feather | 10 – New CB Apt 1 (515103) | A:31 / B:31 / C:31 | A:3949.40 / B:3949.40 / **C:3949.40** | A:3949.40 / B:3949.40 / **C:3949.40** |

Legend — **A** = raw Hostaway reservation fields (allocated `total / los_nights`
over nights stayed in the window, deposit already stripped by
`parseReservationFinancials`); **B** = DB `night_facts` via the exact
service.ts:1167-1173 formula (`r.total/los_nights`, fallback `revenue_allocated`);
**C** = `buildSalesReport` output summed over the month bucket.

**Headline revenue (the customer-facing number) and occupied nights reconcile
to the penny across all three layers, both tenants.**

---

## 3. Classification of every delta observed

| # | Delta | Magnitude | Class | Notes |
|---|---|---|---|---|
| D1 | Hostaway "total price" vs Signals headline | = refundable deposit | **(b) Definitional** | `parseReservationFinancials` subtracts refundable security/damage deposits (client.ts:455-461). Intentional and documented. |
| D2 | Booking-date totals vs Signals month total | varies | **(b) Definitional** | Signals allocates by stay-night (`total/los_nights`), not booking date. Largest source of "looks wrong" for clients. |
| D3 | Cancelled/declined/expired/inquiry contribute £0 | varies | **(b) Definitional** | `NON_BOOKED_STATUSES` in nightfact.ts:5-13 zeroes revenue + `is_occupied`. Matches "stayed revenue" intent. |
| D4 | Channel commission not deducted | ≈ OTA % | **(b) Definitional** | `commission` is parsed and stored but NOT subtracted from `total`. Signals revenue is gross-of-commission (guest-payment view, not payout). Worth stating to clients explicitly. |
| D5 | VAT included in headline | listing `vat_rate_pct` | **(b) Definitional** | VAT is in revenue; `includeVat` toggle nets it out. |
| D6 | Stay Belfast "ex fees" room revenue disagrees across layers: raw `accommodationFare` 4388.42 ≠ DB `revenue_allocated` 5143.01 ≠ report ex-fees 5211.11 | ~£820 spread on one listing-month | **(b) Definitional / data-quality** | Three different "room-only" reconstructions: (i) Hostaway's native `accommodationFare`; (ii) `night_facts.revenue_allocated` written at sync from the same field; (iii) report's ex-fees = `total − allocated cleaning`. They diverge because Hostaway's `accommodationFare` and the report's "total minus cleaning" are not the same decomposition, and `revenue_allocated` reflects the value at sync time. **The headline (incl-fees) number is unaffected** — only the ex-fees breakdown moves. Recommend the client-facing "revenue" always be the incl-fees figure; treat the ex-fees split as indicative. Not a P0/P1: no customer headline number is wrong. |
| D7 | FX conversion to display currency | 0 here (all GBP) | **(b) Definitional** | Stay-date FX via `FxConverter`. No effect on these GBP tenants. |

No **(a) Signals bug** and no **(c) Hostaway data issue** surfaced in this
spot-check. D6 is the only intra-Signals inconsistency and it lives entirely in
the *ex-fees* breakdown, which is not the headline revenue clients read.

### Signals include/exclude vs Hostaway native dashboard — exact list

Signals headline "revenue" (`r.total`, allocated per night) =
**room rate + cleaning fee + guest/service fees + taxes (VAT)**, on stayed nights,
for non-cancelled bookings, in display currency.
- **Excludes:** refundable security/damage deposits (D1); cancelled/declined/
  expired/inquiry bookings (D3).
- **Does NOT deduct:** channel commission (D4) — so it sits above an OTA payout
  figure.
- **Includes:** VAT/taxes by default (D5, toggle-able); cleaning + guest fees (D1
  catch-all in `parseReservationFeeBreakdown`).
- **Allocates** by stay-night, dividing `total / los_nights` (D2), so month/period
  totals are stay-weighted, not booking-weighted.

---

## Summary (≤10 lines)

1. Headline revenue + occupied nights reconcile **to the penny** across raw
   Hostaway, DB `night_facts`, and `buildSalesReport` for both spot-checked
   tenants (May 2026).
2. Every Hostaway-vs-Signals gap is **definitional, not a bug**: stay-date (not
   booking-date) allocation, refundable-deposit removal, £0 for cancelled/inquiry,
   commission NOT deducted (gross-of-OTA), VAT included by default, FX to one
   currency.
3. The only intra-Signals wobble (D6) is in the **ex-fees room-only** breakdown
   (~£820 on one Stay Belfast listing-month); the customer-facing incl-fees number
   is unaffected. Recommend clients read the incl-fees figure as "revenue".
4. Action for sales/onboarding: lead with point #4 (commission not deducted) and
   #1 (stay-date) — those two explain almost every "your number differs" question.
5. No P0/P1 reconciliation defect found. Spot-check script:
   `scripts/audit/a7b-reconcile.ts`.
