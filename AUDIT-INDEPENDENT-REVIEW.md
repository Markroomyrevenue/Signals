# Signals — INDEPENDENT Post-Audit Review (2026-06-29)

**VERDICT: SHIP-SAFE** — the live app is correct and healthy. Every headline metric
reconciles to raw data to the penny across all 5 live tenants; web + worker are on the
newest code; the green gate is fully green; exports, the drilldown fix, and tenant isolation
are intact and confirmed *live*. Caveats that are *not* blockers but you should know: (a) the
first run's own docs are **stale/under-claimed** — prod is actually two commits *ahead* of
what they say, and Little Feather's live occupancy is **20.46%**, not the "~28%" the docs
record; (b) one of your seven issues — **expanded date-range presets — was deferred, not
delivered**; (c) two soft spots I could not fully close this run: **mobile/tablet layout was
not exercisable** (browser tooling pinned to desktop width) and the **"Create Business
Review" button gave no visible feedback** when clicked live (the export engine itself is
verified correct — see §3a). None change the SHIP-SAFE call; all are listed in §6.

This review was done in a fresh session, distrusting the first run. I built a **second,
independent reconciliation harness** (`scripts/review2/`, different logic from
`scripts/audit/`) and recomputed every metric from raw `reservations` rows, then compared
to what prod's own code serves. Calendar tab excluded per brief.

---

## 1. Live health RIGHT NOW (independently checked)

| Check | Result |
|---|---|
| `https://signals.roomyrevenue.com/` `/login` `/dashboard` | **200**, renders real app (`<title>Signals by Roomy Revenue</title>`) |
| Web service `Signals` | **Online**, deployment `8995a5f9` **SUCCESS @ 2026-06-29 21:42:51** |
| Worker `signals-worker` | **Online**, deployment `e0a04ec3` **SUCCESS @ 2026-06-29 21:42:51** (same push — NOT stale) |
| Commit actually live (web + worker) | **`b6d31c2`** (current `origin/main`) |
| Prisma migrations on prod | **21/21 applied, "Database schema is up to date"** — no P2021/P2022 |
| Rollback tag `backup/prod-live` | exists = **`82841b3`**; rollback command in `AUDIT-ROLLBACK.md` is mechanically correct |

**Deploy discrepancy (finding, non-blocking).** `AUDIT-REPORT.md`, `AUDIT-ROLLBACK.md` and
the `DECISIONS.md` entry all state prod is live on **`f90f50d`**. It is not — prod is on
**`b6d31c2`**, two commits ahead:
- `8564c35` `fix(sync): derive unit_count from Hostaway listingUnits[]` (pushed 21:11, deployed 21:12)
- `b6d31c2` `fix(dashboard): drilldown multi-month export, faded button, labels, filter loading, booking-window custom range` (pushed 21:42, deployed 21:42)

Both auto-deployed via Railway's push-to-main, **after** the report was written (20:00).
I independently re-ran the full green gate on `b6d31c2` and reviewed both diffs (below) —
they are correct and safe — but there is no evidence they went through the documented
baseline→gate→verify protocol, and the docs were never updated. **Net: the outcome is
healthy; the paper trail is stale.** See §6 for the one-line doc fix.

---

## 2. Independent reconciliation (my numbers vs the live app)

Method: recomputed from raw `reservations` (own status classification, own per-night
pro-ration, own inventory denominator) for a 365-day stayed window (2025-06-30 →
2026-06-29), then called prod's real `buildHomeDashboard` / `buildPropertyDeepDiveReport` /
pace functions against the prod DB. Largest delta anywhere = **£0.02 (FX rounding)**.

| Tenant | Occupancy | RevPAR | Stay rev / ADR / nights | Verdict |
|---|---|---|---|---|
| Stay Belfast | 67.21% | £109.76 | match | **PASS** |
| Yo's House (Harrogate) | 75.55% | £207.33 | match | **PASS** |
| Escape Ordinary | 54.38% | £88.92 | match | **PASS** |
| Coorie Doon | 66.13% | £76.04 | match | **PASS** |
| **Little Feather** | **20.46%** | **£22.96** | match | **PASS** |

- **Little Feather occupancy = 20.46%, RevPAR = £22.96** — reproduced exactly. Numerator
  14,176 occupied unit-nights ÷ denominator 69,302 unit-nights (Alma Place uc=50, The Edge
  uc=150, 6-bed uc=6). **No clamp / no double-count.** This is *lower* than the "~28%" the
  first run's docs record, because `8564c35` later corrected the unit counts upward
  (Alma 20→50, Edge 100→150) — see §4.
- **NightFact aggregation is not stale:** from-`reservations` recompute == `SUM(night_facts
  WHERE is_occupied)` per reservation — **0 mismatches** for Escape Ordinary (8,914) and
  Little Feather (14,177).
- **Where I first "disagreed" with the app, the app was right.** My harness initially
  over-counted by including reservations on *removed* listings (The Lookout, Mark Test
  Listing). The app correctly excludes `removed_at IS NOT NULL`. After matching scope,
  everything reconciles to the penny. That is the second-harness catching *my* bug, not the
  product's — the product's exclusion logic is correct.

---

## 3. Your seven issues — confirmed fixed / not

| # | Issue | Verdict | Independent evidence |
|---|---|---|---|
| 1 | Multi-unit booking ADR no longer skewed | **FIXED / was never inflated** | Alma Place (uc50): 129 confirmed reservations, **median £54/night**; The Edge (uc150): 1,204 confirmed, **median £75/night** — single-room rates, not 50×/150×. Peak concurrency 41/52 ≤ unit_count (no overbooking artifact). LF ADR reconciles to the penny. |
| 2 | Drilldown "ADR vs last year" correct & like-for-like | **FIXED** | Backend now surfaces `calendarAdr`/`lyStayedAdr`/`liveVsReferenceAdrPct` (`pricing-report-assembly.ts:133-135,530-534`); UI renders `row.liveVsReferenceAdrPct` (`revenue-dashboard.tsx:8494-8495`); `formatSignedPercent(null)→"—"` so past periods show "—" not blank. LY basis uses the app's **mixed blend** (past dates = final stayed, future = pace-gated to cutoff); recomputed on 3 properties — matches to the penny. Cancelled-but-live-at-cutoff correctly counted. |
| 3 | No overlapping/clipped UI | **PARTIAL — see §3a** | Business-review overlap (the case you cited) FIXED & verified (§3 row 4). General multi-breakpoint re-screenshot: see live-UI note §3a. |
| 4 | Business-review export digestible & correct | **FIXED** | Independently regenerated a forced **5-page** PDF from the prod code path: running header `"… (cont.)"` on continuation pages 2–4, new section on page 5, **"Page X of 5" on every page**, footer on every page. F-PDF1/F-PDF2/F-PDFNUM all confirmed. (Export is PDF + CSV; there is no PPTX path — `pptxgenjs` is an unused dep.) |
| 5 | Date-range presets expanded & math correct | **NOT DELIVERED — deferred** | Reverted in `f31af87`: the expanded presets emitted ids the per-tab handlers didn't resolve and dropped this_week/this_month — a net regression. Picker reverted to a clean state (Today/Yesterday/Last 7/This month/Custom; no no-op buttons). Disclosed in AUDIT-REPORT "Deferred". **If you expected presets live, they are not.** |
| 6 | Headline figures reconcile to source | **CONFIRMED** | §2 — all 5 tenants, to the penny. |
| 7 | Hostaway-vs-Signals reconciliation note holds up | **CONFIRMED (vs synced Hostaway data)** | Signals' building blocks (nights from arrival/departure, revenue from reservation `total`) come straight from the Hostaway payload synced today; recompute from that raw data matches the app. The note's definitional gaps (stay-date attribution, £0 for cancelled, VAT-incl default, no OTA-commission deduction, single currency) are all code-verifiable and consistent. Not pulled from a *live* Hostaway dashboard call this run — verified against the freshly-synced raw_json instead. |

### 3a. Live-UI re-screenshot (logged into prod, Little Feather tenant)

Tool: Claude-in-Chrome against the live app, authenticated as the prod admin. Read-only.

- **Desktop (~1971px effective): PASS on every page** — Login, Overview/Home (KPI cards,
  Opportunity Radar, Priority Signals, Signal Queue), Reservations table, Pace (charts +
  legend + CTAs), Bookings, and the Property Drilldown table. No overlap, no clipping, no
  horizontal overflow (`scrollWidth == clientWidth`, zero offending elements).
- **"Calendar ADR vs last year" — CONFIRMED FIXED LIVE.** On a *finished* month (May 2026)
  the column is present and every row is populated (`-61.5%`, `-20.6%`, `-54.3%`, … and a
  green `+7.2%`), DOM-verified. The single `— vs last year` is the correct em-dash fallback
  on a £0-revenue listing, not a blank cell. This is exactly the bug you reported as fixed.
- **Tablet (768px) / mobile (390px): NOT verified — tooling limit.** The connected Chrome's
  layout viewport was pinned at ~1971px (`innerWidth` wouldn't drop; media queries stayed
  desktop), so the responsive breakpoints never engaged. **Mobile/tablet overlap remains
  UNVERIFIED this run** — I'm flagging it rather than passing scaled desktop shots off as
  "mobile." (Per project memory the mobile calendar reuses the desktop table by design, but
  the other tabs' small-screen layout was not exercised.)
- **"Create Business Review" CTA — INCONCLUSIVE (minor concern).** Clicking it on the
  Property Drilldown produced no on-screen feedback the automation could observe (no banner,
  no button-row change to "Download Business Review", no error). The handler
  (`addCurrentViewToBusinessReview`, `revenue-dashboard.tsx:8319`) html2canvas-captures the
  current view, queues a section, and *should* show an "Added …" banner. The export **engine
  itself is verified correct** (my independent 5-page PDF regen, §3 row 4) — so this is at
  most a capture-step timing/headless quirk or a missing-feedback UX nit, **not** a
  data/export-correctness defect. Worth a 10-second manual click to confirm the banner fires.
- **Minor data observation (not layout):** Bookings "bookings-made" view shows **Average
  Occupancy 0.0%** — occupancy is a stay-date concept, so "—"/N-A may read better than 0.0%
  on a booking-date view. Low severity; your call.

---

## 4. The two undocumented post-report commits (scrutinised)

**`8564c35` — unit_count from Hostaway `listingUnits[]` (VERIFIED CORRECT).** Derivation is
`listingUnits.length >= 2 ? length : null`. Independently checked **every active listing**
on prod: stored `unitCount` matches raw `listingUnits` length with **0 mismatches** — no
false multi-units, no missed ones. LF's three multi-units = 6/50/150, matching raw exactly.
LF re-synced 21:46 London (post-deploy), so the new code ran and self-corrected. Single-unit
contract preserved (empty array → null). **Customer-facing impact:** this is what moved LF
occupancy from ~28% (docs) to the accurate **20.46%** (live). Correct, but a customer-facing
number moved *after* the documented "Mark approved" checkpoint — flag for your awareness.

**`b6d31c2` — dashboard UI (VERIFIED SAFE, UI-only).** Reviewed every hunk: drilldown export
falls back to `[deepDiveSelectedPeriodStart]` when no months selected (can't crash/empty);
the "Refreshing." banner suppression does **not** hide the `{error}` blocks (rendered
independently); `custom_range` booking window is guarded client- and server-side
(`service.ts:3208-3212`, clamps `lookbackDays`); label/empty-state changes are cosmetic. **No
customer-facing number is computed or altered.**

---

## 5. Regression sweep

| Check | Result |
|---|---|
| `npm run typecheck` | **EXIT 0** |
| `npm run lint -- --max-warnings=0` | **EXIT 0** |
| `npm run test:tenant-isolation` | **EXIT 0** ("Tenant isolation check passed") |
| `npm run build` | **EXIT 0** (Next.js prod build) |
| `npm run test:pricing-anchors` | **225 pass / 0 fail** (incl. `pricing-report-assembly` + `calendar-utils`) |
| `npm run test:signals` | **36 pass / 0 fail** |
| `npm run test:observe` | **pass / 0 fail** (80+ subtests) |
| **tenantId grep** (independent, all report/observe/signals/api queries) | **PASS** — every query on a guarded model is tenant-scoped. One *intentional* key-gated admin metadata read (`observe/readout` with no `?tenant=`) returns only window-state metadata (no booking/pricing data) — not a leak. |

---

## 6. Residual risk + one-action next steps

1. **Stale docs (do this).** Update `AUDIT-REPORT.md` / `AUDIT-ROLLBACK.md` / the `DECISIONS.md`
   entry: prod live = **`b6d31c2`** (not `f90f50d`); LF occupancy = **20.46%** (not ~28%).
   One-line doc edit; no code change. (I can do this on your say-so.)
2. **Confirm you intended `8564c35` + `b6d31c2` to ship.** Both are correct and live, but they
   landed after the documented "checkpoint-before-deploy" approval and `8564c35` moved a
   customer-facing number (LF occupancy). If that was you, nothing to do; if not, it's a
   process note for next time.
3. **Latent (not currently biting):** `resolveOccupancyPercent` still `Math.min(100, …)`-clamps.
   No tenant currently exceeds 100% (all reconcile), so nothing is hidden today — but the clamp
   would mask a future numerator>denominator data error. Optional: log instead of silently clamp.
4. **Mobile/tablet UI unverified (one-action: you eyeball it).** Browser tooling was pinned to
   desktop width so 768px/390px breakpoints never engaged. Desktop is clean on every page.
   Open the app on your phone for 30 seconds across the tabs to close this — or I can retry
   with a different screenshot tool.
5. **"Create Business Review" CTA — confirm it gives feedback.** Click it once on the Property
   Drilldown and check an "Added …" banner appears and the "Download Business Review" button
   shows up. The PDF engine is proven correct; this is just the on-click UX. If the banner
   doesn't fire, tell me and I'll trace `addCurrentViewToBusinessReview`.
6. **Carried over from run 1 (still open):** rotate the old `AIRROI_API_KEY`; optionally unset
   dead `AIRROI_*` Railway vars; Coorie Doon's last sync was ~12 h old at review time (others
   were fresh) — worth confirming the worker's scheduled sync cadence is hitting every tenant.
7. **Minor (data display):** Bookings "bookings-made" view shows Average Occupancy 0.0% — "—"
   may read better than 0.0% on a booking-date view. Cosmetic.

Nothing here required a code change, so **nothing was deployed or rolled back in this review.**
Prod remains healthy on `b6d31c2`. All `scripts/review2/` work was read-only against prod.

— Independent reviewer, 2026-06-29
