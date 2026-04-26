# How a Base Price gets calculated — a worked example

Last updated: 2026-04-26 (formula simplified — see "What changed" at the bottom).

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
| Last-year ADR (£ per booked night) | £128 | `night_facts` table |
| Last-year occupancy on those 365 days | 71% | derived |
| Belfast comparable median rate | £140 | cached comparable data (no AirROI calls) |
| Quality tier | `mid_scale` | `pricing_settings` table |
| Quality multiplier (for `mid_scale`) | 1.00 | `pricing_settings.qualityMultipliers` |
| Rounding increment | £5 | `pricing_settings` table |

> Long stays over 14 nights are excluded from the ADR calculation because
> they are usually heavily discounted and would drag the recommendation
> down.

---

## Step 1 — Compute three anchors

The engine builds **three independent signals** ("anchors") and then blends
them. None of them depend on AirROI or any live external service — they're
all derived from data already in the database.

### Anchor 1 · Last-year ADR (HEAVIEST · weight 0.55)

The simple average of every booked night over the last 365 days, then nudged
by occupancy:

- Occupancy < 40% → ×0.9 (the listing is overpriced; trim)
- Occupancy > 85% → ×1.1 (the listing is underpriced; push)
- 40–85% → no nudge

For Marina Studio: `£128 × 1.0 (occ 71% sits in the middle band) = £128`.

This is the heaviest anchor because what the listing has actually achieved
over a full year is the strongest single signal of what it can achieve next
year.

### Anchor 2 · Market benchmark (weight 0.30)

The cached comparable-comp benchmark — what nearby properties of similar
size are achieving. Cached only — **no AirROI calls.**

For Marina Studio: `£140` (Belfast comparable median).

### Anchor 3 · Size anchor (weight 0.15 when market benchmark is present, 0.45 when missing)

A deterministic floor based purely on bedrooms / bathrooms / guests. Two
identical apartments always get the same number — this is the
"near-identical apartments don't drift apart" stabiliser, and the safety
net when no market benchmark is available.

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

> **Why keep size anchor at all if the market benchmark already covers
> similar properties?** Because the market benchmark is sometimes missing
> (new listings without comparables, properties in unusual locations) and
> the comparable set can be biased by a small sample. Size anchor stays
> at low weight as a stability floor, then steps up to 0.45 when the
> market benchmark is unavailable.

---

## Step 2 — Weight and blend

| Anchor | Value | Weight (this case) |
| --- | ---: | ---: |
| Last-year ADR | £128 | 0.55 |
| Market benchmark | £140 | 0.30 |
| Size anchor | £200 | 0.15 |

Weighted-average calculation:

```
numerator   = (128 × 0.55) + (140 × 0.30) + (200 × 0.15)
            = 70.40        + 42.00        + 30.00
            = 142.40

denominator = 0.55 + 0.30 + 0.15 = 1.00

blended     = 142.40 ÷ 1.00 = 142.40
```

---

## Step 3 — Apply the quality-tier multiplier

The portfolio-level `qualityMultipliers` map (from `pricing_settings`)
defines a multiplier for each tier. Defaults:

| Tier | Multiplier |
| --- | ---: |
| `low_scale` | 0.95 |
| `mid_scale` | 1.00 |
| `upscale` | 1.10 |

Marina Studio is `mid_scale` → multiplier 1.00, so this step is a no-op:
`£142.40 × 1.00 = £142.40`.

If we re-tagged Marina Studio as `upscale`, the same blend would become
`£142.40 × 1.10 = £156.64` (and rounded, £155). If we re-tagged it as
`low_scale`, it would become `£142.40 × 0.95 = £135.28` (rounded, £135).

> **Changing the quality tier in the calendar settings now actually
> moves the recommended price**, which it didn't before
> 2026-04-26.

---

## Step 4 — Round to the rounding increment

The portfolio's `roundingIncrement` is `£5`, so:

```
round(142.40 / 5) × 5 = round(28.48) × 5 = 28 × 5 = £140
```

**Recommended base price = £140 / night.**

---

## Step 5 — Derive the minimum price

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

Two structurally identical 2-bed/1-bath/4-guest apartments in Belfast that
differ only in last-year ADR (one £128, one £136):

|  | Apartment A | Apartment B |
| --- | ---: | ---: |
| Last-year ADR | £128 | £136 |
| Market benchmark | £140 | £140 |
| Size anchor | £200 | £200 |
| Quality multiplier | 1.00 | 1.00 |
| Weighted blend | £142.40 | £146.80 |
| Rounded to £5 | **£140** | **£145** |

The £8 gap in last-year ADR collapses to a £5 gap in the final
recommendation — one rounding bucket.

---

## Three things that change the answer

If a property's recommendation looks "wrong", suspect (in this order):

1. **Per-listing override in `pricing_settings`** — manually set base or
   minimum prices override the engine entirely.
2. **Quality tier was changed** — moving from `mid_scale` to `low_scale`
   trims ~5%; to `upscale` adds ~10% (defaults). These are now wired into
   the formula.
3. **Different last-year ADR** — different 365-day booking history (e.g.
   one apartment was off the market for 3 months, the other wasn't).
4. **Different cached comparable set** — comparables are derived from
   listing location; if one apartment has missing or stale lat/lon it falls
   back to a portfolio-wide comparable set, which can drift.
5. **Different `bedroomsNumber` / `personCapacity` on the `Listing`** —
   Hostaway sometimes ships these as `null`; the engine treats `null` as
   "1 bedroom, 2 guests" which can shift the size anchor.

---

## What changed on 2026-04-26

- **Removed**: the "own-history base" anchor (which used same-period
  achieved nightly rate with weekday matching). It was producing noise
  relative to a simple trailing-365d ADR signal. Confidence labelling
  went with it.
- **Added**: a quality-tier multiplier that runs after the anchor blend,
  so changing a property's quality tier in calendar settings now
  actually moves the recommendation.
- **Reweighted**: last-year ADR is now the heaviest anchor (0.55), then
  market benchmark (0.30), then size anchor (0.15 / 0.45 fallback).

---

## Where to look in code

- Formula header comment — [`src/lib/pricing/market-anchor.ts:664`](src/lib/pricing/market-anchor.ts#L664)
- Size-anchor function — [`src/lib/pricing/market-anchor.ts`](src/lib/pricing/market-anchor.ts)
- Quality multipliers — [`src/lib/pricing/settings.ts:702`](src/lib/pricing/settings.ts#L702) (`qualityMultiplierForTier`)
- Min = base × 0.7 lock — [`src/lib/reports/pricing-report-assembly.ts`](src/lib/reports/pricing-report-assembly.ts)
- Tests covering "near-identical apartments → near-identical prices" and
  "quality tier moves the price" — [`src/lib/pricing/market-anchor.test.ts`](src/lib/pricing/market-anchor.test.ts)
