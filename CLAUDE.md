# Signals — Operational notes for Claude

This file captures the load-bearing constraints that are easy to break by
accident. Read it first before touching the sync engine, pricing logic, or
the AirROI integration.

## Sync window environment variables

The reservation backfill window controls how far back and forward the engine
asks Hostaway for reservations when there is no `last_sync_at` to anchor a
delta pull (i.e. first sync, re-add, or `forceFull: true`).

| Env var             | Default | Meaning                                              |
| ------------------- | ------- | ---------------------------------------------------- |
| `SYNC_DAYS_BACK`    | `730`   | Days before today to pull reservations from.         |
| `SYNC_DAYS_FORWARD` | `365`   | Days after today to pull reservations from.          |

Default back window is **730** days (two years): YoY pace comparisons
require the current 365 days plus the 365 days before that, so 730 is the
operational minimum. Defaults moved 800/540 → 365/365 on 2026-04-25, then
365 → 730 on 2026-04-26 once the YoY requirement was reasserted. If a
client needs more than 730 days of history, set the env var on their
service (e.g. `SYNC_DAYS_BACK=1095`) and trigger a re-sync — do not
change the defaults.

The calendar fetch window (`calendarBackDays: 90`, `calendarForwardDays:
365`) is unrelated and not env-overridable.

## AirROI is intentionally disabled

`src/lib/pricing/market-data-provider.ts` currently returns `null`
unconditionally. **Do not** call AirROI for any reason — the Key Data
integration is the planned replacement. Pricing recommendations work
without external market signals, falling back to own-history + cached
comparator data.

The `MARKET_PROVIDER` env var is reserved for future use; for now it is
treated as `"none"` no matter what value is set.

## Hostaway public API + webhooks

The next milestone after this overnight review is to layer Hostaway's
public API + webhook integration on top of the existing pull-based sync.
**Do not pre-build for it.** Anything in `src/lib/hostaway/**` should
remain stable until that work officially starts.

## Cancelled-booking pace logic

`src/lib/sync/pace.ts` and the pace queries in `src/lib/reports/service.ts`
correctly attribute cancelled-then-rebooked nights to the snapshot date the
cancellation occurred on. Owner has confirmed this is working as expected;
**do not refactor it**.

## Multi-tenant isolation

Every Prisma query that touches `Listing`, `Reservation`, `NightFact`,
`PaceSnapshot`, `CalendarRate`, `DailyAgg`, or `SyncRun` MUST include a
`tenantId` filter. Indices in `prisma/schema.prisma` are all
`@@index([tenantId, ...])` for this reason. Any new query that omits the
tenant filter will return cross-tenant data — see the isolation test
`scripts/test-tenant-isolation.ts`.

## Pricing recommendation stability

The base price recommendation lives in `buildRecommendedBaseFromHistoryAndMarket`
at `src/lib/pricing/market-anchor.ts`. The header comment block on that function
describes the formula. Inputs are deterministic on the same data — if two
near-identical apartments produce different recommendations, suspect:
1. Different `pricing_settings` rows (per-listing override).
2. Different `historicalAnchorObservations` (different booking history).
3. Different cached comparable sets (location-derived, can drift).
4. Different `bedroomsNumber`/`personCapacity`/`roomType` on `Listing`.

Minimum price is always `roundToIncrement(base × 0.7)` — see the function
header for the full breakdown.
