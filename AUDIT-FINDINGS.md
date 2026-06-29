# AUDIT-FINDINGS — consolidated triage (2026-06-29)

Branch `audit/full-metric-ui-2026-06-29`. Independent metric & UI trust audit
(Calendar excluded from metric/UI scope). All numbers are from the 5 live prod
tenants this session, recomputed independently. Per-discipline detail:
[A1 data](AUDIT-A1-data-correctness.md) · [A2 multi-unit](AUDIT-A2-multiunit.md) ·
[A3 YoY/pace](AUDIT-A3-yoy-pace.md) · [UI](AUDIT-UI.md) · [dead-wood](AUDIT-DEADWOOD.md) ·
A7 Hostaway-reconcile (pending).

Status legend: ☐ not started · ◑ decision needed · ✔ fixed · ⏸ deferred.

---

## A. BUGS — clear-cut (fixable without a product decision)

| # | Sev | Finding | Real-world impact | Root cause (file:line) | Fix | Risk | Status |
|---|-----|---------|-------------------|------------------------|-----|------|--------|
| F-RESV | **P1** | Overview **"Reservations"** headline counts reservation-*days*, not reservations, on multi-day windows (Arrivals & Stayed). Tell: displayed reservations == displayed nights every time. | Escape "Stayed this month" shows **909 vs true 322**; LF 1132 vs 302. Only when the home metric selector = Reservations. Revenue/nights are correct. | `groupStayHeadlineDaily` does `COUNT(DISTINCT reservation_id)` *per day* (`service.ts:1770`), then `bookingWindowTotals` **sums** across days (`service.ts:3365`). | Count distinct reservations across the whole window, not per-day-then-summed. | Low–med (revenue/nights untouched). | ☐ |
| F-CALADR | **P1** | Drilldown **"Calendar ADR vs last year"** column shows wrong basis and is **blank on all past periods** — the bug you reported. | Column unreliable/empty; the *main* "ADR vs last year" column is correct. | UI renders `liveRate − reference.adr` (`revenue-dashboard.tsx:8382-8384,8416-8417`); backend computes the intended `calendarAdr`/`lyStayedAdr` (`pricing-report-assembly.ts:455-528`) but never returns them. | Surface `calendarAdr`/`lyStayedAdr` on `PropertyDeepDiveRow`; render `liveVsReferenceAdrPct`, show "—" when null. | Low (display + additive field). | ☐ |
| F-PDF1 | **P1** | Business-review PDF: multi-page tables lose **title/client/period/filters** after page 1 (pages 4–5 are bare tables). Maps to your "overlap when creating a business review." | A reader can't tell which client/report/period a continuation page is. | `business-review.ts:130-232`; `didDrawPage` (`:208-214`) only draws footer; section header drawn once before autoTable paginates. | Draw a running header on every page via autoTable `didDrawPage` + reserve `margin.top`. | Low (additive draw). | ☐ |
| F-PDF2 | **P1** | Business-review manual pagination branch is **dead code** (`business-review.ts:219`) → page breaks fully unmanaged (root of F-PDF1). | — | `tableIndex < tables.length-1` never true (every tab returns 1 table). | Delete dead branch; own pagination via autoTable hooks. | Low. | ☐ |
| F-TZ | **P2** | "Today" and all date presets computed in **UTC, not Europe/London**. During BST early hours, Today/Yesterday/last-N windows lag a day for UK users. | Seasonal 1-hour/day edge on every dashboard window + the date picker. | `buildHomeDashboard` `:3402`, `buildBookWindowReport` `:3114`, `date-range-picker.tsx` use `toDateOnly(new Date())` (UTC). | Anchor "today" on `Europe/London` via `Intl.DateTimeFormat('en-CA',{timeZone})` (pattern already used in pricing agents). | Low. | ☐ |
| F-PDFNUM | P2 | Business-review deck has **no page numbers**. | Basic gap in a client deck. | `business-review.ts:42-84` footer omits page X/Y. | Add `doc.internal.getNumberOfPages()` to footer. | Low. | ☐ |
| F-TESTLST | P2 | **Test listings** ("Mark Test Listing", "Alma 6 bed test") leak into client-facing exports. | Unprofessional in client deck. | export listing set not filtered for test names/flags. | Exclude test listings from client exports. | Low. | ☐ |
| F-VAT | P3 | Stay/Arrivals headline never subtracts VAT even when `includeVat=false` (`vatAllocated` missing from SQL). | Only diverges if a user turns VAT off on overview. | `service.ts:1772-1791` SELECT lacks `vatAllocated`; read at `:1821`/`:3367` as undefined→0. | Add pro-rata `vatAllocated` to the stay-headline SELECT. | Low. | ✔ 318dd4a |
| F-ISOAUDIT | P3 | Static isolation audit flags 3 key-gated routes (observe/readout, observe/suggestions, signals/monthly-summary) for "no getAuthContext". | **Not a leak** — they are intentionally `?key=`-gated, fail-closed (404), tenant-scoped. Verified. | audit tool doesn't recognise the key-gate pattern. | Whitelist them in `audit-tenant-isolation.ts` PUBLIC_ROUTES + register `observationWindow` model. | None. | ☐ |

---

## B. DECISIONS NEEDED — correct fix depends on your product call (◑)

| # | Sev | Finding | The decision | Recommendation |
|---|-----|---------|--------------|----------------|
| D-MUOCC | **P1** | **Multi-unit occupancy% & RevPAR overstated ~3.3×** for Little Feather. Inventory denominator never scales by `unit_count`; numerator counts concurrent unit-nights; then floored+clamped to 100% which *hides* it. (`service.ts:2811-2814,1281-1282,1535,733-739`) | Fixing it drops LF headline **occupancy 75%→~22%** and **RevPAR £84→~£25**. The current number is genuinely wrong (inconsistent numerator/denominator), but the corrected one is a big visible drop the client sees. Fix now, or hold for a client-comms plan? | **Fix it** — the current figure is misleading. Only LF is affected (other tenants have no multi-unit). Worth a heads-up to the client about the methodology correction. |
| D-LIFECYCLE | P2 | Default (no `activeBeforeDate`) occupancy is **not lifecycle-gated**: a newly-onboarded listing contributes a full 365 listing-days, deflating occupancy/RevPAR. (`service.ts:2249-2261,2870-2873`) | Gating raises occupancy for single-unit tenants (Yo's **54%→75%**, Coorie 50%→66%). Which definition do you want as the default headline: "occupancy of the live portfolio" (gated) or "occupancy incl. ramp-up" (current)? | Lean **gate to first-booked-night** (matches how a revenue manager reads occupancy), but it's your definition to set. |
| D-SIGLAB | P1 | **signal_lab** (registry engine) shows impossible occupancy (LF **409%**) and revenue/ADR 1.6–20% off the main tabs for the same metric names. It is already **orphaned from nav**. | Retire/hide signal_lab, or re-point its formulas at the correct reports SQL? | **Retire/hide it** (low risk; it's already unreachable from nav and the main tabs are the correct engine). |
| D-ALMA | P2 | **Alma Place** (uc=20) had **44 reservations on one night** — `unit_count` looks understated (or genuine overbooking in Hostaway). | Data check (no code): is Alma Place really ~40+ studios? Correct its `unit_count`? | You verify the real room count; I can set it once you confirm. |

---

## C. DEAD-WOOD (Phase 4b — after fixes, conservative)

- **AirROI**: ~30 refs across 11 files, runtime-dead (`market-data-provider.ts` returns null). Remove with care (type-referenced files deleted *with* consumers). Plus prod env vars `AIRROI_*`, `ROOMY_ENABLE_LIVE_MARKET_REFRESH` on both `Signals` + `signals-worker` (dead). **Secret hygiene:** `.env.local` holds a real-looking `AIRROI_API_KEY` — delete + **rotate** (your action). Update CLAUDE.md "AirROI is intentionally disabled" section.
- 6 high-confidence removals: `src/lib/tenants/display-name.ts`, `app/components/client-setup.tsx`, unused deps `pptxgenjs`/`clsx`/`csv-parse`.
- **Keep/ask:** `market-recommendations.ts` (KeyData scaffold — do NOT sweep), `external_api_cache` table (needs migration, may hold prod rows), `ioredis` pin (BullMQ peer).

---

## D. PASS — positively verified correct against real data (the trust list)

| Metric / area | Result |
|---|---|
| **Stay revenue** (all tabs, reports path) | ✅ PASS to the penny, all 5 tenants |
| **ADR (stay)** | ✅ PASS to the penny |
| **Occupied nights** | ✅ PASS to the penny |
| **Booked revenue / bookings / nights** (today/yesterday/week/month) | ✅ PASS all tenants, all windows |
| **Booked-revenue date attribution** (8 raw_json keys vs created_at) | ✅ PASS — 0 differing rows across all tenants |
| **Cancellation rate** (per bucket + overall) | ✅ PASS exact, all tenants |
| **Avg LOS** by lead-time bucket | ✅ PASS exact |
| **Reservation counts** by lead-time bucket | ✅ PASS |
| **YoY / pace ADR-vs-LY** (main column) | ✅ PASS to the penny, 12 past/mixed/future cases |
| **Pace on-books nights & revenue** | ✅ PASS to the penny |
| **Cancelled-but-live-at-cutoff inclusion** (your requirement) | ✅ VERIFIED working (real cancelled booking adds 25 nights to LY ref); `pace.ts` untouched |
| **Reservation-level multi-unit ADR** (your #1 suspicion) | ✅ NOT inflated — each room is its own reservation |
| **Tenant isolation** | ✅ Test passes; key-gated routes verified fail-closed + tenant-scoped; no missing-tenantId query found |

---

## Reusable harness left behind
`scripts/audit/run.sh` (prod read-only runner) + `scripts/audit/reconcile-core.ts` + the
per-agent `a1-*/a2-*/a3-*/ui-*` scripts. Intended to become `npm run audit:reconcile`.
