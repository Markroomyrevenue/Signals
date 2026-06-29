# AUDIT-INVENTORY.md

Code-verified inventory for the Signals metric & UI trust audit. READ-ONLY pass.
Repo root: `/Users/markmccracken/Documents/signals`. Calendar tab is noted but its
metrics/controls are intentionally **excluded** from Sections B/C per the brief.

All `file:line` citations are against the working tree at audit time.

---

## Section A — Pages / tabs

### A.1 Page routes (`app/**/page.tsx`)

| URL path | File | Notes |
| --- | --- | --- |
| `/` | `app/page.tsx:3` | redirect → `/login` |
| `/login` | `app/(auth)/login/page.tsx` | renders `login-form.tsx` |
| `/dashboard` | `app/(dashboard)/dashboard/page.tsx:9` | renders `AnalyticsDashboard` (= `RevenueDashboard`) + `AutoSyncManager`; passes `userRole={auth.role}` |
| `/dashboard/team` | `app/(dashboard)/dashboard/team/page.tsx:11` | admin-only (`auth.role !== "admin"` → redirect, line 17); renders `TeamManager` |
| `/settings` | `app/settings/page.tsx:3` | redirect → `/dashboard/settings` |
| `/dashboard/settings` | `app/dashboard/settings/page.tsx:6` | renders `hostaway-settings.tsx` |
| `/dashboard/trial` | `app/dashboard/trial/page.tsx:50` | lists trial report HTML files from `trial-reports/` (server-side `readdir`) |
| `/dashboard/select-client` | `app/dashboard/select-client/page.tsx:6` | renders `ClientSelector` |
| `/dashboard/select-client/new` | `app/dashboard/select-client/new/page.tsx:6` | renders `ClientCreateForm` |
| `/dashboard/select-client/new/provisioning` | `app/dashboard/select-client/new/provisioning/page.tsx:6` | renders `ClientProvisioningScreen` |
| `/dashboard/select-client/open` | `app/dashboard/select-client/open/page.tsx:15` | renders `ClientOpenSyncScreen` |

Layouts: `app/layout.tsx`, `app/(dashboard)/...` (route group, no own layout file found beyond root).

**Reconciliation vs expected page list:** all expected pages present —
`login`, `dashboard`, `dashboard/team`, `settings`, `dashboard/settings`,
`select-client` (+ `new`/`open`/`new/provisioning`), `dashboard/trial`. ✔ No
missing. **Extra:** `/` redirect stub. Note: expected list said
"select-client provisioning" — actual path is `select-client/new/provisioning`.

### A.2 API routes (`app/api/**/route.ts`)

Methods verified from `export function`/`export async function` declarations.

| Methods | Path |
| --- | --- |
| POST | `/api/admin/reset-and-sync-live` |
| POST | `/api/auth/login` |
| POST | `/api/auth/logout` |
| GET | `/api/filters/options` |
| POST | `/api/hostaway/connection/load-env` |
| GET, POST | `/api/hostaway/connection` |
| POST | `/api/hostaway/push-rates` |
| GET | `/api/hostaway/test` |
| POST | `/api/listings/groups` |
| GET | `/api/listings` |
| PATCH | `/api/listings/unit-count` |
| GET, POST | `/api/metrics` |
| GET | `/api/observe/readout` |
| GET | `/api/observe/suggestions` |
| GET, POST | `/api/pricing-settings` |
| POST | `/api/pricing/comparison/run-now` |
| DELETE | `/api/pricing/overrides/[id]` |
| POST, GET | `/api/pricing/overrides` |
| POST | `/api/pricing/rate-copy/push-now` |
| POST | `/api/pricing/rate-copy/sync-source` |
| POST | `/api/reports/attention-tasks/resolve` |
| POST | `/api/reports/book-window` |
| POST | `/api/reports/booked` |
| POST | `/api/reports/home-dashboard` |
| POST | `/api/reports/pace` |
| POST | `/api/reports/pricing-calendar` |
| POST | `/api/reports/property-deep-dive` |
| POST | `/api/reports/reservations` |
| POST | `/api/reports/sales` |
| GET | `/api/signals/monthly-summary` |
| POST | `/api/sync/run` |
| GET | `/api/sync/status` |
| GET, POST, PATCH, DELETE | `/api/team/users` |
| GET, POST, PATCH, DELETE | `/api/tenants/clients` |
| GET | `/api/tenants/current` |
| POST | `/api/tenants/switch` |
| POST | `/api/webhooks/hostaway/reservations` |

**Route count: 37 API route files.**

### A.3 Dashboard tabs

Tab registry is the `TabId` union at `app/components/revenue-dashboard.tsx:59-69`;
display labels in `tabLabel()` at `:1315-1338`; nav grouping in `navGroups` at
`:5703-5712`. There is **no separate component file per tab** — `revenue-dashboard.tsx`
is a ~9.4k-line monolith that renders all tabs by `switch`/conditional on the
`tab` state (`:1687`). The only extracted sub-components live under
`app/components/revenue-dashboard/` and serve the **Calendar** tab only
(`calendar-grid-panel.tsx`, `calendar-settings-panel.tsx`, `calendar-push-section.tsx`).

| key (`TabId`) | display label | renderer | nav group |
| --- | --- | --- | --- |
| `overview` | "Overview" | `revenue-dashboard.tsx` (home-dashboard render path) | Overview |
| `reservations` | "Reservations" | `revenue-dashboard.tsx` | Overview |
| `property_groups` | "Property Groups" | `revenue-dashboard.tsx` | Overview |
| `pace` | "Pace" | `revenue-dashboard.tsx` | Performance |
| `sales` | "Stayed" | `revenue-dashboard.tsx` | Performance |
| `booked` | "Bookings" | `revenue-dashboard.tsx` | Performance |
| `booking_behaviour` | "Booking Windows" | `revenue-dashboard.tsx` | Performance |
| `property_drilldown` | "Property Drilldown" | `revenue-dashboard.tsx` | Performance |
| `calendar` | "Calendar" | `revenue-dashboard/*.tsx` | Performance (admin only) |
| `signal_lab` | "Signal Lab" | `revenue-dashboard.tsx` (`:8841` branch) | not in `navGroups` (hidden/legacy) |

**Tab count: 10** (`calendar` excluded from metric/control inventory per brief).

**Reconciliation vs expected tab list:**
- Expected: overview, reservations, property_groups, pace, sales, booked, booking_behaviour, property_drilldown, signal_lab → **all present.** ✔
- **Extra:** `calendar` (real tab; admin-gated; out of audit scope).
- **Label mismatches (display ≠ key):** `sales`→"Stayed", `booked`→"Bookings",
  `booking_behaviour`→"Booking Windows". Flag for QA so labels and underlying
  report names are not conflated.
- **`signal_lab` is orphaned from nav:** not listed in `navGroups`
  (`:5703-5712`); a saved-view snapshot with `tab==="signal_lab"` is coerced
  back to `overview` on restore (`:2499`). It still renders if `tab` is set
  (`:8841`) and queries `/api/metrics` (`:3304`). Likely reachable only via
  direct state/URL — confirm it is intended to be live.

---

## Section B — Interactive controls per page/tab (QA click-matrix)

Calendar tab controls are **out of scope** and omitted.

### B.1 Global dashboard chrome (`revenue-dashboard.tsx`, all tabs)

| Control | Handler / line | Triggers |
| --- | --- | --- |
| Tab switch (nav items) | `openDashboardTab()` `:3485`; rendered `:7068` | sets `tab`, fetches that tab's report |
| Calendar nav item (admin) | `:7068` (`item==="calendar"` → "Calendar ↗") | switches to calendar tab |
| Currency selector | `handleCurrencySelectionChange()` `:3671` | sets display currency; re-fetches reports |
| "Refresh / sync now" | `handleRefreshSync()` `:3595` | `POST /api/sync/run` |
| Refresh market data | `handleRefreshMarketData()` `:3616` | market-data refresh (feature-gated) |
| Logout | `handleLogout()` `:3662` | `POST /api/auth/logout` |
| Switch client | `handleSwitchClient()` `:3566` | `POST /api/tenants/switch` |
| Download current report PDF | `handleDownloadCurrentReportPdf()` `:4237` | client PDF render of active view |
| Download current report CSV | `handleDownloadCurrentCsv()` `:4269` | CSV of active view |
| Add current view to PowerPoint | `addCurrentViewToPowerPoint()` `:4996` / `addCurrentViewToBusinessReview()` `:4177` | appends slide to `powerPointSlides` |
| Export PowerPoint (PPTX) | `handleExportPowerPoint()` `:5015` / `handleExportBusinessReview()` `:4199` | builds & downloads PPTX deck |
| PPTX checklist toggle / edit / add | `togglePowerPointChecklistItem()` `:4415`, `updatePowerPointChecklistText()` `:4421`, `addPowerPointChecklistItem()` `:4427` | mutates local checklist (localStorage) |
| Save view (named) | uses `saveViewNameDraft` `:3774`, `tabLabel(tab)` | persists saved view snapshot |
| Granularity (day/week/month) | `setGranularity()` `:1688` | re-buckets series; default `month` |

Endpoints actually called from the dashboard (grep-verified):
`/api/auth/logout`, `/api/filters/options`, `/api/listings/groups`,
`/api/listings/unit-count`, `/api/metrics`, `/api/pricing-settings`,
`/api/pricing/rate-copy/sync-source`, `/api/reports/attention-tasks/resolve`,
`/api/reports/book-window`, `/api/reports/booked`, `/api/reports/home-dashboard`,
`/api/reports/pace`, `/api/reports/pricing-calendar`,
`/api/reports/property-deep-dive`, `/api/reports/reservations`,
`/api/reports/sales`, `/api/sync/run`, `/api/sync/status`,
`/api/tenants/current`, `/api/tenants/switch`.

### B.2 Per-tab controls

| Tab | Controls | Handler / source |
| --- | --- | --- |
| **overview** | Headline window toggles (today / yesterday / this week / this month / custom) across Booked / Arrivals / Stayed; custom date range; home metric selector (`homeMetricOptions` `:5721`, e.g. Revenue); attention-task resolve; property-detective drill-in | `POST /api/reports/home-dashboard`; resolve → `POST /api/reports/attention-tasks/resolve` |
| **reservations** | Range preset (`today` / `yesterday` / `last_7_days` / `this_month` / `custom`, `:83`); date range picker; channel/status/listing filters; row drill-in | `POST /api/reports/reservations` |
| **property_groups** | Group view selector (Whole Portfolio / Group / Individual Property `:2089-2091`); group mutation (assign / remove / delete) `handleGroupMutation()` `:5062`; per-listing assignment | `POST /api/listings/groups` |
| **pace** | Compare-mode toggle (`yoy_otb` "Same date last year" vs `ly_stayed` "Last year finished") `setPaceCompareMode()` `:1690`; date range; granularity; filters | `POST /api/reports/pace` (`compareMode` body) |
| **sales** ("Stayed") | Date range; granularity; channel/status/listing filters; includeFees / includeVat toggles | `POST /api/reports/sales` |
| **booked** ("Bookings") | Booked range preset (`last_day` / `last_7_days` / `last_30_days` / `last_90_days` / `last_year` / `custom`, `:86`, default `last_90_days` `:1695`); filters | `POST /api/reports/booked` |
| **booking_behaviour** ("Booking Windows") | Range mode (`preset` vs `custom_month`, `:75`); lookback days; mode (`booked`/...); lead-time bucket select; LOS bucket select | `POST /api/reports/book-window` |
| **property_drilldown** | Granularity (`DeepDiveGranularity` `:326`); compare-mode (`yoy_otb`/`ly_stayed`, label `deepDiveCompareModeLabel()` `:1257`); sort (`handleDeepDiveSort()` `:2407`); deep-dive export CSV/PDF (`handleDownloadDeepDiveExport()` `:4318`) | `POST /api/reports/property-deep-dive` |
| **signal_lab** | Metric multi-select (`metricIds`); queries metrics registry; chart render | `POST /api/metrics` (`:3304`) |

### B.3 Standalone page controls

| Page / component | Control | Handler | Triggers |
| --- | --- | --- | --- |
| `login-form.tsx` | Submit (email/password) | `onSubmit()` `:44` | `POST /api/auth/login` |
| `auto-sync-manager.tsx` | (auto, admin-gated) background sync | `:71` | `GET /api/sync/status`, `POST /api/sync/run` |
| `hostaway-settings.tsx` | Save connection | `handleSave()` `:86` | `POST /api/hostaway/connection` |
| `hostaway-settings.tsx` | Rename client | `handleRenameClient()` `:128` | `PATCH /api/tenants/clients` |
| `hostaway-settings.tsx` | Switch client | `handleSwitchClient()` `:152` | `POST /api/tenants/switch` |
| `hostaway-settings.tsx` | Delete client | `handleDeleteClient()` `:173` | `DELETE /api/tenants/clients?tenantId=` |
| `client-selector.tsx` | Open client | `handleOpenClient()` `:40` | `POST /api/tenants/switch` |
| `client-selector.tsx` | Delete client | `handleDeleteClient()` `:64` | `DELETE /api/tenants/clients` |
| `client-create-form.tsx` | Create client | `handleCreateClient()` `:60` | `POST /api/tenants/clients` then `POST /api/tenants/switch` |
| `rate-copy-settings.tsx` | Save rate-copy settings | `save()` `:96` | `POST /api/pricing-settings` |
| `rate-copy-settings.tsx` | Push now | `pushNow()` `:128` | `POST /api/pricing/rate-copy/push-now` |
| `team/page` → `team-manager` | CRUD team users | (team-manager) | `GET/POST/PATCH/DELETE /api/team/users` |

### B.4 Role-gated actions

- `userRole` prop, default `"viewer"` (`:1653`); `isAdminRole = userRole === "admin"` (`:1666`).
- **Viewers do not see the Calendar / dynamic-pricing tab** (`navGroups` admin branch `:5703`; comment `:5709`). A viewer hitting `?tab=calendar` is bounced (`:5717`).
- `/dashboard/team` is admin-only at the page level (`team/page.tsx:17`).
- `auto-sync-manager` self-gates because `POST /api/sync/run` requires admin (`:40` comment).

---

## Section C — Every displayed metric + computation site

Two distinct metric engines exist; both must be audited:

1. **Metrics registry** (`src/lib/metrics/registry.ts` + `data-loader.ts`) — powers
   `/api/metrics` and the **signal_lab** tab. 19 metric definitions.
2. **Reports service** (`src/lib/reports/service.ts`) — powers overview / pace /
   sales / booked / booking_behaviour / reservations / property_drilldown. Uses a
   **separate raw-SQL path** with its own revenue/occupancy/ADR formulas — these do
   **not** reuse the registry.

### C.1 Metrics registry (signal_lab / `/api/metrics`)

Source-of-truth notes:
- Stay-domain occupied nights/revenue come from `prisma.nightFact` rows with
  `isOccupied: true`, fields `revenueAllocated`, `currency`
  (`data-loader.ts:156-165`); each matching row = 1 occupied night (`:181`).
- Availability/live-rate from `prisma.calendarRate` where `available=true`,
  field `rate` (`data-loader.ts:218-264`).
- Booking-domain from `prisma.reservation`, fields `createdAt`, `arrival`,
  `nights`, `total`, `accommodationFare`, `status`, `channel`
  (`data-loader.ts:305-342`). Booked revenue uses `total` (`:398`); booking-window
  ADR uses `accommodationFare` (`:481-495`).
- Pace from `prisma.paceSnapshot`, fields `nightsOnBooks`, `revenueOnBooks`
  (`data-loader.ts:588-594`).

| Display name | Computing fn & file:line | Formula (num / den) | Source field | Surfaced |
| --- | --- | --- | --- | --- |
| Occupied Nights | `registry.ts:171-180` | count of `isOccupied` NightFact rows | `NightFact.isOccupied` | signal_lab |
| Available Nights | `registry.ts:189-198` | count of `available` CalendarRate rows | `CalendarRate.available` | signal_lab |
| Occupancy % | `registry.ts:207-211` | occupiedNights ÷ availableNights | NightFact + CalendarRate | signal_lab |
| Stay Revenue | `registry.ts:220-222` | Σ `revenueAllocated` (FX-converted) | `NightFact.revenueAllocated` | signal_lab |
| ADR (Stay) | `registry.ts:231-234` | stayRevenue ÷ occupiedNights | NightFact | signal_lab |
| RevPAR | `registry.ts:244-247` | stayRevenue ÷ availableNights | NightFact + CalendarRate | signal_lab |
| Bookings Created | `registry.ts:257-265` | count of reservations by `createdAt` | `Reservation.createdAt` | signal_lab |
| Booked Revenue (by booking date) | `registry.ts:275-283` | Σ `total` by booking date | `Reservation.total` | signal_lab |
| Booked Revenue by Booking Window | `registry.ts:293-307` → `getBookingWindowBuckets` `data-loader.ts:437` | Σ `accommodationFare` per lead-time bucket | `Reservation.accommodationFare` | signal_lab |
| Booked Nights by Booking Window | `registry.ts:317-331` | Σ `max(1,nights)` per lead-time bucket | `Reservation.nights` | signal_lab |
| Booked Nights by LOS Bucket | `registry.ts:341-355` → `getBookedNightsByLosBucket` `:522` | Σ `max(1,nights)` per LOS bucket | `Reservation.nights` | signal_lab |
| Cancellation Rate | `registry.ts:365-368` | cancellations ÷ bookingsCreated (INACTIVE_STATUSES `:400`) | `Reservation.status` | signal_lab |
| ADR by Booking Window | `registry.ts:378-392` (`:512`) | bucket.revenue ÷ bucket.nights | `Reservation.accommodationFare`/`nights` | signal_lab |
| Average LOS by Booking Window | `registry.ts:402-416` (`:513`) | Σ`nights` ÷ count per bucket | `Reservation.nights` | signal_lab |
| Pace On-Books Nights | `registry.ts:426-446` → `getPaceForSnapshot` `:575` | Σ `nightsOnBooks` for snapshot | `PaceSnapshot.nightsOnBooks` | signal_lab |
| Pickup Between Snapshots | `registry.ts:456-476` → `getPickupBetweenSnapshots` `:642` | end.nightsOnBooks − start.nightsOnBooks | `PaceSnapshot.nightsOnBooks` | signal_lab |
| Live Rate | `registry.ts:486-489` | liveRateSum ÷ liveRateCount | `CalendarRate.rate` | signal_lab |
| Rate Index vs Booked ADR | `registry.ts:499-504` | liveRate ÷ ADR(stay) | CalendarRate.rate / NightFact | signal_lab |
| Channel Mix (Bookings) | `registry.ts:514-531` → `getChannelMixBookings` | bookings grouped by `channel` | `Reservation.channel` | signal_lab |

### C.2 Reports service (overview / pace / sales / booked / windows / reservations / drilldown)

Core shared helpers:
- **Revenue toggles**: `applyRevenueToggles()` `service.ts:714` and `resolveRevenue()`
  `:729` — `revenueIncl` minus `fees` (if !includeFees) minus pro-rata `vat`
  (if !includeVat).
- **Occupancy %**: `resolveOccupancyPercent()` `:733` = `nights / inventoryNights × 100`,
  clamped 0–100. Inventory = `COUNT(*)` of calendar rows or `fallbackInventoryNights`
  (scoped listing count) (`:2783`, `:2873`, `withInventoryDailyFallback`).
- **Delta %** (YoY): `computeDeltaPct()` `:746` = `(current − previous)/previous × 100`,
  null if previous 0.
- **Stay revenue SQL** (the report-path source of truth): `groupNightFactsDaily`
  `service.ts:2559-2601` — per night = `r.total / nf.los_nights` when LOS>0 & total>0,
  else `nf.revenue_allocated`; `nights = COUNT(*)`; fees from `r.cleaning_fee`;
  VAT from `l.vat_rate_pct`. Joins `night_facts → reservations → listings`.
- **Booked SQL**: `groupReservationBookingsDaily` `:2645-2704` — booking date resolved
  from `raw_json` reservationDate/bookedOn/... else `r.created_at`; revenue `SUM(r.total)`;
  nights `SUM(r.nights)`.

| Display name | Computing fn & file:line | Formula | Source field | Surfaced |
| --- | --- | --- | --- | --- |
| Revenue (current) | `buildSalesReport` `:2855` → `groupNightFactsDaily` `:2559` | Σ per-night `r.total/los` or `nf.revenue_allocated`, FX-converted, toggles applied | `NightFact.revenueAllocated`, `Reservation.total` | sales/pace tabs, PDF, PPTX |
| Roomnights / Nights | same SQL `:2563` | `COUNT(*)` NightFact rows | `NightFact` (per-night) | sales/pace/reservations, exports |
| ADR | `alignedCurrentSeries` `:2105` / `:2134` | revenue ÷ nights | derived | sales/pace, exports |
| Occupancy % | `resolveOccupancyPercent` `:733`; series `:2106`/`:2135` | nights ÷ inventoryNights ×100 | `NightFact` / `CalendarRate` count | sales/pace, exports |
| Inventory nights | `groupCalendarInventoryDaily` `:2783` | `COUNT(*)` calendar rows (fallback = listing count) | `CalendarRate` | sales/pace (occupancy denom) |
| Pace on-books nights & revenue | `buildPaceReport` `:2947` via `groupNightFactsDailyByListing` + lifecycle gate `:3001` | current vs reference NightFact daily, gated | `NightFact` (+ booking_created_at cutoff) | **pace** tab |
| Pace YoY — "Same date last year" (`yoy_otb`) | `buildPaceReport` `:2987-2998` | LY NightFacts where `booking_created_at ≤ today−365` (cutoff `:2956`), excl. missing booking date, incl. cancelled-after-cutoff | `NightFact.bookingCreatedAt`, `Reservation.cancelledAt` | pace tab |
| Pace YoY — "Last year finished" (`ly_stayed`) | `buildPaceReport` `:2977-2986` | full LY stayed totals (no booking cutoff) | `NightFact` | pace tab |
| Revenue/ADR/Occupancy deltaPct (YoY) | `computeDeltaPct` `:746`; `buildLikeForLikeBucketComparisons` `:1453`, `buildAdrBucketComparisons` `:1563` | `(cur−ly)/ly×100`; occupancy delta in **points** (`:1510`) | derived | overview focusFinder, drilldown |
| Booked revenue (by booking date) | `buildBookedReport` `:3047` → `groupReservationBookingsDaily` `:2645` | `SUM(r.total)` grouped by resolved booking date | `Reservation.total`, `raw_json`/`created_at` | **booked** tab |
| Booked nights | same `:2698` | `SUM(r.nights)` | `Reservation.nights` | booked tab |
| ADR by booking window / avg LOS / booked nights by window | `buildBookWindowReport` `:3109` | lead-time bucketed; revenue ÷ nights, LOS avg | `Reservation` (lead-time = createdAt→arrival) | **booking_behaviour** tab |
| Reservations summary (reservations / nights / revenue / ADR) | `ReservationsReportResponse.summary` `:255-260` | counts + revenue÷nights | `Reservation.total`/`nights` | **reservations** tab |
| Reservation row ADR & LY-same-weekday ADR delta | rows `:243-247` | per-res ADR; `lastYearSameWeekdayAdr`, `adrDeltaPct` | `Reservation.total`/`nights` | reservations tab |
| Headline Booked/Arrivals/Stayed (today/yesterday/week/month/custom) | `buildHomeDashboard` `:3399`, type `:150-172` | windowed totals per category | `NightFact`/`Reservation` | **overview** tab |
| Focus Finder — underperforming months/weeks, ADR-opportunity, high-demand dates | `HomeDashboardResponse.focusFinder` `:173-213` | current vs LY revenue/ADR/occupancy + deltas | NightFact + LY | overview tab |
| Property Detective signals & suggestions | `propertyDetective` `:214-224`, render `:7910`/`:8009` | severity + daysToImpact + read-only suggestion strings | derived from same-tenant history | overview tab |
| Property deep-dive health (ahead/on_pace/behind), current nights/rev/adr/occ | `PropertyDeepDiveRow` `:270-290`, `resolvePropertyDeepDiveComparisonData` `:2374` | per-listing current vs comparison; compareMode `yoy_otb`/`ly_stayed` (`:2460`) | NightFact per listing | **property_drilldown** tab |

### C.3 Pace snapshot source (`src/lib/sync/pace.ts`)

`PaceSnapshot` rows are written by `writeSnapshotForDate()` `pace.ts:19-71` (raw SQL):
- `nights_on_books = COUNT(*)` of NightFacts on books as of the snapshot date.
- `revenue_on_books`: per-night `r.accommodation_fare / nf.los_nights` for the
  cancelled-rebooked case (`is_occupied=false` & los>0), else `nf.revenue_allocated`
  (`pace.ts:47-53`).
- Inclusion filter: `booking_created_at ≤ snapshot` AND (`is_occupied=true` OR
  cancelled-with `cancelled_at > snapshot`) (`pace.ts:58-67`) — this is the
  cancelled-then-rebooked attribution logic CLAUDE.md says **not** to refactor.
- These feed the registry's `getPaceForSnapshot` (C.1) and indirectly the pace tab.

---

## Open questions / ambiguities

1. **Two divergent metric engines.** The registry (`metrics/registry.ts`,
   signal_lab) and the reports service (`reports/service.ts`, all main tabs) compute
   the *same-named* metrics with **different formulas and source fields**. Examples:
   stay revenue = `NightFact.revenueAllocated` summed in the registry vs
   `r.total / los_nights` in the report SQL; occupancy denominator =
   `CalendarRate available` count (registry) vs calendar-inventory `COUNT(*)` with a
   listing-count fallback (reports). A user comparing signal_lab to the Stayed tab
   could see different numbers for "the same" metric. **Top audit risk.**

2. **`signal_lab` is orphaned from navigation** (`:5703-5712` omit it; saved views
   coerce it to `overview` at `:2499`) yet still renders and queries `/api/metrics`.
   Unclear whether it is a live feature, a hidden/internal lab, or dead UI — and
   whether its (registry-based) numbers are meant to be trusted by end users.

3. **Booked-revenue date source is fuzzy.** `groupReservationBookingsDaily`
   (`:2654-2674`) resolves "booking date" from up to 8 different `raw_json` keys
   before falling back to `created_at`, while the registry's booked metrics key
   strictly off `Reservation.createdAt`. Inconsistent booking-date attribution will
   make the **booked** tab and signal_lab disagree, and makes pace/YoY cutoffs
   (which use `booking_created_at`/`created_at`) sensitive to which date wins.

Secondary flags worth a look: occupancy delta is reported in **points**
(`occupancyDeltaPts`) while revenue/ADR deltas are **percent** — easy to mislabel in
exports; the `pace` `yoy_otb` cutoff is a fixed `today − 365` (`:2956`) regardless of
the selected range, which may not line up with an arbitrary custom stay window.
