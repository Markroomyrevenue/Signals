# Hostaway Analytics MVP

Multi-tenant analytics platform for short-term rentals powered by Hostaway data.

## Stack
- Next.js (App Router) + TypeScript
- PostgreSQL + Prisma
- Tailwind CSS (minimal UI)
- Recharts for charts
- BullMQ + Redis for background jobs

## Why BullMQ + Redis
BullMQ is used instead of a Postgres job table because it gives immediate concurrency controls, retries/backoff, and high-throughput fan-out for per-listing calendar jobs without increasing contention on analytics tables.

## Core Features
- Multi-tenant model (`Tenant`, `User`, `HostawayConnection`) with strict tenant scoping
- Simple email/password auth with cookie sessions
- Hostaway typed client functions:
  - `fetchListings(page?)`
  - `fetchReservations({ updatedSince?, dateRange?, page? })`
  - `fetchCalendarRates(listingId, dateFrom, dateTo)`
- Read-only Hostaway LIVE mode support (`GET` data pulls only + token refresh)
- Unified webhook endpoint to enqueue incremental sync signals
- Incremental sync with idempotent upserts
- Nightly allocation into `night_facts` (arrival inclusive, departure exclusive)
- Daily pace snapshots into `pace_snapshots`
- Daily pre-aggregation path in `daily_aggs`
- Simplified analytics dashboard with 2 tabs only:
  - `PACE` (forward on-the-books)
  - `SALES / STAYED` (past stayed performance)
- Sidebar layout with logo + tab switcher (`Pace Report`, `Sales Report`)
- Filter panel with multi-select checkboxes for listings/channels (`Select All` / `Clear`)
- Bucket table under each chart with current, last-year, and `%Δ` for nights/revenue/ADR
- Revenue mode toggle on both reports: `Include fees` / `Exclude fees`
- Date labels shown as `1 January 26`; bucket labels shown as `W## YY` (week) or month labels
- YoY charting on both tabs:
  - bars: current vs last year (`roomnights` or `revenue`)
  - lines: `ADR current` vs `ADR last year`
- Data mode selection: `sample` (CSV), `demo` (generated), `live` (Hostaway API)

## Currency Conversion Strategy
- Native amounts are stored with native currency.
- Conversion happens at query time with `displayCurrency`.
- Strategy:
  - Stay/rate/pace metrics use stay-date conversion.
  - Booked metrics use booking-date conversion.
- FX fallback:
  - nearest prior FX date for the currency pair
  - inverse pair fallback if direct pair is missing
  - final fallback rate `1` if no FX data exists

## Partitioning + Performance
- `night_facts` partitioned monthly by `date`
- `pace_snapshots` partitioned monthly by `snapshot_date`
- Runtime partition maintenance calls `ensure_monthly_partition(...)` before sync
- Required indexes included for reservation/night_fact/calendar/pace workloads
- Calendar sync uses batched SQL upserts (`INSERT ... ON CONFLICT DO UPDATE`)

## Prerequisites
- Node.js 20-22 LTS (Node 24 can hang with Next.js 15.2.0 in this repo)
- Docker + Docker Compose

## Setup
1. Copy env:
```bash
cp .env.example .env
```
2. Start infra:
```bash
docker compose up -d postgres redis
```
3. Install dependencies:
```bash
npm install
```
4. Run migrations + seed:
```bash
npm run db:deploy
npm run db:seed
```
5. Start app + worker (two terminals):
```bash
npm run dev
npm run worker:sh
```
6. Open:
- App: http://127.0.0.1:3000/login
- Seed login:
  - email: use `SEED_ADMIN_EMAIL` from `.env`
  - password: use `SEED_ADMIN_PASSWORD` from `.env`

`npm run dev` now runs through a Bash wrapper that binds Next.js to `127.0.0.1` and writes output to `dev.log`.
Use `npm run worker:sh` for worker output in `worker.log`.

## Fastest Local Use
Run `npm run start:prod`.
On first run, it builds if `.next/` is missing, then starts a production server at `http://127.0.0.1:3000`.

## Docker (optional app containers)
You can also run `web` and `worker` via compose:
```bash
docker compose up --build
```

## Data Mode Selection
Set `DATA_MODE` in `.env`:
- `sample` → CSV gateway
- `demo` → demo gateway
- `live` → Hostaway API gateway (new)

### Common setup (all modes)
1. Install dependencies:
```bash
npm install
```
2. Start infrastructure:
```bash
docker compose up -d postgres redis
```
3. Apply DB migrations:
```bash
npm run db:deploy
```
4. Regenerate Prisma client:
```bash
npx prisma generate
```
5. Seed:
```bash
npm run db:seed
```
6. Start app + worker:
```bash
npm run dev
npm run worker:sh
```

### Sample mode (`DATA_MODE=sample`)
- Set `SAMPLE_CSV_PATH` to the CSV file path.
- Keep `SAMPLE_CSV_PATH` quoted if the path has spaces.
- Run sync in the app (`Run Sync`).

### Demo mode (`DATA_MODE=demo`)
- No external credentials needed.
- Uses built-in synthetic data for quick demos.

### Live mode (`DATA_MODE=live`)
- Hostaway credentials are stored per tenant in `HostawayConnection`.
- Tenant id comes from `SEED_TENANT_ID` (fallback: `SAMPLE_TENANT_ID`, then `tenant_demo`).
- Requires:
  - `HOSTAWAY_BASE_URL=https://api.hostaway.com`
  - `HOSTAWAY_CLIENT_ID=<client id>`
  - `HOSTAWAY_CLIENT_SECRET=<client secret>`
- For first run, seed from env using:
  - `HOSTAWAY_CLIENT_ID`
  - `HOSTAWAY_CLIENT_SECRET`
- In-app Settings also allows secure tenant-specific updates.
- Forcing a credential change resets stored token so it is re-issued.
- Endpoints used:
  - `GET /v1/listings?includeResources=1`
  - `GET /v1/reservations?includeResources=1`
  - `GET /v1/listings/{listingId}/calendar?includeResources=1`
- Rate limit handling:
  - automatic backoff + retry on `429`
  - per-call spacing to avoid bursts
- Strict read-only Hostaway contract:
  - only `POST /v1/accessTokens` and `GET` endpoints are used

## If localhost Refuses To Connect
- Check `dev.log` for startup/runtime errors.
- Confirm which port is in use: `PORT` environment variable if set, otherwise `3000`.

## Environment Variables
See `.env.example`.

Important values:
- `DATABASE_URL`
- `REDIS_URL`
- `DATA_MODE` (`sample` | `demo` | `live`)
- `HOSTAWAY_BASE_URL`
- `HOSTAWAY_CLIENT_ID`
- `HOSTAWAY_CLIENT_SECRET`
- `HOSTAWAY_ACCOUNT_ID` (optional; used for tenant lookup from webhook payload)
- `WEBHOOK_BASIC_USER` / `WEBHOOK_BASIC_PASS` (optional, per-tenant override also supported)
- `DEFAULT_TIMEZONE`
- `TENANT_DEFAULT_CURRENCY`
- `SEED_TENANT_ID` (optional; defaults to `tenant_demo`)
- `APP_BASE_URL` (public HTTPS host for the app; include the subpath if deployed at `/roomy-signals`)
- `SAMPLE_CSV_PATH` (required when `DATA_MODE=sample`)

## API Endpoints
- `POST /api/reports/pace`
- `POST /api/reports/sales`
- `GET /api/tenants/current`
- `GET /api/listings`
- `GET /api/filters/options`
- `POST /api/sync/run`
- `GET /api/sync/status`
- `POST /api/webhooks/hostaway/reservations`

### `POST /api/reports/pace` and `POST /api/reports/sales`
Both endpoints accept:
```json
{
  "stayDateFrom": "2025-01-01",
  "stayDateTo": "2025-06-30",
  "granularity": "week",
  "listingIds": [],
  "channels": [],
  "includeFees": true,
  "barMetric": "nights",
  "compareMode": "yoy_otb",
  "displayCurrency": "GBP"
}
```

Response shape:
```json
{
  "buckets": ["2025-01-06", "2025-01-13"],
  "current": {
    "nights": [120, 133],
    "revenue": [18342.1, 20210.4],
    "adr": [152.85, 151.96]
  },
  "lastYear": {
    "nights": [101, 118],
    "revenue": [14980.2, 17011.6],
    "adr": [148.32, 144.17]
  },
  "meta": {
    "displayCurrency": "GBP",
    "snapshotDateUsed": null,
    "snapshotDateLyUsed": null
  }
}
```

Notes:
- `includeFees` controls revenue and ADR on both reports:
  - `true` => revenue as imported
  - `false` => `max(0, revenue - cleaning_fee - guest_fee)`
- `compareMode` is only used by `POST /api/reports/pace`:
  - `yoy_otb` (UI label: `Same date last year`) = LY stay window with bookings created on or before `today - 365 days`
  - `ly_stayed` (UI label: `LY Stayed`) = stayed LY window from `night_facts`
- Pace current series is always pulled from `night_facts` for the selected future stay-date window (no snapshot cutoff).
- `snapshotDateUsed` and `snapshotDateLyUsed` are returned as `null` for current simplified pace logic.
- `POST /api/reports/sales` uses `night_facts` stayed data and returns `snapshotDateUsed: null` and `snapshotDateLyUsed: null`.

## Jobs + Sync
- Queue: `hostaway-sync`
- Job types:
  - `tenant-sync`
  - `calendar-sync-listing`
  - `pace-snapshot`

Manual sync trigger:
```bash
curl -X POST http://localhost:3000/api/sync/run
```

## Webhook
`POST /api/webhooks/hostaway/reservations`

Headers:
- Optional `Authorization: Basic <base64(user:pass)>`
- If no webhook credentials are configured, endpoint still works (no auth check).

Body example:
```json
{
  "tenantId": "tenant_demo"
}
```

Notes:
- Hostaway webhook retries are expected.
- Out-of-order events are safe because sync is incremental with overlap.
- Inbound event payloads are treated as signals only; the endpoint enqueues a tenant sync and returns quickly.

## Mark Setup (Live)

1) Put in `.env`:
```bash
cp .env.example .env
```
```bash
DATA_MODE=live
SEED_TENANT_ID=tenant_demo
HOSTAWAY_BASE_URL=https://api.hostaway.com
HOSTAWAY_CLIENT_ID=<your_client_id>
HOSTAWAY_CLIENT_SECRET=<your_client_secret>
APP_BASE_URL=<https://your-public-host-or-ngrok>
WEBHOOK_BASIC_USER=<webhook_user> # optional
WEBHOOK_BASIC_PASS=<webhook_pass> # optional
```

2) One command:
```bash
npm run setup:live
```

3) Start app + worker:
```bash
npm run dev
npm run worker:sh
```

4) Expose webhook URL:
```bash
ngrok http 3000 --host-header=127.0.0.1:3000
```
Set Hostaway webhook URL to:
`https://<ngrok-id>.ngrok.io/api/webhooks/hostaway/reservations`

Use HTTPS (ports 80/443 only). Use Basic Auth creds if set.

## Current Known Gaps
- Login assumes one unique tenant match per email (MVP simplification).
- UI listing selector is not virtualized for extremely large (100k+) listing sets.
- `night_facts` currently stores occupied nights; vacant nights are inferred from `calendar_rates` for occupancy denominator.
- Pace snapshot jobs are still available for other analytics paths, but pace report responses now read directly from `night_facts`.
