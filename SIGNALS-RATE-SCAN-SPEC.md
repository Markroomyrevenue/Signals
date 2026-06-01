# Signals Rate Scanner — implementation spec

Status: **not yet built** (confirmed 2026-06-01 — no `src/lib/signals/**`, no
`rate-scan` queue, no migration on any branch/worktree). This spec is the
build instruction for Claude Code. Cowork (planning side) wrote it; Claude
Code (build side) executes it.

## 1. What this is and why

A twice-daily scanner that records how live Hostaway rates move over time, so
Mark's pricing instincts (his manual gap-filling edits + his external pricing
tool's automated moves) become a growing dataset of `{situation → change →
outcome}` examples. The long-term goal is to replicate that behaviour in an
agent and/or teach it to new staff. **Volume of clean examples is the whole
point** — keep that framing when making design choices.

### Locked product decisions (from the 2026-05-14 interview — do NOT re-litigate)

1. **Track three levers:** price, minimum-stay, and open/close (availability).
2. **Attribution rule:** a booking is attributed to a rate change if it lands
   **within 48 hours** of that change, on the **same stay-date**.
3. **Yearly-ADR baseline:** trailing **365-day median** of the listing's booked
   nightly rates. Used as the "% of yearly ADR" context on each change.
4. **No change-source tracking.** Do NOT try to distinguish Mark's manual edits
   from his automated Hostaway/pricing-tool moves. "Just need to know what lands,
   not who made the change." This is deliberate — do not add a source column.

### Scope confirmed 2026-06-01

- Cadence: **twice daily, 07:00 + 12:00 Europe/London** (matches the original plan).
- Coverage: **all live tenants** (every tenant with an active Hostaway connection).
- **READ-ONLY / fully isolated (hard requirement, Mark 2026-06-01):** this
  feature must not change the behaviour of any existing part of the tool. It
  reads from Hostaway and from existing tables, and writes **only** to its own
  four new `signals` tables. See §2.1 for the exact isolation rules — these
  override anything else in this spec if they conflict.
- Monthly update delivery: **a Cowork scheduled task posts the summary in chat**
  mid-month on a Wednesday. The app does NOT email it — the app's only job here
  is to log data and expose one read-only summary endpoint (see §4 + §6).
- **Exclude all rate-copy listings (Mark 2026-06-01):** do NOT scan or record
  changes for any listing involved in rate-copy — **both** the target listings
  (those with `pricingMode: "rate_copy"`) **and** the source listings they copy
  from (`rateCopySourceListingId`). Their price moves are driven by Signals' own
  push / an external tool, not by Mark's pricing instinct, so tracking them is
  noise. They must remain completely untouched. See §4 step 2.

## 2. Codebase context (read these first)

The **rate-copy push worker is the template** — copy its structure closely:

- `src/workers/rate-copy-push-worker.ts` — per-tenant job processing,
  `ensureSchedulesForActiveTenants()`, `startWorker()`, SIGTERM handling.
- `src/lib/queue/queues.ts` — queue construction + idempotent `schedule*`
  helpers using `repeat: { pattern, tz: "Europe/London" }` and stable `jobId`.
- `src/workers/run-all-workers.ts` — single process that boots every worker;
  this is what `npm run worker` (→ `worker.sh`) runs in production.
- `src/lib/sync/engine.ts` → `runCalendarSyncForListing(...)` exists but **must
  NOT be used here** — it overwrites the shared `CalendarRate` table, which
  rate-copy and the reports read. That is a side effect on another part of the
  tool, which the read-only requirement forbids.
- **Use the read-only fetch instead:** `getHostawayGatewayForTenant(tenantId)`
  then `gateway.fetchCalendarRates(listing.hostawayId, dateFrom, dateTo)` (see
  `src/lib/hostaway/client.ts` and `types.ts`). This is a pure HTTP GET against
  `/v1/listings/{id}/calendar` that returns `{ date, rate/price, minStay,
  available, ... }[]` and writes nothing to the DB. It has demo/sample
  implementations too, so it works in every DATA_MODE. The scanner diffs this
  in-memory against its own `RateState` table — `CalendarRate` is never read or
  written by the scanner.
- `CalendarRate` model (`prisma/schema.prisma`) is referenced only as a shape
  example — the scanner does not touch it.
- `NightFact` model: `isOccupied`, `revenueAllocated`, `date`,
  `bookingCreatedAt`, `leadTimeDays` — source for the trailing-365d ADR median.
- `Reservation` model: `createdAt` (booking landed timestamp), `arrival`,
  `departure`, `status`, `cancelledAt` — source for 48h attribution.

**Multi-tenant rule (hard constraint, see `CLAUDE.md`):** every Prisma query
touching the new tables MUST filter by `tenantId`, and every new model's
indices must be `@@index([tenantId, ...])`.

**Stale note to ignore:** older docs/memory mention `npm run worker:all` and
`SIGNALS-RATE-SCAN-SETUP.md`. Neither is current. Activation today is just
adding the new worker import to `run-all-workers.ts` + a worker restart.

### 2.1 Read-only / isolation rules (these win over everything else)

The scanner must be invisible to the rest of the tool. Concretely:

1. **Writes only to the four new tables** (`rate_scans`, `rate_states`,
   `rate_changes`, `booking_rate_contexts`). No INSERT/UPDATE/DELETE/upsert on
   any existing table — especially not `CalendarRate`, `Reservation`,
   `NightFact`, `PricingSetting`, `PaceSnapshot`, `DailyAgg`.
2. **Hostaway calls are GET-only.** Use `fetchCalendarRates` (read). Never call
   any push/PUT path (`src/lib/hostaway/push*.ts`) — those change live rates.
3. **No shared mutable state, no shared schedules.** New `rate-scan` queue only;
   do not add jobs to `hostaway-sync` or `rate-copy-push`. Adding the worker to
   `run-all-workers.ts` is the only edit to existing runtime wiring, and it must
   be purely additive (a new import + start call) — do not change how the
   existing workers boot.
4. **No new env defaults that alter existing behaviour.** New env vars are fine
   (e.g. the summary-endpoint key) but must default to off/no-op and must not
   be read by any existing code path.
5. **The summary API route is read-only** — it runs SELECTs against the signals
   tables only and never writes.
6. If any instruction elsewhere in this spec appears to require touching another
   part of the tool, STOP and flag it rather than proceeding.

## 3. Data model (new migration)

Add four models to `prisma/schema.prisma`, add their back-relations to `Tenant`
and `Listing`, and create a migration named `<timestamp>_add_signals_rate_scan`.

### `RateScan` — one row per scan run, per tenant

| field        | type      | notes                                            |
| ------------ | --------- | ------------------------------------------------ |
| id           | String id | cuid                                             |
| tenantId     | String    | `@map("tenant_id")`                              |
| scannedAt    | DateTime  | `@default(now())`                                |
| trigger      | String    | `"scheduled"` \| `"manual"`                      |
| status       | String    | `"success"` \| `"partial"` \| `"failed"`         |
| listingCount | Int       | listings scanned                                 |
| changeCount  | Int       | total RateChange rows emitted this scan          |
| failedCount  | Int       | listings whose sync/diff failed                  |
| error        | String?   | first error message if any                       |

Indices: `@@index([tenantId, scannedAt])`. Map `@@map("rate_scans")`.

### `RateState` — last-known value per listing/date (the diff baseline)

| field      | type    | notes                                  |
| ---------- | ------- | -------------------------------------- |
| tenantId   | String  | `@map("tenant_id")`                    |
| listingId  | String  | `@map("listing_id")`                   |
| date       | DateTime| `@db.Date` — the stay date            |
| rate       | Decimal | `@db.Decimal(18, 6)`                   |
| minStay    | Int?    | `@map("min_stay")`                     |
| available  | Boolean |                                        |
| currency   | String  | `@db.VarChar(3)`                       |
| lastScanId | String  | `@map("last_scan_id")` — FK to RateScan|
| updatedAt  | DateTime| `@updatedAt`                           |

PK `@@id([tenantId, listingId, date])`. Index `@@index([tenantId, listingId, date])`.
Map `@@map("rate_states")`.

### `RateChange` — one row per detected lever move

| field          | type     | notes                                                       |
| -------------- | -------- | ----------------------------------------------------------- |
| id             | String id| cuid                                                        |
| tenantId       | String   | `@map("tenant_id")`                                         |
| listingId      | String   | `@map("listing_id")`                                        |
| date           | DateTime | `@db.Date` — stay date the change applies to               |
| scanId         | String   | `@map("scan_id")` FK → RateScan                             |
| lever          | String   | `"price"` \| `"min_stay"` \| `"availability"`              |
| oldValue       | Decimal? | `@db.Decimal(18, 6)` (null on first observed change)        |
| newValue       | Decimal? | `@db.Decimal(18, 6)`                                        |
| changePct      | Decimal? | `@db.Decimal(10, 4)` — price moves only, `(new-old)/old`   |
| yearlyAdrMedian| Decimal? | `@db.Decimal(18, 6)` — trailing-365d median booked nightly  |
| pctOfYearlyAdr | Decimal? | `@db.Decimal(10, 4)` — `newValue / yearlyAdrMedian` (price) |
| detectedAt     | DateTime | `@default(now())`                                           |

Indices: `@@index([tenantId, listingId, date])`, `@@index([tenantId, detectedAt])`,
`@@index([tenantId, lever])`. Map `@@map("rate_changes")`.

### `BookingRateContext` — booking ↔ change attribution (48h, same stay-date)

| field           | type     | notes                                                  |
| --------------- | -------- | ------------------------------------------------------ |
| id              | String id| cuid                                                   |
| tenantId        | String   | `@map("tenant_id")`                                    |
| listingId       | String   | `@map("listing_id")`                                   |
| reservationId   | String   | `@map("reservation_id")` FK → Reservation              |
| stayDate        | DateTime | `@db.Date` — the booked night that matched a change   |
| rateChangeId    | String?  | `@map("rate_change_id")` FK → RateChange (nullable)    |
| bookingCreatedAt| DateTime | `@map("booking_created_at")` — reservation.createdAt   |
| hoursSinceChange| Decimal? | `@db.Decimal(10, 4)` — hours between change & booking  |
| leverChanged    | String?  | which lever moved just before the booking landed       |
| createdAt       | DateTime | `@default(now())`                                      |

Unique `@@unique([tenantId, reservationId, stayDate, rateChangeId])` (idempotent
re-runs). Indices: `@@index([tenantId, listingId, stayDate])`,
`@@index([tenantId, bookingCreatedAt])`. Map `@@map("booking_rate_contexts")`.

Add `rateScans RateScan[]`, `rateChanges RateChange[]`, `rateStates RateState[]`,
`bookingRateContexts BookingRateContext[]` to `Tenant` (and the listing-scoped
ones to `Listing`), all with `onDelete: Cascade` like the existing relations.

## 4. New code modules

### `src/lib/signals/config.ts` (tunable knobs — single source of truth)

```ts
export const SCAN_HORIZON_DAYS = 365;            // days forward to scan
export const ATTRIBUTION_WINDOW_HOURS = 48;      // booking-to-change window
export const YEARLY_ADR_TRAILING_DAYS = 365;     // baseline lookback
// Ignore sub-epsilon price noise so we don't log float dust as "moves".
export const PRICE_CHANGE_EPSILON = 0.01;        // currency units
export const LEVERS = ["price", "min_stay", "availability"] as const;
```

### `src/lib/signals/baseline.ts`

`computeYearlyAdrMedian(tenantId, listingId): Promise<number | null>` —
median of `NightFact.revenueAllocated` where `isOccupied = true` and
`date >= today - YEARLY_ADR_TRAILING_DAYS`, filtered by `tenantId`+`listingId`.
Return null if fewer than ~5 booked nights (not enough signal). Compute the
median in JS after a `findMany` selecting only `revenueAllocated`.

### `src/lib/signals/scan-service.ts` (the core)

`scanTenant({ tenantId, trigger }): Promise<RateScanResult>`:

1. Create a `RateScan` row (`status: "success"` provisional).
2. Load active listings: `prisma.listing.findMany({ where: { tenantId, status: "active" } })`
   (match however the codebase marks live listings — check `Listing.status` values).
   **Then exclude all rate-copy listings.** Build an exclusion set and filter the
   list before scanning:
   - Read property-scope PricingSettings: `prisma.pricingSetting.findMany({ where: { tenantId, scope: "property", scopeRef: { not: null } } })`.
   - Parse each with `parsePricingSettingsOverride` (from `@/lib/pricing/settings`).
   - For every row where `parsed.pricingMode === "rate_copy"`: add the row's
     `scopeRef` (the **target** listing id) to the exclusion set, AND if
     `parsed.rateCopySourceListingId` is a non-empty string, add that (the
     **source** listing id) too.
   - Drop any listing whose id is in the exclusion set. The excluded listings are
     never fetched, diffed, or written — they remain entirely as they are.
   - (Mirror the parse logic in `collectRateCopySourceListingIds` in
     `rate-copy-push-worker.ts`, but collect targets + sources for exclusion.)
   - Log how many listings were excluded so the behaviour is auditable.
3. `dateFrom = today`, `dateTo = today + SCAN_HORIZON_DAYS` (use the existing
   `toDateOnly` / `addUtcDays` / `fromDateOnly` helpers from `@/lib/metrics/helpers`).
4. Get the tenant's gateway once: `const gateway = await getHostawayGatewayForTenant(tenantId)`.
5. For each listing (serial, to keep Hostaway load + logs sane):
   a. `const fresh = await gateway.fetchCalendarRates(listing.hostawayId, dateFrom, dateTo)`
      — **read-only GET, no DB write.** Wrap in try/catch; on failure increment
      `failedCount`, log, continue (partial > abort — mirror rate-copy worker).
   b. Normalise `fresh` into `{ date, rate, minStay, available, currency }` per day.
   c. Read existing `RateState` rows for the listing in range into a map keyed by date.
   d. Compute the listing's `yearlyAdrMedian` once (via `baseline.ts`).
   e. For each calendar date:
      - **First time seen** (no RateState row): insert RateState, emit **no**
        RateChange (no prior baseline to compare).
      - **Price move:** `abs(new.rate - prev.rate) > PRICE_CHANGE_EPSILON` →
        RateChange(lever `"price"`, old/new, `changePct`, `yearlyAdrMedian`,
        `pctOfYearlyAdr = new.rate / yearlyAdrMedian`).
      - **Min-stay move:** `new.minStay !== prev.minStay` → RateChange(lever `"min_stay"`).
      - **Availability move:** `new.available !== prev.available` →
        RateChange(lever `"availability"`).
      - After diffing, **upsert RateState** to the new values with `lastScanId`.
   f. Batch the RateChange inserts (`createMany`) and RateState upserts per listing.
6. Update the `RateScan` row with `listingCount`, `changeCount`, `failedCount`,
   and `status` (`"failed"` if every listing failed, `"partial"` if some, else
   `"success"`).
7. Call `attributeRecentBookings({ tenantId, scanId })` (below).

### `src/lib/signals/attribution.ts`

`attributeRecentBookings({ tenantId })`:

1. Find reservations created in the last `ATTRIBUTION_WINDOW_HOURS`:
   `prisma.reservation.findMany({ where: { tenantId, createdAt: { gte: now - 48h } } })`.
   (Include cancelled — a cancel that later happens doesn't undo the fact the
   booking landed; consistent with the existing cancelled-booking pace logic.)
2. For each reservation, for each night in `[arrival, departure)`:
   - Find `RateChange` rows for `(tenantId, listingId, stayDate)` with
     `detectedAt` in `[booking.createdAt - 48h, booking.createdAt]`.
   - For the closest such change, upsert a `BookingRateContext` row
     (`hoursSinceChange`, `leverChanged`). The `@@unique` makes this idempotent.
   - If a night had no qualifying change, optionally still record a context row
     with `rateChangeId = null` capturing `rateAtBooking` — **decision for
     Claude Code:** only insert null-change rows if cheap; the primary value is
     the matched rows. Default: only insert matched rows.

### Queue + worker

In `src/lib/queue/queues.ts`:
- `export const RATE_SCAN_QUEUE_NAME = "rate-scan";`
- `rateScanQueue = new Queue(...)` with the same `defaultJobOptions` shape as
  `rateCopyPushQueue` (attempts 2, exponential backoff).
- `scheduleRateScanMorning({ tenantId })` → `repeat: { pattern: "0 7 * * *", tz: "Europe/London" }`, `jobId: rate-scan-morning-${tenantId}`.
- `scheduleRateScanMidday({ tenantId })` → `repeat: { pattern: "0 12 * * *", tz: "Europe/London" }`, `jobId: rate-scan-midday-${tenantId}`.

`src/workers/rate-scan-worker.ts` — mirror `rate-copy-push-worker.ts`:
- Job data `{ tenantId, kind: "scheduled" | "manual" }`.
- `processJob` → `scanTenant({ tenantId, trigger: kind === "manual" ? "manual" : "scheduled" })`.
- `ensureSchedulesForLiveTenants()` — iterate tenants **that have an active
  HostawayConnection** (scanning calls Hostaway, so skip demo/sample-only
  tenants). Register both repeatable jobs per tenant. Idempotent.
- `startWorker()` with concurrency 1, `completed`/`failed` listeners, SIGTERM close.

In `src/workers/run-all-workers.ts`: add
`import { startWorker as startRateScanWorker } from "@/workers/rate-scan-worker";`
and start it with the same `.then/.catch` pattern as the others. (Purely
additive — do not change how the existing workers boot.)

### Read-only monthly-summary endpoint (for the Cowork chat task)

The monthly update is delivered by a **Cowork scheduled task**, not by the app.
The app's only responsibility is to expose one read-only endpoint the task can
fetch.

`src/lib/signals/summary.ts` → `buildMonthlySignalsSummary({ month }): Promise<...>`
runs SELECT-only aggregations over the signals tables for the trailing calendar
month (default: the month that just ended), across all tenants, returning JSON:

- per tenant: tenant name, scans run, total changes, breakdown by lever
  (price / min_stay / availability), median & spread of price `changePct`,
  count of changes that landed a booking within 48h (from `BookingRateContext`),
  and the top few "biggest moves that converted" (largest `changePct` with a
  linked booking) as concrete teachable examples.
- a portfolio roll-up across tenants.

`app/api/signals/monthly-summary/route.ts` (Next.js App Router, GET):
- Auth: require `?key=<token>` to equal `process.env.SIGNALS_SUMMARY_KEY`. If
  the env var is unset or the key mismatches, return 404 (not 401 — don't
  advertise the route). This is the only access control; keep the key long and
  random. **This env var must not be read anywhere else.**
- Accept optional `?month=YYYY-MM`. Returns `buildMonthlySignalsSummary(...)`
  as JSON. **SELECT-only — never writes.**
- This route reads only the four signals tables (+ tenant names). It does not
  call any existing service.

Add `SIGNALS_SUMMARY_KEY` to `.env.example` with a comment that it gates the
read-only summary endpoint and defaults to disabled (route 404s) when unset.

## 5. Tests (follow the existing `node --import tsx --test` style)

Add `src/lib/signals/scan-service.test.ts` (pure diff logic, mock inputs) covering:
- No change → 0 RateChange rows.
- Price move above/below epsilon → emit / no-emit.
- Min-stay change → one `min_stay` row.
- Open→close and close→open → `availability` rows.
- First-seen date → RateState seeded, no RateChange.
- `pctOfYearlyAdr` math when baseline present / null.

Add `src/lib/signals/attribution.test.ts`:
- Booking within 48h on a matching stay-date → context row.
- Booking outside 48h → no row.
- Booking on a stay-date with no change → no matched row.
- Re-run idempotency (unique constraint holds).

Add `src/lib/signals/baseline.test.ts`: median correctness (odd/even counts),
null below the min-nights threshold.

Add a rate-copy exclusion test (pure function): given a set of PricingSettings,
the exclusion set contains both the `rate_copy` target listing ids and their
`rateCopySourceListingId` sources, and a listing in that set is filtered out.
Factor the exclusion-set builder into a small pure helper so it can be unit
tested without a DB.

Add `src/lib/signals/summary.test.ts`: aggregation roll-up correctness on a
fixed fixture; endpoint returns 404 when `SIGNALS_SUMMARY_KEY` unset or key
mismatched.

Wire these files into a new `test:signals` npm script (and/or append to the
existing `test:pricing-anchors` runner list).

## 6. Acceptance checks before calling it done

- `npm run typecheck` and `npm run lint` clean.
- New `test:signals` suite green.
- A manual scan for one live tenant inserts a `RateScan` row, seeds
  `RateState`, and (on a second scan after a deliberate Hostaway price tweak)
  emits a `RateChange` with correct `changePct` and `pctOfYearlyAdr`.
- Tenant isolation: run `npm run test:tenant-isolation` — must still pass; add
  the four new tables to that audit if it enumerates tables.
- No query on the new tables omits `tenantId`.
- **Isolation proof:** confirm the diff touches no existing service/table write
  paths. `git diff --stat` should show only: `prisma/schema.prisma` (+migration),
  new files under `src/lib/signals/**`, new `src/workers/rate-scan-worker.ts`,
  additive blocks in `src/lib/queue/queues.ts` and `src/workers/run-all-workers.ts`,
  the new `app/api/signals/monthly-summary/route.ts`, `package.json` (test
  script), `.env.example`. No edits to existing pricing/sync/report/push logic.
- Summary endpoint returns 404 with no/incorrect key; returns JSON with the key.

## 7. Out of scope (do NOT build now)

- Any dashboard/UI surfacing (that's Phase 2 — the "Signal Lab" tab in
  `app/components/revenue-dashboard.tsx`).
- Hostaway public API / webhooks (separate milestone; `CLAUDE.md` says don't
  pre-build for it — this scanner uses read-only calendar GETs, nothing new).
- Change-source attribution (deliberately excluded — see locked decisions).
- AirROI or any external market provider.
- In-app email reporting — the monthly update is a Cowork chat task, not email.
