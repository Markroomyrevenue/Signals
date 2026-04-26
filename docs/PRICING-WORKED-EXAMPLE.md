# How a Base Price gets calculated — a worked example

Last updated: 2026-04-26

This doc traces how Signals arrives at a recommended **base price** (and the
**minimum price** that follows from it) for one apartment, end to end. Use it
as a sense-check next time the calendar surprises you.

The formula lives in [`src/lib/pricing/market-anchor.ts`](src/lib/pricing/market-anchor.ts) inside the
function `buildRecommendedBaseFromHistoryAndMarket`. There's a comment block
at the top of that function with the same content in code form.

---

## The example apartment

Imagine a 2-bedroom apartment in Belfast called **Marina Studio**. Here is
everything the engine knows about it (all of this is already in the database
after a Hostaway sync):

| Input | Value | Where it comes from |
| --- | --- | --- |
| Bedrooms | 2 | Hostaway listing record |
| Bathrooms | 1 | Hostaway listing record |
| Max guests | 4 | Hostaway listing record |
| Booked nights, last 365 days | 142 | `night_facts` table |
| Average nightly rate, same nights (ADR) | £128 | `night_facts` table |
| Occupancy on those 365 days | 71% (`142 ÷ 200` short-stay nights) | derived |
| Belfast comparable median rate | £140 | cached comparable data (no AirROI calls) |
| Rounding increment | £5 | `pricing_settings` table |

Long stays over 14 nights are **excluded** from the ADR calculation because
they are usually heavily discounted and would drag the recommendation down.

---

## Step 1 — Compute four anchors

The engine builds **four independent signals** ("anchors") and then blends
them. None of them depend on AirROI or any live external service — they're
all derived from data already in the database.

### Anchor 1 · Size anchor (always present, low weight)

A deterministic floor based purely on bedrooms / bathrooms / guests. Two
identical apartments always get the same number. This is the
"near-identical apartments don't drift apart" stabiliser.

```
Size anchor = £80 base
            + £40 × bedrooms
            + £20 × bathrooms
            + £10 × max(0, max_guests - 2)
            then clamped to [£50, £600]
```

For Marina Studio:

```
£80 + (£40 × 2) + (£20 × 1) + (£10 × max(0, 4 - 2))
= £80 + £80 + £20 + £20
= £200
```

### Anchor 2 · Own-history base (heaviest weight when confident)

The achieved ADR over the last 365 days for **similar periods** (same
weekday mix, same season), excluding long stays. Confidence is high when
there are enough qualifying booked nights to trust the sample.

For Marina Studio: `£128` from 142 qualifying nights → **confidence: high**.

### Anchor 3 · Market benchmark (modest weight, sanity check)

The cached comparable-comp benchmark from nearby properties of similar
size. Used as a "what does the rest of the street look like" sanity check.
Cached only — **no AirROI calls.**

For Marina Studio: `£140` (Belfast comparable median).

### Anchor 4 · Trailing-365d ADR (soft fallback)

The same ADR signal as anchor 2 but used as a softer fallback. Modulated
±10% by occupancy:

- Occupancy < 40% → nudge ×0.9 (the price seems too high to fill nights)
- Occupancy > 85% → nudge ×1.1 (room to push)
- 40–85% → no nudge

For Marina Studio: `£128` × 1.0 (occ 71% sits in the middle band) = `£128`.

---

## Step 2 — Weight and blend

Each anchor gets a weight depending on which other signals are available.

| Anchor | Value | Weight (this case) | Why this weight |
| --- | --- | --- | --- |
| Own-history base | £128 | **0.55** | confidence is "high" |
| Market benchmark | £140 | **0.25** | always 0.25 when present |
| Trailing-365d ADR | £128 | **0.10** | down-weighted because own-history is also present |
| Size anchor | £200 | **0.15** | always 0.15 when other signals exist |

> If own-history were unavailable (e.g. brand-new listing), trailing-ADR
> jumps to 0.30 and size anchor jumps to 0.60 to compensate.

Weighted-average calculation:

```
numerator   = (128 × 0.55) + (140 × 0.25) + (128 × 0.10) + (200 × 0.15)
            = 70.40       + 35.00        + 12.80        + 30.00
            = 148.20

denominator = 0.55 + 0.25 + 0.10 + 0.15 = 1.05

blended     = 148.20 ÷ 1.05 = 141.14
```

---

## Step 3 — Round to the rounding increment

The portfolio's `roundingIncrement` is `£5`, so:

```
round(141.14 / 5) × 5 = round(28.23) × 5 = 28 × 5 = £140
```

**Recommended base price = £140 / night.**

---

## Step 4 — Derive the minimum price

The minimum price is always the base × 0.7 (i.e. -30%), then rounded to the
same increment. This rule is locked in
[`src/lib/reports/pricing-report-assembly.ts`](src/lib/reports/pricing-report-assembly.ts) — you cannot accidentally
recommend below it.

```
£140 × 0.7 = £98
round(£98 / 5) × 5 = round(19.6) × 5 = 20 × 5 = £100
```

**Minimum price = £100 / night.**

---

## Why the same logic produces stable prices for near-identical apartments

The owner-reported pain (Round 1) was that two near-identical apartments in
the **Stay Belfast** portfolio were getting visibly different
recommendations because the old formula was almost entirely history-driven
— a £4 difference in own-history ADR became a £4 difference in the final
recommendation.

With the new four-anchor blend, here's what happens for two apartments that
are structurally identical (same bedrooms / bathrooms / guests / area
comparable) but have slightly different booking histories:

|  | Apartment A | Apartment B |
| --- | ---: | ---: |
| Own-history ADR | £128 | £136 |
| Market benchmark | £140 | £140 |
| Trailing-ADR | £128 | £136 |
| Size anchor | £200 | £200 |
| Weighted blend | £141.14 | £146.10 |
| Rounded to £5 | **£140** | **£145** |

The £8 gap in their booking-history ADR collapses to a £5 gap in the final
recommendation — one rounding bucket — because the size anchor and market
benchmark act as gravitational pulls toward the same number.

---

## Three things that change the answer

If a property's recommendation looks "wrong", suspect (in this order):

1. **Per-listing override in `pricing_settings`** — manually set base or
   minimum prices override the engine entirely.
2. **Different `historicalAnchorObservations`** — different 365-day booking
   history (e.g. one apartment was off the market for 3 months, the other
   wasn't).
3. **Different cached comparable set** — comparables are derived from
   listing location; if one apartment has missing or stale lat/lon it falls
   back to a portfolio-wide comparable set, which can drift.
4. **Different `bedroomsNumber` / `personCapacity` / `roomType` on the
   `Listing`** — Hostaway sometimes ships these as `null`; the engine
   treats `null` as "1 bedroom, 2 guests" which can shift the size anchor.

---

## Where to look in code

- Formula header comment — [`src/lib/pricing/market-anchor.ts:664`](src/lib/pricing/market-anchor.ts#L664)
- Size-anchor function — [`src/lib/pricing/market-anchor.ts:792`](src/lib/pricing/market-anchor.ts#L792)
- Min = base × 0.7 lock — [`src/lib/reports/pricing-report-assembly.ts`](src/lib/reports/pricing-report-assembly.ts)
- Tests covering "near-identical apartments → near-identical prices" —
  [`src/lib/pricing/market-anchor.test.ts`](src/lib/pricing/market-anchor.test.ts)
