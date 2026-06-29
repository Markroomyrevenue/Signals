# Audit agent brief — shared context (READ THIS FIRST)

You are one specialist in a multi-agent metric & UI trust audit of **Signals**
(Next.js, multi-tenant STR revenue analytics, Hostaway-sourced). Repo root:
`/Users/markmccracken/Documents/signals`. Today is **2026-06-29**.

## Hard rules
- **READ-ONLY against prod.** Do NOT modify app code. You MAY add scripts under
  `scripts/audit/` (namespace them with your agent id, e.g. `a2-*.ts`) and write
  your findings file. Do not edit other agents' files.
- All prod data access goes through the harness: `bash scripts/audit/run.sh scripts/audit/<your-script>.ts`.
  It points DATABASE_URL at the **prod** Postgres (read-only) and sets the
  decryption key so per-tenant Hostaway creds work. Never write to prod.
- Tenant isolation is sacred: every query filters by tenantId.
- Do NOT refactor `src/lib/sync/pace.ts` cancelled-booking logic (owner-confirmed). Verify only.
- AirROI is dead — do not call it.

## Harness API (`scripts/audit/lib/ctx.ts`)
- `getLiveTenants()` → `[{id,name}]` for the 5 live tenants (excludes empty Demo).
- `getReadonlyGatewayForTenant(tenantId)` → Hostaway gateway with **no-op token
  writeback** (never mutates prod). Has `fetchReservations({page})`, `fetchListings(page)`, `fetchCalendarRates(...)`.
- `pullAllReservations(tenantId, {maxPages})` → all reservations (paginated). CACHE results to scratchpad JSON; don't re-pull.
- `prisma` → app Prisma client (already pointed at prod).
- Report builders live in `@/lib/reports/service.ts`: `buildSalesReport`, `buildPaceReport`,
  `buildBookedReport`, `buildBookWindowReport`, `buildHomeDashboard`,
  `buildReservationsReport`, `buildPropertyDeepDiveReport`. Param shapes in
  `src/lib/reports/schemas.ts`. They are what the UI calls — use them as "displayed value".

## The 5 live tenants
Little Feather Management (51 listings, 14,925 resv — the production tenant; HAS multi-unit),
Escape Ordinary (55, 10,747), Stay Belfast (15, 6,107), Yo's House & Short Stay Harrogate (33, 5,587),
Coorie Doon Stays (46, 4,218). All others empty.

## Confirmed by the lead BEFORE you started (don't re-litigate; build on it)
1. **Stay revenue, ADR (stay), occupied nights = VERIFIED CORRECT** to the penny
   for all 5 tenants over a trailing-365 stay window (report vs independent raw
   over night_facts mirroring the `r.total/los_nights` formula at service.ts:1167-1173).
2. **Inventory / occupancy% / RevPAR**: the report's "available nights" =
   **active-listings × days, lifecycle-gated** (service.ts:1281-1282, 1535), NOT a
   `calendar_rates` count. `calendar_rates` is only ~68% populated, so it is the
   WRONG denominator. Occupancy/RevPAR are therefore NOT presumed buggy. Open
   questions: (a) is inventory correctly ×unit_count for multi-unit listings? (b)
   does "available = every active listing-day" match client expectation vs a
   blocked-night-excluding definition? (definitional, not necessarily a defect).
3. **Multi-unit:** only Little Feather has multi-unit listings, with unit_count
   **6, 20, and 100** (the 100 looks anomalous — investigate). No reservation
   produces more night_fact rows than distinct dates, so there is NO per-reservation
   revenue double-count in the night-level path.
4. **Two metric engines** compute same-named metrics differently:
   `src/lib/metrics/registry.ts` (powers signal_lab via /api/metrics) vs
   `src/lib/reports/service.ts` (powers the main tabs). They don't share formulas.
5. Severity scale: P0 (wrong customer-facing number / isolation breach / crash),
   P1 (wrong number in a less-trafficked place or a clear definitional error),
   P2 (misleading/edge-case), P3 (cosmetic). Every finding needs: evidence
   (numbers), root cause + file:line, proposed fix, risk-of-fix.

## Inventory reference
`AUDIT-INVENTORY.md` (repo root) — full page/tab/control/metric inventory.

## Your deliverable
A single findings markdown file at repo root (name given in your charter). End your
returned message with a ≤12-line summary: counts by severity + your top 3 findings.
