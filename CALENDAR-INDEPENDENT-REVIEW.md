# Calendar fixes — INDEPENDENT post-review (2026-06-30)

> **VERDICT: NOT-SAFE** — the *engine* (occupancy math, scope logic, hourly
> push, guardrails, green gate) is correct and verified, but **one of the three
> live listings, "Studio Apartment at The Edge" (515526), has silently fallen
> out of rate-copy management.** It is no longer priced or pushed by Signals;
> its Hostaway rates are frozen at the 07:39 push and no longer react to
> availability. That directly contradicts the first run's report, rollback doc,
> and DECISIONS entry, all of which assert The Edge is live and pushing hourly.
> Nothing is pushing a *bad* rate, so this is recoverable with one action — but
> it must be Mark's call (it changes a live listing), so I did not auto-fix it.

**Reviewer:** Claude Code (independent second session) · **Method:** distrusted
every first-run claim; re-derived against prod DB (read-only via
`DATABASE_PUBLIC_URL`), the worker's own logs, and the live webapp.
**Prod commit (web + worker):** `8dc1ed0` (= local `HEAD` = `origin/main`).

---

## 1. Live health now

| Check | Result |
|---|---|
| Prod root `/` | **200**, renders real app (7.4 KB HTML) |
| Prod `/login` | **200**, renders (12.4 KB) |
| Web service (`Signals`) deploy | `8dc1ed0` **SUCCESS** (= HEAD) |
| Worker service (`signals-worker`) deploy | `8dc1ed0` **SUCCESS** (= HEAD) |
| Hourly schedule registered | ✅ worker log: `registered HOURLY source-sync (:00) + push (:30, delta-only) Europe/London for 6 tenants (pruned 12 stale repeatable(s) first)` |
| Hourly cycle actually firing | ✅ LF `kind=scheduled` cycle observed at 08:31Z |
| Migration applied | **N/A** — this work shipped no schema migration (verified: no Prisma errors, no `P2021/P2022`) |
| `backup/prod-live` tag | ✅ = `2abcb9c` (matches rollback doc) |

Web and worker are healthy and both on the new code. **But** the worker's own
cycle log is the first place the regression shows: the latest Little Feather
scheduled cycle reads `listings=2 datesConsidered=732 datesChanged=379` — it is
pushing **two** listings, not three. The Edge is missing.

---

## 2. Independent occupancy recompute — my numbers vs the code vs Hostaway

I wrote my **own** recompute (booked ÷ (booked + `availableUnitsToSell`),
blocked excluded) straight from `Reservation` + `CalendarRate.rawJson` and
compared it date-by-date to the live engine (`computeMultiUnitOccupancyByDate`)
on prod data, 2026-07-01…14.

**The Edge (515526), per date — my recompute == engine, exactly:**

| date | booked | avail | blocked | static cnt | **my occ%** | **engine occ%** | basis |
|---|---|---|---|---|---|---|---|
| 07-01 | 13 | 18 | 0 | 150 | 41.9 | 41.9 | released |
| 07-03 | 29 | 2 | 0 | 150 | 93.5 | 93.5 | released |
| 07-04 | 31 | 0 | 0 | 150 | 100 | 100 | released |
| 07-08 | 16 | 15 | 0 | 150 | 51.6 | 51.6 | released |

- **Released-stock denominator: PASS.** Denominator = booked + released
  (`availableUnitsToSell`), and the static `countAvailableUnits=150` is correctly
  **ignored** — exactly the "yield on the stock that's actually for sale" intent.
- **Blocked-unit exclusion: PASS.** The Edge `countBlockedUnits=0` on every
  date; the released figure already nets blocked out. Alma's units are
  *all* blocked in July (`blocked=50`/`6`, `avail=0`) → occ correctly reads 0%.
- **Fallback path: PASS.** Every LF date used the `released` basis (the static
  fallback never fired); I confirmed it only fires when `availableUnitsToSell`
  is absent/non-numeric.
- One cosmetic diff on the *last* date of my window (07-14: my 57.1 vs engine
  61.3) is a window-edge artifact in my throwaway harness, not the engine — every
  interior date matched to the decimal.

**Where I disagree with the first run:** I do **not** dispute its occupancy
numbers (they reconcile). I dispute its *headline* — "the three buildings …
recompute and push every hour" and "07-04 £101→£112 verified exactly." The Edge
is no longer pushing, and its two most-recent push attempts (08:26/08:29Z)
ended in **verify-mismatch** (Hostaway stuck at 101 for 07-04), not the clean
success the report quotes.

---

## 3. Mark's asks — each confirmed-done / not, with evidence

| Ask | Verdict | Evidence |
|---|---|---|
| **Group-scope isolation** (Alma ∉ Edge denom & vice-versa) | ✅ DONE | All 3 are `occupancyScope=property` → each prices on its own stock. Edge 07-01 denom = 31 (13+18, Edge-only); pooling would have changed it. No leakage. |
| **Scope independent of grouping** (set Individual/Portfolio without leaving the group) | ✅ DONE | All 3 still carry `group:Student Accomodation` (in-group for filtering) yet price `occupancyScope=property`. Resolver precedence is property→group→portfolio→default, independent of the tag. Live proof the three scopes drive different math on The Edge 07-01: **Individual 41.9%** (13/31) vs **Group 41.9%** (pools all 3; the other two add 0 released today) vs **Portfolio 60%** (48/80 across the tenant). |
| **Availability denominator** (booked ÷ released, blocked out) | ✅ DONE | See §2 — my recompute matches; blocked excluded; static fallback gated. |
| **Hourly push** | ⚠️ PARTIAL | Schedule is hourly (:00 source-sync, :30 push), delta-only, firing — **but only for 2 of the 3 intended listings.** The Edge dropped out (see §5, Finding 1). |
| **Truthful calendar cell** | ✅ (code) / ⚠️ (unseen) | Cell shows booked÷released-denominator + basis (released/mixed/static) + `*` on fallback; code verified. **Not screenshotted on mobile/tablet** — same gap the first run flagged (no local app with prod data). |
| **De-duplicated group filter** | ✅ DONE | The dead "All properties" `<select>` + its `applyCalendarPricingGroup` handler are gone (grep: 0 hits). One working "Filter calendar by group or tag" remains. Note: the underlying `calendarPricingGroupName` state was **not** deleted — it's repurposed (now auto-synced from the working filter, drives the settings group-ref). Not an orphan, but it wasn't removed. |
| **Corrected hourly push label** | ✅ DONE | UI reads *"Pushes hourly (every hour at :30, Europe/London, 365 days) — only the dates that changed."* No stale `5×/day`/`06:30…` text in any `.tsx`. (Stale text survives only in **code comments** — see Finding 5.) |

---

## 4. Reactivity verdict — guardrails held

- **Min floor `max(rate, userMin)`: held on every live rate.** Alma studios all
  ≥ £45 (their explicit `minimumPriceOverride`); Alma 6-bed all ≥ £300. The Edge
  (frozen) 65–122, ≥ its floor. `belowFloor = 0`.
- **Matrix cap: structurally enforced** — the multiplier comes from a bounded
  matrix lookup (authored cells only); observed Edge rates track occupancy
  sensibly (41.9%→100% ⇒ £71→£101).
- Volatility itself is not a defect (full reactivity is intended). **Noted, not a
  defect:** the 08:31 cycle pushed 379 of 732 considered dates (Alma 106, 6-bed
  273) — a large delta in one hour, explained by a fresh source-sync; well within
  the 429-throttled rate limit and the 400/listing per-cycle cap.

No guardrail breach found → on the reactivity axis this is SHIP-SAFE. The
NOT-SAFE verdict is driven entirely by Finding 1.

---

## 5. Findings (severity-ranked) and what I did about each

### 1. HIGH — The Edge (515526) is no longer managed or pushed
- **Evidence:** its property `pricing_settings` row (updated **08:27:13Z**, between
  the two verify-mismatch manual pushes) now resolves to `pricingMode=standard`,
  `rateCopyPushEnabled` absent, `rateCopySourceListingId=null`. The raw JSON is a
  full *standard*-mode object (qualityTier, DoW, seasonality, `hostawayPushEnabled:true`)
  with **no rate-copy fields**. The worker targets property rows where
  `pricingMode===rate_copy && rateCopyPushEnabled===true`, so The Edge is excluded
  — confirmed by the worker log (`listings=2`) and by the absence of an 08:31
  push event for it (last push: 07:39Z).
- **Impact:** The Edge's Hostaway rates are **frozen at the 07:39 push** and will
  not react to availability. `hostawayPushEnabled:true` is **inert** — there is no
  standard-pricing push worker (only rate-copy + manual write to Hostaway), so it
  is *not* pushing wrong rates, just stale ones.
- **Root cause:** it was saved through the **standard calendar-settings panel**,
  which POSTs the whole settings object with no `mergeExisting`, so the API
  *replaced* the row and dropped the rate-copy fields that editor doesn't carry.
- **What I did:** did **not** auto-fix — restoring it re-enables live writes to a
  customer listing, which is Mark's decision. Documented the exact fix below.

### 2. MEDIUM — Latent clobber hazard in the settings save path
`/api/pricing-settings` POST defaults `mergeExisting=false` → full replace. Two
separate editors (standard calendar panel **and** rate-copy settings drawer)
write the **same** property row. A stale-form save from either wipes the other's
fields — that is exactly how The Edge was lost. **Blast radius is currently
narrow** (I round-tripped Alma through GET→normalize→save in memory and its
rate-copy config survives, because `parsePricingSettingsOverride` does preserve
those keys), but The Edge proves it can happen. **Recommend:** send
`mergeExisting:true` from the calendar save, or split rate-copy fields into their
own row. Not fixed (code change — Mark's call).

### 3. MEDIUM — Rollback integrity gap
`CALENDAR-ROLLBACK.md` §3 says the rate-revert runs
`scripts/_revert-pushed-rates.ts`. **That script does not exist** anywhere in the
repo. The snapshot (`CALENDAR-PUSHED-RATES-SNAPSHOT-2026-06-30.json`, 44 KB) is
present, but the documented replay path can't be executed as written. **Recommend:**
add the script or correct the doc before relying on a rate rollback.

### 4. LOW — Stale audit report
`CALENDAR-AUDIT-REPORT.md` says "Prod commit shipped: `4d25490`"; HEAD/prod is
`8dc1ed0` (five later commits — the 3-way scope selector, dead-filter removal,
label fix, dashboard-scope fix). Its "07-04 £101→£112 verified exactly" is
contradicted by the two most-recent Edge pushes (verify-mismatch, Hostaway 101).

### 5. LOW — Stale cadence text in **code comments** (UI is correct)
`src/lib/queue/queues.ts` header (lines 23–37), `src/workers/rate-copy-push-worker.ts:19`,
and `src/workers/run-all-workers.ts:7-8` still describe the old `5×/day` /
`06:30…22:30` schedule as current. UI labels are fixed; these are misleading dev
comments only.

### 6. LOW — `test:rate-copy-schedule` never exits
The schedule test passes its assertions (3/3) but leaves an open BullMQ/Redis
handle, so the process hangs — it left **three zombie processes** from the build
run (08:15/08:18/08:20) still alive ~1.5 h later. Would hang CI. **Recommend:**
`await queue.close()` in test teardown.

### 7. INFO — Dormant group-scope override key mismatch
A `group`-scope `pricing_settings` row exists with `scopeRef="student accom"`, but
the listings' `group:Student Accomodation` tag normalizes to `"student accomodation"`
— so that override row is unreachable by the resolver. Dormant today (all 3 use
property scope); only matters if someone sets `occupancyScope=group` **and**
expects a group-level pricing override to apply.

---

## 6. Live writes — exactly which listings are pushing

| Hostaway id | Listing | Pushing now? | On allowlist? |
|---|---|---|---|
| 514009 | Alma Place Short Stays | ✅ yes (08:31 cycle, 106 dates) | ✅ |
| 554857 | City Centre 6-bed at Alma Place | ✅ yes (08:31 cycle, 273 dates) | ✅ |
| 515526 | Studio Apartment at The Edge | ❌ **no** (dropped 08:27; frozen at 07:39) | ✅ (approved, not writing) |
| 513515 | (removed test listing) | ❌ no | ✅ |

Allowlist (web + worker) = `513515, 514009, 515526, 554857`. **Live writes are a
strict subset of the approved allowlist** — nothing unexpected is being written;
if anything, one *approved* listing (The Edge) is wrongly **not** being written.
All other tenants show `listings=0` (no rate-copy targets).

---

## 7. Pipeline, isolation & green gate (re-verified independently)

- **Price build composes correctly:** source rate → occupancy multiplier (matrix,
  capped) → manual override (fixed bypasses floor; %-delta still floored) → min
  floor `max(rate, userMin)` → round. No double-count; min floor verified on live
  rates.
- **Tenant isolation:** `npm run test:tenant-isolation` **passed**; I re-grepped
  the new occupancy + push queries — every `findMany/findFirst` filters by
  `tenantId`.
- **Green gate (all green):** `typecheck` 0 · `lint --max-warnings=0` 0 ·
  `test:tenant-isolation` pass · `test:rate-copy-schedule` 3/3 ·
  `rate-copy-push-delta` + `multi-unit-occupancy` 17/17 · `test:pricing-anchors`
  236/236 · `build` ✓.
- **429 backoff + verify-after-push:** both present in `hostaway/push.ts` /
  `push-service.ts` (Retry-After parsing, retry on 429; read-back → `verify-mismatch`).
- **No double-fire:** worker prunes all repeatables on boot then re-adds exactly
  two per tenant (log: "pruned 12 stale").

---

## 8. Residual risk + one-action next steps

**Primary (Mark's decision — touches a live listing):**
> **Decide The Edge.** If it should stay managed: open The Edge's rate-copy
> settings, re-select its source listing (almost certainly **"Mark Test Listing
> (Edge)"**, Hostaway `515531` / id `cmoqx89d301sdqs0ohcv9qxvh` — confirm before
> applying), toggle **Push to Hostaway** back on, and save. The next :30 cycle
> resumes pushing. If it was *intentionally* parked, log that — the report and
> rollback doc must be corrected to stop claiming it's live.

**Secondary (safe, low-risk; not done — review deliverable only):**
1. Add `mergeExisting:true` to the calendar-settings save (or split rate-copy
   fields to their own row) so editing scope can never again clobber rate-copy
   config. (Finding 2)
2. Add `scripts/_revert-pushed-rates.ts` (or fix `CALENDAR-ROLLBACK.md`). (Finding 3)
3. Refresh the audit report's commit ref + scrub stale `5×/day` code comments;
   close the schedule-test open handle. (Findings 4–6)

**End state of this review:** prod is healthy and the engine is correct; no bad
rate is live and nothing was rolled back. The single blocker to SHIP-SAFE is
The Edge being unmanaged — recoverable in one action, left for Mark because it
re-enables live writes.
