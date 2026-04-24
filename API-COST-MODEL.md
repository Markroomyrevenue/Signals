# Market Data API Cost Model — Roomy Revenue (Hostaway Analytics MVP)

**Prepared:** 21 April 2026
**Scope:** 6 live clients, AirROI as the external market data provider (the only third-party market API wired into the code path)
**Basis:** Static review of the scheduling/calendar logic, data model, and pricing pipeline. No external API calls were made.
**Posture:** Conservative — where uncertain, assumptions are chosen to slightly overestimate usage rather than underestimate it.

---

## 1. Executive summary

| Metric | Value |
|---|---|
| Total monthly calls across 6 live clients (intended cadence) | **≈ 16,300 calls/month** |
| Average monthly calls per listing | **≈ 185 calls/listing/month** |
| Average monthly calls per client | **≈ 2,720 calls/client/month** |
| Dominant driver | Daily comparable-listing future-rate pulls (`/listings/future/rates`) — ~87% of all traffic |
| Secondary driver | Daily market occupancy + future pacing (`/markets/metrics/*`) — ~7% |
| Weekly "market/property-size" traffic | ~930 calls/month (~6% of total) |

**Biggest opportunities to reduce usage:**

1. Drop **comparable future-rate** cadence from daily to every 2–3 days — saves ~50–65% of total traffic with negligible loss of pricing quality.
2. Cache **`lookupMarket`** and **`getComparableListings`** for 30 days rather than weekly — lat/lng and comparable-set membership are extremely stable. Saves another ~5%.
3. Enforce **cross-tenant cache reuse** (the DB cache already supports it — just needs a scheduled refresh job rather than on-demand calls). If any two clients cover overlapping UK markets, platform-wide market-size calls collapse from 19 to ~12.
4. Switch comparable future-rate pulls from **per-comparable-listing** to **market-level future pacing** where possible — the `getMarketFuturePacing` endpoint already supplies the signal at market granularity; comparable-level rates are only needed for pricing anchoring.

The primary risk as you scale: comparable future-rate traffic scales **linearly with listings** and refreshes independently per subject listing. A 3× fleet growth triples the monthly bill under current intended cadence.

---

## 2. Client-by-client table

**Assumption:** Client-level listing counts, markets, and size groupings are not resolvable from the code alone (no DB access from this sandbox and no config file enumerates tenants). The table below uses a realistic UK STR revenue-management portfolio mix and is deliberately biased slightly high. Swap the listing counts with your actuals to get exact numbers — formulas are preserved in §4.

| Client | Active listings (L) | Markets (M) | Size groups / market (G) | M × G | Unique comparables (C\_u) | Demand calls / mo | Market-size calls / mo | Other | Total / mo | Calls / listing / mo |
|---|---|---|---|---|---|---|---|---|---|---|
| Client A (largest) | 25 | 2 | 3 | 6 | 150 | 5,022 | 270 | 0 | **5,292** | **212** |
| Client B | 18 | 1 | 3 | 3 | 75 | 2,511 | 183 | 0 | **2,694** | **150** |
| Client C | 15 | 2 | 2 | 4 | 88 | 2,976 | 165 | 0 | **3,141** | **209** |
| Client D | 12 | 1 | 2 | 2 | 50 | 1,674 | 122 | 0 | **1,796** | **150** |
| Client E | 10 | 1 | 2 | 2 | 50 | 1,674 | 104 | 0 | **1,778** | **178** |
| Client F (smallest) | 8 | 1 | 2 | 2 | 44 | 1,488 | 87 | 0 | **1,575** | **197** |
| **Total** | **88** | **8** (distinct) | — | **19** | **457** | **15,345** | **931** | 0 | **≈ 16,276** | **≈ 185** |

Grouping assumption (all clients): listings in the same market that share a bedrooms bucket (±1), baths bucket (±0.5), guest-capacity bucket (±2), and the `min_nights ≤ 7` filter collapse to one market-summary/occupancy/ADR/pacing call — matching how `buildMarketPricingContexts` already deduplicates within a request.

"Other" = retries, one-offs, webhook-triggered refreshes. The AirROI client in `src/lib/airroi/client.ts` performs **no retries** (the BullMQ `attempts: 3` in `src/lib/queue/queues.ts` is for Hostaway sync jobs, not AirROI). Flagged separately: budget an extra ~3% on top of the total for transient error re-pulls once live webhook triggers are added.

---

## 3. Methodology and assumptions

### 3.1 What was observed in code (facts, not assumptions)

1. **Single external market API in use:** AirROI. Wired through `src/lib/airroi/client.ts` via `createMarketDataProvider()` in `src/lib/pricing/market-data-provider.ts`.
2. **7 AirROI endpoints are called** from `buildMarketPricingContexts` (`src/lib/pricing/market-recommendations.ts`):
   - `GET /markets/lookup` — 1 call per unique (lat, lng, 4-dp) pair
   - `POST /markets/summary` — 1 call per unique (market + filter) signature
   - `POST /markets/metrics/occupancy` — same dedup key as summary
   - `POST /markets/metrics/average-daily-rate` — same dedup key
   - `POST /markets/metrics/future/pacing` — same dedup key
   - `GET /listings/comparables` — 1 call per unique (coords or address + bedrooms + baths + guests) signature
   - `GET /listings/future/rates` — 1 call per **comparable** listing id (up to 18 comparables are retained per subject listing for benchmarking; the top 6 also feed daily comparison rates)
3. **In-request dedup:** All 7 endpoints are dedup'd inside a single invocation of `buildMarketPricingContexts` via local `Map` caches (`lookupCache`, `summaryCache`, `occupancyCache`, `adrCache`, `pacingCache`, `comparableCache`, `futureRateCache`).
4. **Cross-request / cross-tenant dedup:** All calls pass through `withExternalApiCache` (see `src/lib/external-api-cache.ts`) which writes to the `external_api_cache` table keyed by `(provider, hash(method + URL + body))`. **The cache key does not include tenant id** — so two clients covering the same market automatically share cached payloads. Default TTL is **14 days** (`AIRROI_CACHE_TTL_DAYS=14` in `src/lib/env.ts`).
5. **No scheduler drives AirROI today.** Market data is fetched lazily when a user opens the pricing calendar (`POST /api/reports/pricing-calendar`) or when the in-memory 15-minute report cache expires. There is no cron job, no BullMQ `repeat` entry, and no webhook path that triggers AirROI.
6. **`forceRefresh` is off by default.** The feature flag `ROOMY_ENABLE_LIVE_MARKET_REFRESH` (`src/lib/features.ts`) gates any real network call; the `.env.example` ships it as `false`.
7. **Pricing-calendar default window:** 1 calendar month of `dayKeys` per request (`buildPricingCalendarReport` in `src/lib/reports/service.ts` iterates `monthStart → monthEnd`). This is the natural "period of interest" for pricing decisions and drives how much of the comparable future-rate response is actually consumed, but does **not** change the call count — each endpoint is called once per key regardless of how many days are rendered.

### 3.2 What is assumption (clearly labelled)

**A1 — Listing counts per client.** The tenants table is not readable from this sandbox and no per-client config file exists in the repo. The distribution used in §2 (25 / 18 / 15 / 12 / 10 / 8 = 88 listings) reflects a typical UK STR revenue-management mix with one anchor client, two mid-size clients, and three small clients. Swap with your actuals — every other figure scales linearly.

**A2 — Markets per client.** Assumed 1–2 UK markets per client. Most Roomy clients will be geographically concentrated; a few (larger ones) operate in two cities. Conservative.

**A3 — Size groups per market.** Each market is assumed to expand to 2–3 distinct `(bedrooms, baths, guests, min_nights)` filter signatures. For a mixed portfolio (1-bed studios, 2-bed flats, 3-bed houses) this is realistic. If your portfolio is highly uniform (e.g. all 2-bed city flats) the real number is closer to 1 per market, making the estimate conservative.

**A4 — Unique comparable listings.** AirROI returns up to ~25–30 candidates; the code keeps 18 for benchmarking + a top-6 subset for day-level comparisons. The futureRateCache dedups by comparable id within a request. Across subject listings in the same market-size group, ~60–70% of comparables overlap. Conservative effective unique comparable count used: **25 per market-size group**. Total C\_unique = Σ(M × G × 25), rounded per client.

**A5 — Month length.** 31 days for daily work, 4.35 weeks for weekly work. Chosen to slightly overestimate rather than use the calendar-average 30.44.

**A6 — Retries.** Not included in the headline figure because the AirROI path doesn't retry today. Reserve an extra 3–5% cushion in your pricing negotiation for when webhook-triggered live refreshes are added.

**A7 — Cross-tenant dedup.** The primary model assumes **no cross-client sharing** (each client's calls are counted independently), even though the DB cache would merge them in practice. This biases the estimate up — safer for commercial pricing. A separate "best-case dedup" figure is noted in §5.

**A8 — Daily vs weekly classification.** Mapped as per your stated policy:
- **Daily (demand):** `occupancy`, `future/pacing`, `listings/future/rates` — these move with guest behaviour and competitor pricing.
- **Weekly (market/property-size):** `markets/lookup`, `markets/summary`, `markets/average-daily-rate`, `listings/comparables` — these change slowly (ADR curves, comparable set membership, property-type mix).

### 3.3 Ambiguity flags

- **Ambiguous 1:** The repo does not distinguish "demand-only" vs "market/size-only" refresh paths. Today all 7 endpoints fire together on pricing calendar open. The proposed daily/weekly split will require splitting the caller into two refresh jobs (cheap change, ~half a day's work).
- **Ambiguous 2:** The **14-day DB cache TTL** (`AIRROI_CACHE_TTL_DAYS`) is longer than the intended daily demand cadence. Without adjusting the TTL per endpoint, daily demand calls would currently be served from 14-day-old cache. Fix: shorten TTL for demand endpoints to 20 hours, keep market/size endpoints at 14+ days. This is a 1-line config change per endpoint class.
- **Ambiguous 3:** `getListingFutureRates` is categorised as "demand" here because competitor rate movement is the primary daily signal. One could argue it's "market/size" (comparable identity is stable). If you reclassify it to weekly, total traffic drops to ~**3,400 calls/month** — a 79% reduction. That's a genuine trade-off: you lose some responsiveness to competitor repricing but save ~£100/month at a £0.01/call price. Worth testing empirically.
- **Ambiguous 4:** The pricing calendar is loaded **per user session** when a user opens the dashboard. If the same user refreshes or re-opens within 15 minutes, the in-memory report cache serves — no AirROI cost. Across days, the 14-day DB cache absorbs most calls **today**. The figures in §2 model the **intended** cadence, not today's actual traffic (which is dramatically lower because the 14-day TTL effectively defers most refreshes).

---

## 4. Cost model

### 4.1 Formulas

Let, for each client `i`:

- `L_i` = active listings
- `M_i` = distinct markets
- `G_i` = average distinct property-size groups per market
- `C_i` = unique comparable listings fetched for daily future-rate refresh ≈ `M_i × G_i × 25`

Per client per month:

```
daily_demand_calls      =  (2 × M_i × G_i  +  C_i) × 31
weekly_market_calls     =  (2 × L_i  +  2 × M_i × G_i) × 4.35
total_calls_per_client  =  daily_demand_calls + weekly_market_calls
```

Breakdown of coefficients:

- `2 × M_i × G_i` (daily): occupancy + future-pacing calls, one of each per unique market-size combo
- `C_i` (daily): per-comparable-listing future-rate pulls
- `2 × L_i` (weekly): lookup_market + listings/comparables, one each per subject listing
- `2 × M_i × G_i` (weekly): summary + average_daily_rate, one each per unique market-size combo

### 4.2 Headline cost formulas

```
monthly_cost_per_client   =  total_calls_per_client × price_per_call
monthly_cost_per_listing  =  monthly_cost_per_client ÷ L_i
total_monthly_cost        =  Σ total_calls_per_client × price_per_call
                          =  16,276 × price_per_call    (under §2 assumptions)
```

### 4.3 Sensitivity table

**Total monthly cost across all 6 live clients:**

| Price per call | Total monthly cost | Cost per client (avg) | Cost per listing (avg) |
|---|---|---|---|
| £0.001 | **£16.28** | £2.71 | £0.19 |
| £0.005 | **£81.38** | £13.56 | £0.92 |
| £0.010 | **£162.76** | £27.13 | £1.85 |
| £0.020 | **£325.52** | £54.25 | £3.70 |

**Per-client monthly cost at £0.01/call (for individual quoting):**

| Client | Calls/mo | Cost/mo @ £0.01 | Cost/mo @ £0.005 |
|---|---|---|---|
| Client A | 5,292 | £52.92 | £26.46 |
| Client B | 2,694 | £26.94 | £13.47 |
| Client C | 3,141 | £31.41 | £15.71 |
| Client D | 1,796 | £17.96 | £8.98 |
| Client E | 1,778 | £17.78 | £8.89 |
| Client F | 1,575 | £15.75 | £7.88 |

**Upper-bound sanity check** (no in-request batching, no market-size grouping — a pessimistic worst case if code were naive):

- Per listing: 2 daily market calls + 18 daily comparable rates = 20/day → 620/month
- Plus 4 weekly market/size calls → ~17/month
- ≈ **637 calls/listing/month** × 88 listings = **~56,100 calls/month**
- Cost at £0.01 = **£561/month**

The optimised estimate (16,276/mo) is ~71% lower than the worst case because of market-size grouping and comparable-id dedup. Your existing code already delivers those savings within a single request — persisting them across days via the DB cache is mostly free.

---

## 5. Recommendations

### 5.1 Frequency — are daily/weekly correct?

**Daily for true demand signals — yes, but with one change:**
- Occupancy + future pacing: daily is appropriate. These move with guest behaviour.
- Comparable future rates: **daily is more frequent than needed for anchoring**. Move to every 2 days (or every Monday+Thursday). This alone drops your largest traffic bucket by 40–50%.

**Weekly for market/size — yes, with two refinements:**
- `markets/lookup` (lat/lng → market identity): change to **monthly**, or even trigger-only-on-new-listing. Lat/lng doesn't drift.
- `listings/comparables` (picking the comparable set): change to **monthly**. The set of comparable properties changes very slowly for stable UK markets.
- Keep `summary` / `ADR` on weekly — these seasonal curves shift meaningfully over 7-day windows.

Concrete recommended cadence:

| Endpoint | Current intent | Recommended cadence | Rationale |
|---|---|---|---|
| `markets/lookup` | Weekly | **Monthly** | Geographic identity is static |
| `markets/summary` | Weekly | **Weekly** | Seasonal ADR/LoS shifts matter |
| `markets/metrics/occupancy` | Daily | **Daily** | Core demand signal |
| `markets/metrics/average-daily-rate` | Weekly | **Weekly** | Smooth trend signal |
| `markets/metrics/future/pacing` | Daily | **Daily** | Core demand signal |
| `listings/comparables` | Weekly | **Monthly** | Comparable set is stable |
| `listings/future/rates` | Daily | **Every 2 days** | Competitor prices don't typically flex that fast for anchoring |

With those changes, monthly volume drops to roughly:

- Daily demand (occupancy + pacing only): (2 × 19) × 31 = 1,178
- Every-2-days comparable rates: 457 × 15 = 6,855
- Weekly summary + ADR: 2 × 19 × 4.35 = 165
- Monthly lookup + comparables: (88 + 88) = 176
- **Total: ~8,374 calls/month** (~49% reduction vs §2 intended cadence)

At £0.01/call that's **£83.74/month** across all 6 clients, or **~£14/client on average**.

### 5.2 Batching / caching / grouping

1. **Centralise the market refresh as a BullMQ repeat job** instead of page-triggered. Run once at 05:00 UTC for daily signals and Sunday 03:00 UTC for weekly signals. This guarantees calls happen once per scheduled tick, not once per user session.
2. **Split the TTL by endpoint class:**
   - Demand endpoints → TTL 22h
   - Market/size endpoints → TTL 8d
   - `lookup` / `comparables` → TTL 32d
   This lets the existing DB cache naturally enforce the right cadence without new code paths.
3. **Keep the cache key tenant-free** (already the case). This is your most important scaling lever: any market overlap between clients becomes free.
4. **Batch comparable future-rate pulls:** the current code issues one HTTP call per comparable id. AirROI's `/markets/metrics/future/pacing` gives you the same demand shape at market level — consider using market-level pacing as the primary demand signal and dropping per-comparable rate pulls entirely unless the price anchor confidence is flagged as "low". That turns the 457 unique-comparable-rate pulls into at most ~20.
5. **Skip refreshes for paused listings:** the `Listing.status` column already has an index on `(tenantId, status)`. Filter out non-active listings before building the market request list.

### 5.3 Scaling risks

- **Linear per-listing scaling is the main risk.** Every new listing adds 1 weekly lookup + 1 weekly comparables + ~18 daily comparable-rate pulls (today) ≈ 80 new calls/listing/week under current intended cadence. A jump from 6 clients / 88 listings to 20 clients / ~400 listings would push you to ~74,000 calls/month.
- **Cross-tenant dedup collapses quickly in dense UK markets.** If three clients all operate in central Edinburgh 2-bed flats, the effective market-size calls drop to 1/3 of the naive sum. Your DB cache already supports this — make sure you don't add tenant scoping to the cache key when you move to live webhooks.
- **Retries are not counted here.** Once live webhooks trigger ad-hoc refreshes (on booking-created, booking-cancelled) you'll see occasional failures; a modest retry policy would add 3–5%. Budget for this in your negotiated tier.
- **AirROI rate limits:** not observed in code, but commercial API tiers typically cap at 10–60 requests/sec. If you run a morning refresh for all 6 clients in one BullMQ burst, the ~500 morning calls will need to trickle across ~60–90s. Add an `await setTimeout` between batches or use BullMQ's `limiter` option to avoid 429s.
- **Pricing negotiation angle:** because your traffic is highly deduplicable and cache-friendly, you are probably a **below-average-cost-per-listing customer** for a provider like AirROI. Use the per-listing figure (£0.19–£3.70/listing/month depending on price point) as your anchor when negotiating; any per-call price above £0.02 effectively prices in redundancy that your architecture doesn't generate.

---

## Appendix — Quick formulas to paste into a sheet

```
A. Per-client monthly calls
   = 31 × (2·M·G + C_u)  +  4.35 × (2·L + 2·M·G)
   where C_u ≈ M · G · 25  (conservative)

B. Platform monthly calls (no cross-tenant dedup)
   = Σ_clients [A]

C. Platform monthly calls (with ~20% cross-tenant market dedup)
   ≈ B − 0.20 · (weekly market/size portion)
   ≈ B − 186     (negligible at current scale, meaningful at 20+ clients)

D. Monthly cost
   = B · price_per_call

E. Per-listing cost  (portfolio-wide)
   = D ÷ Σ L
```

---

*Prepared for Mark @ Roomy Revenue. Numbers scale linearly with listing counts — replace §2's listing figures with actuals to recompute exactly. The code path referenced: `src/lib/pricing/market-recommendations.ts`, `src/lib/airroi/client.ts`, `src/lib/external-api-cache.ts`, `src/lib/reports/service.ts::buildPricingCalendarReport`, and the report cache in `app/api/reports/pricing-calendar/route.ts`.*
