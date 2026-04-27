# Peer-shape pricing — the temporary go-live branch

Last updated: 2026-04-27

This is a **temporary** pricing model that fires only for listings
where Hostaway live writes are enabled. It exists so that the very
first listings going live to Hostaway use a pricing curve the owner
already trusts (based on their own configured base / minimum prices),
shaped by what their portfolio peers are actually getting per night —
not by the full anchor formula yet.

We will deprecate it once the standard formula is validated end to
end against PriceLabs' shape on the test listing.

---

## Why this exists

The standard recommended-base formula in
[`src/lib/pricing/market-anchor.ts`](../src/lib/pricing/market-anchor.ts)
is correct in isolation (see
[`docs/PRICING-WORKED-EXAMPLE.md`](./PRICING-WORKED-EXAMPLE.md)).
What it has *not* yet been validated against is **going live to a
Hostaway listing alongside PriceLabs as a side-by-side benchmark.**

The owner's go-live constraint is:

> I trust the base price and minimum I've set on this listing — that's
> the lever I'd use anyway. What I want from Signals on day one is
> the **shape** that PriceLabs gives me: weekends higher, midweek
> lower, seasonality + lead-time pull. Don't move my anchor; just
> shape around it from the peers.

Peer-shape pricing is the implementation of that ask. It's a
deliberately smaller surface than the full formula, with fewer
moving parts, so any divergence from PriceLabs is straightforward
to diagnose.

---

## When this branch fires

```
hostawayPushEnabled === true   →   peer-shape pricing
hostawayPushEnabled === false  →   standard anchor formula
```

The flag is the per-listing `hostawayPushEnabled` toggle — same flag
that controls whether the calendar inspector's "Push to Hostaway"
button is enabled. It's resolved through the standard `pricing_settings`
hierarchy: `property → group → portfolio → default = false` (see
[`src/lib/pricing/settings.ts`](../src/lib/pricing/settings.ts)).

In practice during go-live: only **Mark Test Listing (Hostaway id 513515)**
has `hostawayPushEnabled === true`, so this branch only affects that
one listing.

---

## The model

For each listing date `d` where the branch fires:

```
recommended_rate(d) =
    user_base_price
  × shape_factor(d)
  ; clamped to [user_minimum_price, ∞)
  ; rounded to portfolio rounding increment
```

### `user_base_price`, `user_minimum_price`

Read from the listing's effective `pricing_settings.basePrice` and
`pricing_settings.minimumPrice` — the values the owner explicitly
set in the calendar inspector. **Not** the algorithm's recommended
base. This is the trust anchor.

### `shape_factor(d)`

```
shape_factor(d) = peer_avg_nightly_rate(d) ÷ peer_trailing_365d_adr
```

A unit-less multiplier. `1.0` means "this date sits at the peer
yearly average". `1.4` means "peers are getting 40% above their
yearly average on this date". `0.7` means "30% below yearly average".

#### `peer_avg_nightly_rate(d)`

The simple average of nightly rates that **peer listings actually
realised on date `d`**. Peers are selected per
[`selectPortfolioPeerSetListingIds`](../src/lib/pricing/peer-set.ts) —
same bedroom count as the subject listing, and group-tag-symmetric
(if either subject or candidate has a `group:` tag, both must share
the same group key).

#### `peer_trailing_365d_adr`

The peer set's blended ADR over the trailing 365 days, computed via
[`computePortfolioPeerSetAdr`](../src/lib/pricing/peer-set.ts). Same
filtering rules as elsewhere: long stays > 14 nights and cancelled /
no-show statuses are excluded.

### Clamp + round

After multiplying, clamp the result up to `user_minimum_price` if it
fell below, then round to the portfolio's `roundingIncrement`
(default £5). The clamp protects against the shape factor pushing the
recommendation below what the owner has explicitly told us they're
willing to take.

---

## Available nights only — and why it matters

When computing `peer_avg_nightly_rate(d)`, **include only peer
listings that were actually open and available for sale on date `d`.**

A peer listing that is:

- blocked / unavailable / closed for that date,
- has no published price (zero / null nightly rate),
- is out of the booking window altogether,

does **not** contribute to the average for that date.

### Why

If you naively average across all peers — including the unavailable
ones with no rate — every blocked night drags the average toward
zero and the shape factor collapses. You'd see a peak weekend
recommendation that's lower than the surrounding midweek nights
purely because two peers happened to be blocked off that Saturday.

Including only available nights also matches what PriceLabs does in
its own shape model — peers that aren't actually in the market on
that date don't tell us anything useful about market shape, so they
shouldn't influence the factor.

The same rule applies on the denominator (`peer_trailing_365d_adr`):
the helpers in
[`src/lib/pricing/peer-set.ts`](../src/lib/pricing/peer-set.ts)
already filter to revenue-positive booked nights only, which is the
trailing-window equivalent of "actually available and sold".

---

## Worked example

Say Mark Test Listing has:

- `user_base_price` = £180
- `user_minimum_price` = £140
- portfolio rounding increment = £5

For a Saturday in peak season — say 2026-07-04:

| Peer | Available 2026-07-04? | Realised rate |
| --- | --- | ---: |
| Studio A | yes | £225 |
| Studio B | yes | £210 |
| Studio C | blocked | — (excluded) |
| Studio D | yes | £240 |
| Studio E | yes | £230 |

Peer average for that date = (225 + 210 + 240 + 230) / 4 = **£226.25**.

Peer trailing-365d ADR (helper output): **£165**.

Shape factor = 226.25 / 165 = **1.371**.

Recommended rate = 180 × 1.371 = **£246.78**, clamped to ≥ £140
(no-op), rounded to £5 = **£245**.

For a midweek lull date in shoulder season — say 2026-11-12 (Thursday):

| Peer | Available 2026-11-12? | Realised rate |
| --- | --- | ---: |
| Studio A | yes | £125 |
| Studio B | yes | £130 |
| Studio C | yes | £120 |
| Studio D | blocked | — (excluded) |
| Studio E | yes | £128 |

Peer average = (125 + 130 + 120 + 128) / 4 = **£125.75**.

Shape factor = 125.75 / 165 = **0.762**.

Recommended rate = 180 × 0.762 = **£137.16**. Clamped up to
`user_minimum_price` = **£140**. Rounded = **£140**.

Result: peak Saturday = £245, midweek shoulder = £140. The shape
mirrors what PriceLabs would produce on the same listing, and the
anchor is the owner's chosen £180 base / £140 min.

---

## When this branch will be deprecated

Peer-shape pricing is **temporary**. The conditions for removing it:

1. The Hostaway integration has run cleanly on listing 513515 over
   a full booking cycle — pushes land, no `verify-mismatch` events,
   no surprise 403s from PriceLabs claiming the calendar.
2. The owner has signed off that the standard anchor formula
   (last-year ADR + market + size, × quality) produces shapes that
   are at-parity-or-better than peer-shape on the test listing.
3. The full anchor formula's inputs are validated for live writes —
   in particular, the cached comparator data is refreshed and
   correct, and any per-listing `pricing_settings` overrides are
   sane.

When all three are met:

- Remove the branch in the calendar-assembly path that switches
  on `hostawayPushEnabled` for pricing.
- Standard anchor formula will then drive recommendations for
  live-pushable listings too.
- Peer-shape helpers in `peer-set.ts` may still have other uses
  (e.g. peer comparison summaries in the inspector) — don't delete
  them blindly. Just remove the pricing-time switch.

Track this so the temporary branch doesn't quietly become permanent.
A follow-up issue should be opened the day the standard formula is
proven on listing 513515.

---

## Where to look in code

| Concern | File |
| --- | --- |
| `hostawayPushEnabled` resolution | [`src/lib/pricing/settings.ts`](../src/lib/pricing/settings.ts) |
| Peer-set selection rules | [`src/lib/pricing/peer-set.ts`](../src/lib/pricing/peer-set.ts) |
| Peer trailing-365d ADR | `computePortfolioPeerSetAdr` in `peer-set.ts` |
| Calendar assembly that picks the branch | [`src/lib/reports/pricing-report-assembly.ts`](../src/lib/reports/pricing-report-assembly.ts) |
| Standard formula it replaces | [`src/lib/pricing/market-anchor.ts`](../src/lib/pricing/market-anchor.ts) |
| Hostaway live-write path | [`src/lib/hostaway/push.ts`](../src/lib/hostaway/push.ts), [`src/lib/hostaway/push-service.ts`](../src/lib/hostaway/push-service.ts) |

## Companion docs

- [`docs/PRICING-WORKED-EXAMPLE.md`](./PRICING-WORKED-EXAMPLE.md) —
  the standard formula for everything that isn't pushing to Hostaway.
- [`docs/HOSTAWAY-PUSH.md`](./HOSTAWAY-PUSH.md) — the live-write
  loop, the proven schema, the verify-after-push pattern, and the
  allowlist guard.
