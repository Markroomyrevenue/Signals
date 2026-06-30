# DECISIONS.md — shared strategic-decision log

This file is the shared decision log between Mark, the Cowork Claude assistant, and Claude Code.
Both AIs must read it on session start. Append-only.
Implementation details live in BUILD-LOG.md; long-lived constraints live in CLAUDE.md;
this file captures the conversation-level decisions that drive both.

---

## 2026-04-25 — Sync window defaults moved to 365/365

**Decided by:** Mark
**What:** `SYNC_DAYS_BACK` and `SYNC_DAYS_FORWARD` defaults moved from 800/540 → 365/365.
**Why:** Faster baseline syncs; 1y back was thought sufficient at the time.
**Affects:** `CLAUDE.md` (sync window section), `src/lib/sync/**`.
**Status:** superseded by 2026-04-26.

## 2026-04-26 — Sync back-window raised to 730 (YoY pace requirement)

**Decided by:** Mark
**What:** `SYNC_DAYS_BACK` default raised back to 730. Forward stays at 365.
**Why:** YoY pace comparisons need the current 365 days plus the 365 before that. 365 alone left no YoY window. Per-client overrides (e.g. `SYNC_DAYS_BACK=1095`) live on the service, defaults stay at 730.
**Affects:** `CLAUDE.md` (operational minimum); first thing to verify when YoY pace numbers look wrong.
**Status:** active.

## 2026-04-28 — Trial mission and shape

**Decided by:** Mark
**What:** 14-day Belfast-only KeyData trial. Two tenants in scope: Stay Belfast and Little Feather. Trial is read-only-by-default ("compare and report"). Decision target at the end is go/no-go on a paid KeyData subscription.
**Why:** Belfast is where Mark has both an active PriceLabs comparison and a small set of student-accom listings outside PriceLabs that could be candidates for live-push.
**Affects:** `KEYDATA-TRIAL-PROMPT.md` (the contract); every subsequent KeyData decision.
**Status:** active.

## 2026-04-28 — Hostaway push is opt-in per listing, OFF by default

**Decided by:** Mark
**What:** `hostawayPushEnabled` is per-property, defaults OFF for every listing at trial start. Mark turns it ON only for specific Little Feather student-accom listings (which never went on PriceLabs).
**Why:** Trial must not silently overwrite PriceLabs prices. Pushes are deliberate, listing-by-listing decisions.
**Affects:** Settings UI; the per-listing toggle; `HOSTAWAY_PUSH_ALLOWED_HOSTAWAY_IDS` env var as a secondary guard.
**Status:** active. Currently only `hostawayId=513515` ("Mark Test Listing") is on the allowlist for live writes.

## 2026-04-28 — Decision criteria are qualitative, not a weighted scorecard

**Decided by:** joint (Cowork Claude pushed back on the original framing)
**What:** Three signals presented side by side — (1) live output vs PriceLabs, (2) backtest + in-trial bookings vs actual, (3) defensibility audit. Mark forms the call from the evidence. No weighted score, no hard pass bars.
**Why:** A weighted scorecard implies precision the 14-day sample can't carry. Qualitative side-by-side is more honest.
**Affects:** Day-14 summary deliverable; daily report structure.
**Status:** active.

## 2026-04-28 — Pricing model weights and similarity rebalance

**Decided by:** Mark
**What:** Base price blend = `(ownTrailing365dAdr × 0.55) + (KD market P50 × 0.30) + (sizeAnchor × 0.15)`, then × quality tier multiplier (0.95 / 1.00 / 1.10). Similarity weights for the comparable lookup rebalanced: location 0.30 → **0.40**, bedrooms 0.12 → **0.22**, room type 0.18 → 0.12, price positioning 0.15 → 0.05.
**Why:** Mark's explicit framing: "big focus on location AND bedroom count" because those are the strongest drivers of comparability in Belfast STR data.
**Affects:** `computeTrialBase` in `src/lib/pricing/trial-pricing.ts`; `getComparableMarketBenchmark`.
**Status:** active. Weights confirmed unchanged 2026-05-19 after the listingSizeAnchor bug fix.

## 2026-04-28 — Minimum price is data-led only; user can only raise the floor

**Decided by:** Mark
**What:** `recommendedMinimum = max(base × 0.7, KD P20 × similarity)`. `effectiveMinimum = max(recommendedMinimum, userSetMinimumOverride)`. User override can RAISE the floor; never lower it.
**Why:** Pricing should be data-led on the data we have, not opinion-shaped per owner. Owners can set a higher floor through the existing minimum-override input; they don't get to undercut what the data says.
**Affects:** `computeTrialMinimum` in `trial-pricing.ts`; settings UI minimum-price field.
**Status:** active. Exception: manual-override `fixed-price` type may go below the minimum by design (see 2026-04-29).

## 2026-04-28 — Occupancy: portfolio scope by default, unit-count denominator

**Decided by:** Mark
**What:** Default `occupancyScope = 'portfolio'`. The portfolio occupancy denominator is the sum of `unitCount` across every listing in scope (a 3-unit listing contributes 3, not 1). Listings/groups with their own `occupancyScope` are removed from the portfolio denominator. Per-listing opt-out (multiplier = 1.0) and group-scope cascading remain available.
**Why:** "If pricing is correct, occupancy maximises potential." Multi-unit listings need fair contribution to the denominator.
**Affects:** `src/lib/pricing/multi-unit-occupancy.ts`; `lookupOccupancyMultiplier` in `settings.ts`.
**Status:** active. Single-unit and multi-unit currently read different populations — see Cowork Claude finding logged 2026-05-19.

## 2026-04-28 — Lead-time floor gated on THREE conditions

**Decided by:** Mark
**What:** The close-in floor (`base × 0.80` inside 6 days, `base × 0.85` in 7-14 days) engages ONLY when ALL THREE are true: (1) property/scope occupancy in bottom quartile, (2) KD market occupancy in bottom quartile of trailing 90d, (3) KD market rate-per-occupancy at or below 90d median. If any condition fails, the close-in floor reverts to the `§3.2 recommendedMinimum`.
**Why:** Deliberate differentiator from PriceLabs's reflexive close-in dumping. We only drop price when BOTH the property AND the market are unambiguously soft.
**Affects:** `computeLeadTimeFloor` in `trial-pricing.ts`. The gating decision is logged in the daily report so Mark can see why it did or didn't engage.
**Status:** active.

## 2026-04-28 — Quality tier from manual PM tag; default `mid_scale`

**Decided by:** Mark
**What:** Per-listing quality tier (`low_scale | mid_scale | upscale`) is a manual PM tag in the settings UI. Default `mid_scale` if unset. No algorithmic auto-tier in the trial.
**Why:** Revisit post-decision if drift becomes a problem, but for a 14-day trial a manual tag is honest.
**Affects:** `computeTrialBase` quality-multiplier branch.
**Status:** active.

## 2026-04-28 — Mode toggle: conservative / standard / aggressive / manual

**Decided by:** Mark
**What:** Per scope (portfolio / group / property), one editable setting `keyDataTrialMode`. `conservative` compresses the occupancy ladder to ±8% and never goes below `base × 0.90`. `standard` (default) is the full §3.3 model. `aggressive` extends to ±15% and allows `base × 0.75`. `manual` fixes all multipliers at 1.0 and only base, min, and manual seasonality/DoW adjustments apply.
**Why:** Lets a PM or Mark dial confidence per scope without code changes.
**Affects:** `compressLadder` / occupancy bucket logic in `trial-pricing.ts`; settings UI.
**Status:** active. Both trial tenants currently default `standard`.

## 2026-04-28 — KeyData provider hard-fail on non-Belfast `marketKey`

**Decided by:** Mark
**What:** Provider throws if `marketKey !== 'belfast'` AND `KEYDATA_TRIAL_MODE=belfast-only`. Belt and braces — the trial cannot accidentally call against any market not paid for.
**Why:** Single-market trial; cross-market drift would corrupt the comparison data and burn budget.
**Affects:** `assertBelfast` in `keydata-provider.ts`.
**Status:** active.

## 2026-04-28 — KD sample-size guards are non-negotiable

**Decided by:** Mark
**What:** Every KeyData call returns null and falls back to a broader cohort when sample size is below threshold: `<20` for benchmarks at the queried specificity, `<50` for city-level seasonality / DoW indices. Fallback waterfall: same bedroom no amenity → ±1 bedroom → city-level all-bedroom median → null (own-history 0.7 + size 0.3).
**Why:** Belfast niche cuts return statistical noise without these guards.
**Affects:** Every getter in `keydata-provider.ts`.
**Status:** active.

## 2026-04-28 — Defensibility audit = daily LLM agent grading 12 stratified samples

**Decided by:** Mark
**What:** Daily Claude agent grades a stratified sample of 12 listing-dates (3 close-in / 3 short / 3 mid / 3 far, balanced across agree / our_higher / our_lower). Verdicts: `defensible` / `borderline` / `questionable`. Stored in `pricing_defensibility_audits`.
**Why:** Mark can't grade every listing-date every morning. The audit is what lets him skim flagged ones and trust the rest.
**Affects:** `src/lib/agents/defensibility-audit/**`; daily report's defensibility section.
**Status:** active. Gained a fourth verdict `user_intent` on 2026-04-29.

## 2026-04-29 — Peer-fluctuation pricing spec'd for Little Feather student-accom listings

**Decided by:** Mark
**What:** Per-listing manual `basePriceOverride` + `minimumPriceOverride` × `(1 + avgFluctuation)` where avgFluctuation is the mean `(rate - listingAvg365) / listingAvg365` across the rest of the tenant's portfolio. Bounded ±50%. Per-listing push toggle (`peerFluctuationPushEnabled`) defaults OFF.
**Why:** Student-accom listings sit outside PriceLabs and don't have meaningful own-history to anchor on; piggyback on the portfolio's daily fluctuation shape instead.
**Affects:** Would have lived in `src/lib/pricing/peer-fluctuation.ts`.
**Status:** **superseded by 2026-05-06** — rolled back, replaced with rate-copy mode.

## 2026-04-29 — Manual override design (fixed-price ignores min by design)

**Decided by:** Mark
**What:** Two override types per listing × date range. `fixed-price` replaces the rate entirely and **may go below the minimum** (Mark's explicit choice — he accepts the floor risk when typing a fixed number). `percentage-delta` applies multiplicatively to the dynamic recommendation, allowed range -50% to +100%, and the minimum floor STILL APPLIES. Auto-supersede on overlap: any new override that intersects existing ones trims, splits, or soft-deletes them so at most one active override per listing × date.
**Why:** Fixed-price is "I know what I'm doing, push this number"; percentage is an additional dynamic layer.
**Affects:** `PricingManualOverride` table; `src/lib/pricing/manual-override.ts`; calendar cell modal.
**Status:** active.

## 2026-04-29 — `user_intent` defensibility verdict for override cells

**Decided by:** Mark
**What:** When a cell has an active manual override, the defensibility agent returns verdict `user_intent` (a fourth verdict alongside defensible/borderline/questionable) instead of grading the multiplier reasoning. Confidence reflects only whether the override note/range looks sensible.
**Why:** The model didn't choose the price; the user did. Grading the model's multiplier chain on an override cell would mislabel a deliberate human choice as "questionable".
**Affects:** `defensibility-audit/prompt-template.ts`; daily report renders user_intent in its own section.
**Status:** active.

## 2026-05-01 — Resume #1 blocked: documented endpoints all 404'd

**Decided by:** Claude Code (with Mark's approval next morning)
**What:** Tyler enabled Market Data + OTA Data endpoint groups, but every documented path on the documented host returned 404. Resume #1 logged the failure to BUILD-LOG, kept the trial in degraded-fallback mode (every KD call returning null), and asked Mark to chase KeyData.
**Why:** Three weeks of "endpoints exist on paper but don't respond" forced Mark to email Tyler. Logged in BUILD-LOG so the next session knew it wasn't a code bug.
**Affects:** `BUILD-LOG.md` resume entry; `keydata-provider.ts` left in degraded state.
**Status:** superseded by 2026-05-18 (beta host).

## 2026-05-06 — Peer-fluctuation rolled back; replaced with rate-copy mode

**Decided by:** Mark
**What:** Peer-fluctuation never had a row created in the DB before this date. Mark rolled the spec back and replaced it with **rate-copy mode** — listing X simply mirrors listing Y's daily Hostaway rate. Simpler, more legible, no portfolio-shape math. Commit `508f896` introduced rate-copy + bulk-overrides; `1723fa5` added a third mode `hostaway_live` (pure mirror of the listing's own Hostaway rate).
**Why:** Peer-fluctuation's portfolio-shape math was hard to verify under live conditions and Mark wanted something he could explain to a PM in one sentence.
**Affects:** Three live pricing modes today: `standard` (the trial blend), `rate_copy` (follow listing X), `hostaway_live` (mirror own Hostaway rate). The original `peer_fluctuation` mode is dead code.
**Status:** active.

## 2026-05-06 — Resume #2: exhausted on-our-side probe; escalated to Tyler

**Decided by:** Claude Code + Mark
**What:** Probed every documented endpoint × every plausible host × every auth scheme (six × three × six). Every combination 404'd. `/health` on all three live hosts returned 401 identically with or without the trial key. This was the strongest evidence the issue was on KeyData's side, not ours. Escalated to Tyler via email with the full probe table.
**Why:** Without this escalation Tyler would have kept assuming the trial was running and we'd lose another week.
**Affects:** Cleared the way for Tyler to provide the beta host on 2026-05-18. BUILD-LOG resume #2 entry captures the full probe matrix.
**Status:** superseded by 2026-05-18.

## 2026-05-18 — Resume #3: beta host wired (`api-beta.keydatadashboard.com`)

**Decided by:** Tyler @ KeyData (host) + Mark + Claude Code
**What:** Tyler provided a beta host that responds to documented OTA paths. `KEYDATA_API_BASE_URL` set to `https://api-beta.keydatadashboard.com` in both worktree and parent `.env`. Trial measurement window reset to **2026-05-18 → 2026-06-01**.
**Why:** The documented production host was a placeholder returning only "Ok". Beta host validates properly (422 "market_uuid Field required") confirming the path scheme is correct.
**Affects:** `KEYDATA_API_BASE_URL` in all three .env files; `KEYDATA_TRIAL_START` / `KEYDATA_TRIAL_END`.
**Status:** active.

## 2026-05-18 — KeyData scope confirmed OTA-only; PM data is reporting-partners-only

**Decided by:** Tyler @ KeyData
**What:** Our trial key is granted access to the OTA endpoint family only (`/api/v1/ota/*`). The Property Manager Data family (`/api/v1/pm/*`, including the `available_markets` lookup that returns market UUIDs) is contractually restricted to reporting partners — explicitly NOT available to dynamic-pricing tools like Signals.
**Why:** KeyData's PMS-confirmed data is their USP and licensed only for reporting use. OTA data is scraped + inferred from public Airbnb pages.
**Affects:** Auto-discovery via `/api/v1/pm/lookups` will always 401 for us. The Belfast market UUID has to be provided manually by Tyler. KD's listing-level ADR/occupancy is inferred-from-OTA, NOT our booked truth — informs the 2026-05-19 reframe of the calibration table.
**Status:** active.

## 2026-05-18 — Divergence-cause classifier + dynamic Student-Accom runtime filter

**Decided by:** Mark + Claude Code
**What:** For every comparison cell with `|deltaPct| > 5%`, classify why: `demand_disagreement` / `level_disagreement` / `mixed` / `occupancy_driven` (and later `demand_spike_caught` / `demand_spike_missed` added 2026-05-19). Student-Accom exclusion from the comparison agent is a **runtime tag-based filter** (re-evaluated every daily run on the `group:student accom` tag), NOT a persistent toggle on the listing row.
**Why:** Classifier turns a vague "we disagree 73% of the time" into a steerable conversation about which input is off. Runtime filter means listings moved into/out of the group auto-update without a settings change.
**Affects:** `src/lib/agents/pricing-comparison/divergence-cause.ts`; `isStudentAccomListing` in agent.ts.
**Status:** active.

## 2026-05-18 — Email delivery via Resend with fallback sender

**Decided by:** Claude Code (defensible default in absence of domain verification)
**What:** Trial reports go out via Resend. From-address is `TRIAL_REPORT_EMAIL_FROM` (set to `trial-reports@signals.roomyrevenue.com`) BUT falls back to `onboarding@resend.dev` automatically when the configured domain isn't verified yet. To-address is Mark's inbox.
**Why:** Mark hadn't verified the signals.roomyrevenue.com domain on Resend at trial start. Falling back to onboarding@resend.dev means emails still land while domain verification is in flight.
**Affects:** `src/lib/email/daily-report-email.ts`; daily-comparison + Day-14 summary emails ONLY. Peer-fluctuation / rate-copy / overrides send no emails — that's reserved for the KeyData trial.
**Status:** active. Will retire the fallback once the domain is verified.

## 2026-05-19 — Belfast market_uuid set; KeyData data flowing for the first time

**Decided by:** Mark (provided UUID from Tyler) + Claude Code
**What:** `KEYDATA_BELFAST_MARKET_UUID=1793782a-1187-4f9a-b0be-0601e3635b1a` in both .env files. Smoke test on `POST /api/v1/ota/market/listings` returns HTTP 200 with 2,373 Belfast listings and market metadata. Forward-pace, listing-KPI, and trailing-12mo-market endpoints all return real data. Monthly seasonality endpoint (`/kpis/month`) returns empty; we aggregate weekly into monthly instead.
**Why:** Three weeks of waiting; trial finally has real market signal.
**Affects:** `.env` (both copies); auto-discovery path `getBelfastMarketUuid` short-circuits to the env var. Trial measurement window for the day-14 summary effectively starts here.
**Status:** active.

## 2026-05-19 — Trial KPI = pre-occupancy agreement vs PriceLabs (≥90% within ±10%)

**Decided by:** Mark
**What:** The trial's primary success metric is **% of (listing × date) cells where `|ourRate_without_occupancy - plRate| / plRate ≤ 10%`**. Target ≥ 90% within ±10% by Day 14. Measured on our recommendation stripped of the occupancy multiplier — i.e. our PRICE-EXCLUDING-OCCUPANCY-LIFT vs PL. A stretch ±5% band is also tracked. Horizon extended 90 → 270 days.
**Why:** Mark's framing: "be within 5-10% per listing per day for the next 270 days before occupancy adjustment" — i.e. PriceLabs-equivalent at the base level, then our portfolio occupancy multiplier on top.
**Affects:** `ComparisonRunSummary.preOccAgreementWithin{5,10}Pct`; daily report headline KPI banner; the entire tuning loop for the remaining 13 trial days.
**Status:** active. Baseline 2026-05-19 = **20.4% within ±10%** after the listingSizeAnchor fix landed; still 67 percentage points from target. Mid-horizon (31-90d) is the worst band (-20 to -29% mean delta vs PL).

## 2026-05-19 — Trailing-ADR exclusions (owner spec)

**Decided by:** Mark
**What:** `trailing365dAdr = sum(revenueAllocated over trailing 365d) / count(sold nights)` where: ownerstay nights excluded; stays > 10 nights excluded (long-stays price at a depressed rate that drags the average); blocked nights structurally already excluded (no NightFact row exists); cleaning fee structurally excluded (`revenueAllocated = accommodationFare ÷ losNights`, accommodationFare is rent-only). Occupancy denominator = **365 calendar days**, NOT "days with any NightFact row" (the old code used the latter, which was a real bug).
**Why:** Long-stay rates and ownerstay nights aren't representative of typical bookable inventory. Calendar-day denominator is the correct definition of "occupancy".
**Affects:** New shared helper `src/lib/agents/pricing-comparison/trailing-adr.ts`. Both the comparison agent and the listing-calibration check delegate to it.
**Status:** active.

## 2026-05-19 — KeyData OTA data is scraped + inferred (NightFact is gospel)

**Decided by:** Mark
**What:** KeyData has two feeds — PMS-confirmed (their USP, restricted to reporting partners) and OTA-scraped (what we have). Our `NightFact` aggregates come direct from the Hostaway PMS payload — actually billed, actually occupied. **NightFact is the booked truth.** The listing-level comparison table in the daily report (previously labelled "calibration check") was reframed as "KeyData scraped view vs our booked truth (informational only)" — big deltas there point at KD scraping noise (mis-matched listing IDs, calendar-availability inference, channel blindness vs VRBO + direct), NOT at problems with our internal data. The red row-highlighting was removed.
**Why:** The previous framing implied we should be calibrating UP toward KeyData's numbers. That's backwards — they're inferring from public OTA pages, we have the actual books.
**Affects:** `src/lib/agents/pricing-comparison/listing-calibration.ts` (docstring + return shape); the per-tenant calibration section in `report-html.ts`. The 30% KD market P50 weight remains useful at the aggregate level (per-listing scrape noise averages out across 100+ peers).
**Status:** active.

## 2026-05-19 — Pricing model architecture confirmed: keep the 55/30/15 blend

**Decided by:** Mark (after a clarifying Q from Claude Code)
**What:** The trial pricing model continues to anchor 55% on per-listing trailing NightFact ADR (the gospel), 30% on KD market P50 (aggregate scraped signal), 15% on size anchor. The model is NOT switching to a KD-only anchor.
**Why:** NightFact is the booked truth; KD's per-listing data is scraped/inferred. Anchoring on NightFact for the 0.55 weight is correct. KD as an aggregated market signal at 0.30 is fine because per-listing scrape noise averages out across many peers.
**Affects:** `computeTrialBase` weights unchanged. Closes the "should we switch to KD-anchored?" question — answer: no.
**Status:** active.

## 2026-05-19 — Cross-bedroom size anchor + blended demand baseline + KD-always seasonality

**Decided by:** Mark (three independent calls in one session)
**What:** Three changes landed together. **(1)** Fix the silent `listingSizeAnchor: null` bug — `size = ownAdr × (KD P50 thisBand / KD P50 1brBand)`. The null was zeroing the 30% KD market weight entirely; pricing had been on 100% own NightFact since the trial started. **(2)** Demand multiplier now uses `max(LY-same-week lift, trailing-12mo-baseline lift)` — picks whichever signal has more amplitude, clamped to [0.92, 1.15]. **(3)** Seasonality blends own-NightFact monthly index with a KD-derived monthly index (weekly market KPIs aggregated by start-date month, divided by annual median); KD index is now always present (replacing the empty monthly endpoint).
**Why:** Belfast trailing-12mo data is real and clean; using it as a stable baseline catches structural hotness LY can't. Cross-bedroom ratios from KD let the size anchor use real market data, not zero.
**Affects:** `trial-pricing.ts` computeDemandMultiplier signature; new `getTrailingMarketKpis` provider method; `agent.ts` cross-bedroom anchor computation.
**Status:** active. Day-2 measurement: pre-occ ±10% **20.4% → 22.2% (+1.8pp)**, with 0-7d and 8-14d bands essentially at PL.

---

## 2026-05-19 — Today's session (Claude Code, evolving entry)

**Decided by:** Mark + Claude Code
**What:** Three intertwined pieces landed in one session, on top of the trial infrastructure that had been stuck waiting on a market UUID since 2026-04-29.

### Belfast market_uuid set and verified

`KEYDATA_BELFAST_MARKET_UUID=1793782a-1187-4f9a-b0be-0601e3635b1a` (both `.env` files). Smoke test:

- `POST /api/v1/ota/market/listings` → HTTP 200, 2,373 Belfast listings, market metadata `{"name":"Belfast","type":"Vacation Area"}`.
- `POST /api/v1/ota/market/kpis/week` → 53 weeks of real ADR + occupancy data.
- `POST /api/v1/ota/market/kpis/month` → empty (KD doesn't serve monthly for this key). Worked around by aggregating weekly into monthly.

KeyData data is **flowing into the engine for the first time** since the trial began.

### Today's divergence-cause split (post-fixes)

From the most recent comparison run on 2026-05-19 after the listingSizeAnchor fix + demand baseline + KD seasonality + per-band mean delta all landed:

| Cause | Count | % of cells |
|---|---|---|
| in agreement (null) | 1,735 | 11.7% |
| `demand_disagreement` | 9,549 | 64.3% |
| `level_disagreement` | 1,887 | 12.7% |
| `mixed` | 843 | 5.7% |
| `occupancy_driven` | 836 | 5.6% |

`demand_disagreement` dropped from 73% (2026-05-18, no market data) to 64% (today, with KD live). The `occupancy_driven` "good" bucket sits at 5.6% of all cells — real signal that our occupancy ladder is doing meaningful work that PL isn't. **Bigger story is in the per-band mean signed delta:**

| Band | Mean Δ vs PL | n |
|---|---|---|
| 0-7d  | **-0.6%** ← at PL | 440 |
| 8-14d | **+0.8%** ← at PL | 385 |
| 15-30d | -7.2% | 880 |
| 31-60d | **-20.2%** | 1,650 |
| 61-90d | **-29.4%** | 1,650 |
| 91-180d | -3.8% | 4,950 |
| 181-270d | +12.4% | 4,895 |

Near-term (0-14d) is essentially at PL. Far-term (91-270d) is close. The trough is clearly at **31-90 days** where we underprice by 20-29%. That's the next tuning target — likely either the demand-multiplier clamp `[0.92, 1.15]` capping us at +15% when more lift is needed, or the seasonality blend underweighting market signal.

### Status of Cowork Claude's 2026-05-19 findings

1. **Duplicate clamping at `pricing-report-assembly.ts` lines 1196-1217:** **UNCHANGED.** Confirmed real — the three clamps (min, benchmark floor, max) run once pre-`roundToIncrement` (lines 1196-1207) and re-run identically post-round (1209-1216). Not touched today because the trial pricing path in `computeTrialDailyRate` is the one driving the daily report, not this code path. Worth fixing before the production path matters again.
2. **Manual seasonality/DoW/demand multipliers have no ceiling:** **PARTIALLY FIXED in trial-pricing.ts; UNCHANGED in production pricing.** In `trial-pricing.ts` lines 266 and 293, the FINAL `mult` is clamped to `[SEASONALITY_FLOOR=0.75, SEASONALITY_CEIL=1.5]` and `[DOW_FLOOR=0.85, DOW_CEIL=1.2]` respectively, AFTER the manual adjustment is applied. So the structural ceiling is enforced for the trial. The `manualAdjPct` value ITSELF is unclamped, so a user could enter +500% and just hit the ceiling. The production pricing path (`pricing-report-assembly.ts`) wasn't audited today and may not have the same ceilings.
3. **Single-unit vs multi-unit occupancy scope mismatch:** **UNCHANGED.** Confirmed real — `multi-unit-occupancy.ts` line 87-88 explicitly filters to `unitCount >= 2`; single-unit listings have a separate occupancy path. The two populations don't intersect. Pre-existing architectural choice; not in scope for today's KD wiring work.
4. **Peer-shape branch skips the benchmark floor:** **DOCUMENTED AS INTENT, NOT FIXED.** Lines 1199-1204 of `pricing-report-assembly.ts` explicitly comment: "LY benchmark floor only applies to the standard / multi-unit pipeline. Peer-shape rows respect ONLY the user's minimum override (or base × 0.7 fallback) per spec." Cowork Claude flagged this as worth confirming — confirmed it IS the documented design. No change made.
5. **End-to-end multiplier-chain test coverage missing; `trial-pricing.ts` has zero tests:** **UNCHANGED.** Confirmed — no `trial-pricing.test.ts` exists. Other pricing modules have tests (`multi-unit-occupancy.test.ts`, `peer-set.test.ts`, `market-anchor.test.ts`, `peer-shape.test.ts`, `multi-unit-anchor.test.ts`). The full multiplier chain that drives every trial comparison cell has no test coverage. Worth adding before promoting any tuning change to production.

### Other strategic changes today (not in the five findings)

- **Trial KPI defined and shipped** — pre-occupancy agreement vs PriceLabs, target ≥ 90% within ±10%. Baseline today **20.4%**.
- **Horizon extended 90 → 270 days** in the comparison agent.
- **Trailing-ADR shared helper** (`trailing-adr.ts`) with the owner-spec exclusions (ownerstay, > 10-night stays, calendar-day denominator). Both the comparison agent and listing-calibration delegate to it.
- **listingSizeAnchor bug fixed** — the single biggest correctable thing in the engine. Cross-bedroom ratio from KD now feeds the 0.15 size weight; the 0.30 KD market weight is no longer silently zeroed.
- **Demand multiplier blends** LY-same-week + trailing-12mo-baseline lifts (`max`-of-amplitude).
- **KD seasonality always-on**, derived from trailing-52-week weekly KPIs aggregated by start-date month.
- **Per-band MEAN signed delta vs PL** added as a headline metric ("are we 13% or 80% away in next 7 days?" — owner framing).
- **Demand-spike classifier** with booking-window soft-spike axis + revpar_adj YoY swap (the Fleadh detector).
- **Listing-calibration table reframed** as "KD scraped view vs our booked truth (informational)" — NOT a data-quality check on our internal data. Red highlighting removed.
- **Day-14 summary email + worker schedule** registered for 2026-06-01 09:00 London. Daily 06:00 schedule was registered for the first time this session — the BullMQ scheduler was registered but the worker had never actually been started (`3e02176 keydata-trial: start pricing-comparison worker alongside sync worker (was never running)`).

**Affects:** Every file in `src/lib/agents/pricing-comparison/**`, plus `keydata-provider.ts`, `trial-pricing.ts`, `report-html.ts`, `summary-email.ts`.
**Status:** active. Pre-occ KPI at **20.4% within ±10%**; target ≥ 90% by Day 14 (2026-06-01). Next tuning target = the 31-90d trough.

Tonight 22:xx: DEMAND_PASS_THROUGH 0.5 → 0.7, DEMAND_CEIL 1.15 → 1.40, duplicate-clamp removed in prod path, trial-pricing.test.ts shipped with 13 tests, 31-90d instrumentation live. First reading of the new diagnostic: 56.7% of trough cells hit the demand FLOOR (not ceiling) — Belfast forward occ is mostly negative vs LY, so the clamp binds at 0.92. Tomorrow's report will surface that explicitly.

## 2026-05-20 — Pricing-comparison worker restarted on current code (DEPLOYMENT)

**Decided by:** Mark + Claude Code
**What:** This was a deployment. The long-running pricing-comparison worker (PIDs 59441 / 59442, `tsx src/workers/run-all-workers.ts`, started 2026-05-19 09:00:03) was stopped cleanly with SIGTERM and restarted from the worktree. New PIDs **30106 / 30107**, started 2026-05-20 13:08 BST, running on the current `keydata-trial-overnight-2026-04-28` branch with a freshly-regenerated Prisma client. Verified: source-file mtimes (10:47) precede launch (13:08); the new process loaded current code. One manual `scripts/run-comparison.ts 2026-05-20` run regenerated today's report; the email guard correctly blocked a duplicate send.
**Why:** Every code change from 2026-05-19 evening onwards (listingSizeAnchor cross-bedroom, trailing-ADR exclusions, `DEMAND_PASS_THROUGH` 0.5→0.7, `DEMAND_CEIL` 1.15→1.40, duplicate-clamp removal, 31-90d trough instrumentation, pre-occ KPI banner, per-band mean-Δ table, KD-always seasonality) had been on disk but never executed in a generated report. Today's 06:00 report Mark read this morning was generated by stale 2026-05-18 code.
**Headline numbers (first reading on current code, 2026-05-20):** Pre-occ within ±10% **22.01%** aggregate (vs 20.4% baseline, +1.6pp); LF **21.60%**, Stay Belfast **23.09%**. LF mean Δ vs PL **-6.90%** (was -23.7% on the stale report); Stay Belfast **+0.83%** (was -4.6%). Per-band trough is still 61-90d (LF -33.67%, Stay -23.08%). 31-90d trough diagnostic confirms morning hypothesis: **58.3% of trough cells hit the demand FLOOR (0.92), 0% hit the raised DEMAND_CEIL (1.40)** — the path to closing the 31-90d gap is on the floor side, not the ceiling.
**Affects:** `BUILD-LOG.md` entry "2026-05-20 afternoon — Worker restart (DEPLOYMENT)" captures full detail. Next 06:00 London scheduled run (2026-05-21 06:00 BST) will be the first automatic emailed report on current code.
**Status:** active.

## 2026-05-20 evening — Demand architecture: RevPAR-adj, floor=1.0, LY dropped (DEPLOYMENT)

**Decided by:** Mark (overnight prompt) + Claude Code
**What:** One coherent tightening of the demand signal, deployed to the trial-comparison path. Three production changes plus one read-only instrumentation extension.

1. **`DEMAND_FLOOR` 0.92 → 1.0** in `trial-pricing.ts`. Demand becomes upside-only — it can lift, never drag. Downside is owned by the occupancy ladder (§3.3) and the 3-gated lead-time floor (§3.4). The 0.92 floor was binding on 58.3% of 31-90d trough cells, dragging price down on the OTA forward-occupancy reading at mid-range lead time — a noisy signal where supply expansion ahead of events depresses forward occupancy even on genuine spikes.
2. **Demand baseline collapsed to trailing-12mo only.** LY-same-week is dropped as a multiplier driver (LY context still surfaces in the reasoning string). The Fleadh KeyData diagnostic 2026-05-20 was decisive — same-week LY occupancy was -23pp on Fleadh week, while the within-year RevPAR-adj comparison was +51.8%. The old max-amplitude selector actively preferred the misleading LY signal because its negative amplitude was larger.
3. **Demand metric switched to RevPAR-adjusted.** New formula: `demandDelta = (forwardRevPARadj_forDate / trailing12moMedianRevPARadj) - 1`. Replaces `occDelta + 0.5 × adrDelta`. RevPAR-adj is the one signal in KeyData's OTA feed that cleanly catches event weeks even when supply dilution suppresses occupancy alone. Provider plumbing (`KeyDataForwardPaceDay.forwardRevparAdj` + `KeyDataTrailingMarketKpis.trailingMedianRevparAdj`) was already in place from 2026-05-19; only the multiplier call site needed wiring through. Pass-through (0.7) and ceiling (1.40) unchanged. Graceful fallback to 1.0 on null / zero / NaN, with explicit reasoning string.
4. **Seasonality instrumentation (read-only).** Extended the trough diagnostic in `report-html.ts` to surface per-trough-cell own / KD / blended monthly indices — distribution stats (n, mean, min, median, max) across the trough band, plus a "Seas own / Seas KD / Seas blend" column on the top-10 binding-clamp table. No seasonality logic changed; tomorrow's report will tell us whether seasonality is flat because both inputs truly are ~1.0 or because the 0.6/0.4 blend is squashing a non-flat input.

**Why:** The 31-90d trough on the 2026-05-20 morning report was diagnosed as a clamping problem (58.3% of cells hit the demand floor at 0.92), not a base-price problem, not a ceiling problem. Fix is to stop demand dragging the price and rebuild the signal on a metric that supply-dilution can't mask. Seasonality is the next leg of the trough; instrumented tonight, fixed a later night informed by data.

**Affects:** `src/lib/pricing/trial-pricing.ts` (DEMAND_FLOOR + computeDemandMultiplier rewrite + call-site wiring). `src/lib/pricing/trial-pricing.test.ts` (15 tests; 7 demand-specific including the new floor=1.0 and NaN-safety cases). `src/lib/agents/pricing-comparison/report-html.ts` (DiagRow type extension + seasonality instrumentation block + top-10 column additions). 84/84 pricing-anchors tests pass. `npm run typecheck` clean.

**Headline post-change (latest 2026-05-20 run, vs pre-change baseline):**

| Tenant | Band | Pre | Post | Δ |
|---|---|---|---|---|
| Little Feather | 31-60d | -21.32% | **-19.45%** | +1.87pp |
| Little Feather | 61-90d | -33.67% | **-30.68%** | +2.99pp |
| Stay Belfast | 31-60d | -14.23% | **-9.75%** | +4.48pp |
| Stay Belfast | 61-90d | -23.08% | **-17.07%** | +6.01pp |

Direction confirmed: the trough narrowed on both tenants. Stay Belfast moved more because more of its trough cells were sitting just below the old 0.92 floor; lifting the floor to 1.0 gave them the full ~8% lift. The remaining gap is now seasonality- and base-shaped, not clamp-shaped — next-night work.

**Trough diagnostic:** 3,300 trough cells; demand floor hit on 2,915 (88.3%, expected — the new floor sits at 1.0 so any negative RevPAR-adj signal clamps there); demand ceiling hit on 0 (0.0%) — RevPAR-adj on 2026-05-20 doesn't push any cell above 1.40 on its own. Seasonality instrumentation read: own mean 1.16 (wide spread, max 3.19), KD mean 1.06 (very tight: 0.97-1.08), blended mean 1.12 — i.e. seasonality IS lifting summer dates ~12% on average. The previous "seasonality is flat (ceiling hit on 0.5%)" reading missed this because the blended values mostly sit inside the [0.75, 1.5] structural bounds without hitting them.

**Customer-facing prices: unchanged.** Tonight's work touched only the trial-comparison/report path — no `hostawayPushEnabled` flag, allowlist, push code, or pushed rate was modified. `pricing-report-assembly.ts` (the production / push path) was not touched.

**Deployment status:** Worker restarted at 2026-05-20 20:30 BST. Old PIDs 30106 / 30107 stopped cleanly via SIGTERM. New PIDs **52229 / 52247**, freshly-regenerated Prisma client, source-file mtimes (20:21) precede launch (20:30). Scheduler re-registered for 06:00 Europe/London daily. Next automatic emailed report = 2026-05-21 06:00 BST — first reading of tonight's code in production.

**Status:** active.

## 2026-05-22 — Seasonality fix: portfolio-aggregated own + sample-gated blend + ceiling 1.50→1.80

**Decided by:** Mark + Claude Code (per `TONIGHT-SEASONALITY-FIX-2026-05-21.md`)
**What:** Four changes to the seasonality leg of the trial pricing model, ALL on the comparison/report path — no customer-facing prices changed.

1. **Own-history monthly seasonality is now portfolio-aggregated per tenant** (was per-listing). New `loadOwnHistoryPortfolioSeasonality(tenantId, listingIds)` in `agent.ts` aggregates all the tenant's listings' booked NightFact rows by calendar month over the trailing 365-day window. Reuses the `trailing-adr.ts` exclusions (ownerstay filtered, stays > 10 nights filtered, calendar-day basis) so the index is internally consistent with the trailing-ADR base-price signal. Returns a 12-element monthly index AND a 12-element per-month booked-night count; computed ONCE per tenant per run.
2. **Fixed 60/40 own/KD blend replaced with a sample-gated weighting.** Named constants at the top of `trial-pricing.ts`: `SEASONALITY_OWN_SAMPLE_GATE = 30`, `SEASONALITY_WEIGHTS_OWN_LED = { own: 0.85, market: 0.15 }`, `SEASONALITY_WEIGHTS_OWN_SPARSE = { own: 0.40, market: 0.60 }`. Per-cell branching: own + KD with sample ≥ gate → own-led; with sample < gate → KD-heavy fallback; only KD or only own → 100% of that source.
3. **`SEASONALITY_CEIL` raised 1.50 → 1.80** (floor still 0.75). Portfolio aggregation removes the wild 3.19 single-listing artifact the per-listing version produced, so a higher ceiling is safe.
4. **Instrumentation extended** in the 31-90d trough section of `report-html.ts` — per cell: own monthly index, own sample size, KD monthly index, chosen own/kd weights, blended result, ceiling-clip flag (`↑`/`↓`/`—`). New "Blend mix across the trough" line counts cells on own-led / KD-heavy / own-only / KD-only / no-signal / legacy buckets. Top-10 table gains "Own n", "Weights (own/kd)", and "Clip" columns.

**Why:** Day-4 instrumentation showed the diagnosis. Own-history seasonality in the 31-90d trough averaged 1.16 with a wide tail (min 0.81, max 3.19 — single-listing artifact); KeyData OTA seasonality averaged 1.06 (essentially flat); the fixed 60/40 blend yielded 1.12, with a 1.50 ceiling clipping the legitimate summer tail. Per Mark's standing principle ("when our own booked data has a dense enough sample size we should be using it; KeyData is fallback"), own-history should lead when its monthly sample backs it. Portfolio aggregation kills the artifact, the sample gate switches the blend to own-led when there's enough data, and the raised ceiling lets the genuine summer signal land.

**Tests:** 5 new `blendSeasonality` cases (own-led when sample above gate; KD-heavy fallback below gate; no own → KD alone with no NaN; own-only → 1.0 × own; high own clamped at 1.80 ceiling). End-to-end fixture updated. `npm run test:pricing-anchors` 87 / 87 pass (up from 84). `npm run typecheck` and `npm run lint --max-warnings=0` both clean.

**Headline 31-90d trough on 2026-05-22 post-change vs pre-change baseline (-17.0% / -30.3% per spec):**

| Tenant | Band | Pre-change | Post-change | Δ |
|---|---|---|---|---|
| Little Feather | 31-60d | -17.2% | **-9.80%** | +7.4pp |
| Little Feather | 61-90d | -31.2% | **-26.16%** | +5.0pp |
| Stay Belfast | 31-60d | -9.8% | **-5.00%** | +4.8pp |
| Stay Belfast | 61-90d | -17.1% | **-12.45%** | +4.6pp |

Pre-occ ±10% aggregate: **22.11% → 23.66%** (+1.5pp). LF mean Δ vs PL: **-5.9% → -4.07%**. All 6,600 post-change trough cells landed on **own-led 0.85/0.15 weights** — sample sizes 600+ per month portfolio-wide, well above the 30 gate; the KD-heavy fallback didn't fire on a single trough cell. The 1.80 ceiling is not binding on any cell today either.

**Email:** Today's 06:00 emailed report had already gone out at 06:58 BST on pre-change code (the email-sent guard was already in place when the manual run started). Mark approved running the manual regeneration with the guard in place — no duplicate email. The on-disk 2026-05-22 report HTML + DB rows now reflect the post-change code; the **next 06:00 run (2026-05-23) is the first automatic emailed report on the new seasonality**.

**Worker:** Worker restarted from the worktree at 07:47 BST 2026-05-22 (new PIDs **82719 / 82720**; previous 52229 family stopped cleanly with SIGTERM). Source mtimes 07:26-07:40 precede launch — new process is on tonight's code.

**Customer-facing prices: unchanged.** Tonight's work touched only `trial-pricing.ts`, `agent.ts`, `report-html.ts`, `trial-pricing.test.ts`, `backtest/runner.ts`. The `pricing-report-assembly.ts` path that pushes live rates to Hostaway was not touched; no `hostawayPushEnabled` flag, no rate-copy listing, no manual override, no allowlist, no pushed rate changed.

**Affects:** `BUILD-LOG.md` entry "2026-05-22 morning — Seasonality fix" captures the full detail.

**Status:** active.

## 2026-05-22 — Events lever (Fleadh +40%) wired into trial comparison agent

**Decided by:** Mark + Claude Code (per `TONIGHT-EVENTS-FLEADH-2026-05-22.md`, supervised same-day run)
**What:** Three changes to the events leg of the trial pricing path, ALL on the comparison/report path — **no customer-facing prices changed**.

1. **`eventAdjustmentForDate` lifted to `src/lib/pricing/events.ts`** (one source of truth; both the trial comparison agent and `pricing-report-assembly.ts` import from it). The two stale duplicates in `pricing-report-assembly.ts` + `reports/service.ts` (the latter dead code) are gone. The shared helper handles both `dateSelectionMode === "range"` AND `dateSelectionMode === "multiple"` (selectedDates) — same semantics as the production calendar path.
2. **Trial comparison agent wired:** `agent.ts` previously hardcoded `localEventAdjPct: null`; now resolves via `eventAdjustmentForDate(getTrialLocalEventsForTenant(tenant), targetIso)?.adjustmentPct ?? null`. Trial events resolved ONCE per tenant; reused for every listing × every date.
3. **Trial-only event source `src/lib/agents/pricing-comparison/trial-events.ts`** loads Fleadh **without touching `settings.localEvents`**. Step C trace: `settings.localEvents` IS in the push path (`push-rates → executePushRates → buildPricingCalendarReport → buildPricingCalendarRows → eventAdjustmentForDate(settings.localEvents) → recommendedRate → push.ts`); the trial-events module is invisible to that chain. Cap enforced at runtime: `TRIAL_EVENT_ADJUSTMENT_PCT_CAP = 60` (artifact guard).

**Fleadh sizing (`adjustmentPct: 40`)** — chosen by Mark mid-flight after the Step A diagnostic. Step A showed the engine is BLIND to Fleadh:
- Demand multiplier pinned at the FLOOR (1.0) on **every** Fleadh-week cell (640/640 LF, 240/240 SB). KD OTA forward RevPAR-adj reads early-Aug as soft (supply-dilution pattern).
- Seasonality already firing (LF mean 1.20, SB 1.35) within the new 1.80 ceiling.
- Fleadh-week mean Δ vs PL: LF -42.98%, SB -25.09%, aggregate -38.10%.

Arithmetic: with +40% on top of the existing stack, projected Fleadh-week Δ is LF ~-20% (still under, partly base-price-shaped) and SB ~+5% (within ±10% gate, no overshoot). +50% would overshoot SB (+12%), +30% would leave SB undershoot (-3%). +40% maximises the closure subject to the spec's "no overshoot past +10%" gate on the more-PL-aligned tenant.

**Tests:** 4 new `computeTrialDailyRate` cases. `npm run test:pricing-anchors` **91/91** (up from 87). typecheck + lint clean.

**Manual verification (2026-05-22):** `npx tsx scripts/run-comparison.ts 2026-05-22` regenerated today's report. 14,850 cells, 0 errors. `.email-sent` guard correctly blocked duplicate email. **440/440 Fleadh-week cells got the +40% event** (LF 320/320, SB 120/120).

**Headline (Fleadh-week mean Δ vs PL):**
- LF: **-42.98% → -20.35%** (+22.6pp; still under because LF base-price gap is structural)
- SB: **-25.09% → +4.88%** (+29.97pp; within ±10% gate)
- Aggregate Fleadh: **-38.10% → -13.47%** (+24.6pp)

**Headline (61-90d band Δ vs the -26.16% pre-seasonality baseline):**
- Pre-seasonality: -26.16% → post-seasonality: -23.43% → **post-events: -16.87%** (+9.3pp combined improvement)

Fleadh week is ~27% of the 61-90d cell count; the lever closed Fleadh week's slice from -38% to -13%, accounting for nearly all of today's band-level improvement. The non-Fleadh portion (-18% aggregate) is unchanged and is base-price-shaped, not multiplier-shaped — the next tuning target.

**Worker:** Worker restarted at 10:35 BST 2026-05-22 (new PIDs 89656 / 89657; previous 82719 family stopped cleanly with SIGTERM). Source mtimes 10:23-10:28 precede launch. Next automatic emailed report = 2026-05-23 06:00 BST — first end-to-end run on the events lever.

**Customer-facing prices: unchanged.** New code is invisible to `pricing-report-assembly.ts` (trial-only source), and the one change in `pricing-report-assembly.ts` is a one-line import refactor of the lifted helper — identical behaviour. `settings.localEvents` stays empty on both trial tenants. No `hostawayPushEnabled` flag, no rate-copy listing, no manual override, no allowlist, no pushed rate changed.

**Affects:** `CLAUDE.md` (new "Trial events lever (Fleadh)" section). `BUILD-LOG.md` entry "2026-05-22 mid-morning — Events lever (Fleadh)" captures the full detail.
**Status:** active.

## 2026-05-22 — Demand signal rebuilt: temporal → cross-sectional (date vs same-month peers)

**Decided by:** Mark + Claude Code (per `TONIGHT-DEMAND-SIGNAL-2026-05-22.md`, supervised two-phase run)
**What:** Replaced the core of the demand multiplier. Old: forward-vs-trailing-12mo (forward-still-filling vs settled-finished — structurally biased to read every forward date as soft, floor-pinning 100% of Fleadh-week cells). New: weighted blend of cross-sectional deltas — target date vs same-calendar-month peer dates, observed at the current snapshot, NOT day-of-week-matched. Comparison/report path only — **no customer-facing prices changed**.

1. **Own-portfolio cross-sectional component** (portfolio-aggregated nights-on-books / supply, reconstructed from `Reservation`; per-tenant).
2. **KeyData cross-sectional component** (per-date market revpar_adj; provider switched from `/kpis/week` to `/kpis/day`; `listing_count` exposed as supply guard).
3. **Linear pre-clamp blend**: `OWN_WEIGHT=0.5`, `KD_WEIGHT=0.5`, `PEER_MIN_SAMPLE_SIZE=8`. Both-elevated produces larger lift than either alone.
4. **Supply guard**: fires when supply contracted >20% AND ADR delta < 5%; damps to ADR-only. Fleadh Sat (supply -34%, ADR +7%) doesn't trigger.
5. **`DEMAND_FLOOR` 1.0 → 0.92** — bidirectional. The 2026-05-20 floor=1.0 was to stop the temporal-comparison artifact dragging prices down; cross-sectional has no such bias. Preserves weekday downside.
6. **Automatic day-of-week multiplier retired** — cross-sectional demand now absorbs weekly variation natively. Manual `manualDoWAdjPct` override still flows.

**Market-agnostic principle:** weekly patterns are demand-derived, not configured. The engine generalises beyond Belfast — whatever the local market does, demand picks it up.

**Tests:** 6 new cross-sectional cases. `npm run test:pricing-anchors` **90/90** pass. typecheck + lint clean.

**Headline (pre-rebuild → post-rebuild):**

| | Pre | Post |
|---|---|---|
| LF Fleadh week mean Δ | -20.35% | **-5.81%** |
| SB Fleadh week mean Δ | +4.88% | **+21.33%** (overshoot — events +40% stacks) |
| **Aggregate 61-90d** | **-16.87%** | **-13.64%** (+3.2pp) |
| Mean demand mult on Fleadh cells | 1.0 (floor-pinned) | **1.21-1.23** |

**Open follow-up:** SB Fleadh overshoot suggests events lever (+40%) is redundant on top of native demand. Mark to decide tomorrow.

**Worker:** PIDs 2231/2232, restarted 2026-05-22 15:17 BST. Next 06:00 emailed report (2026-05-23) is the first clean end-to-end run on cross-sectional demand.

**Customer-facing prices: unchanged.** Trial comparison/report path only.

**Affects:** `BUILD-LOG.md` entry "2026-05-22 afternoon — Demand signal rebuild" captures the full detail.
**Status:** active.

## 2026-05-22 — Trial comparison restricted to available nights only

**Decided by:** Mark + Claude Code (per `TONIGHT-AVAILABILITY-FIX-2026-05-22.md`)
**What:** Comparison-scope filter only — the trial comparison agent now scores only nights the listing is actually bookable (`CalendarRate.available === true AND rate > 0`). Blocked nights and missing calendar rows are excluded BEFORE classification, KPI, band stats, per-listing aggregates, and the trough/Fleadh sections. Single counter `unavailableCellsExcluded` covers blocked + no-rate + missing; pre-existing `noHostawayRate` folded in. **No pricing logic touched.** Comparison/report path only — **no customer-facing prices changed.**

**Why:** Several LF "worst-scoring" listings were blocked for Fleadh week and the comparison scored them against stale £326-£713 PL placeholder rates. That noise flowed into tenant means, the 31-90d trough, pre-occ KPI, and per-listing rankings.

**Tests:** 5 new cases in `agent.test.ts`. **95/95** pass. typecheck + lint clean.

**Manual verification:** cellsCompared 14,850 → **6,713** (54.8% dropped). Run successful.

**Headline (pre-filter → post-filter):**

| | LF | SB |
|---|---|---|
| n cells | 10,800 → 3,532 (-67%) | 4,050 → 3,181 (-21%) |
| mean Δ vs PL | -0.00% → **-3.40%** | +9.00% → +7.69% |
| 31-90d band | -14.20% → -14.48% | +2.26% → **-1.61%** |
| ±10% within | 21.44% → 23.39% | 23.75% → 23.58% |

LF lost two-thirds of cells — much of LF's portfolio heavily booked over 270 days. Blocked cells had been **masking** real LF base-price drag with PL placeholders.

**Per-night Fleadh (the diagnostic the week-average was hiding):** Only Thu-Sun pin demand at 1.40 ceiling. Mon-Wed are NOT event-driven (LF Mon-Tue demand 0.955-0.957). LF coldest Fleadh: Sat 08 Aug **-26.65% vs PL** with demand AND events both at ceiling — base-price drag, not multiplier capacity. LF hottest: Sun 09 Aug +28.30%. SB hottest: Sun 09 Aug **+48.68%** overshoot.

**LF per-listing worst-list reshuffled.** Previous top 4 (Custom House Square, Somerset, St Annes) had 0-1 available cells in 270 days. New trustworthy rankings: zB-711 Portland -36.35% (n=62), Portland G-cluster -23 to -12% (n=48-67), Castle Buildings cluster -12 to -18% (n=163-195). Templemore 1/2 +33-36% over many cells.

**Worker:** PIDs 10683/10684, restarted 22:04 BST 2026-05-22. Next 06:00 emailed report 2026-05-23 is the first end-to-end run on available-nights basis.

**Customer-facing prices: unchanged.**

**Affects:** `BUILD-LOG.md` entry "2026-05-22 evening — Available-nights comparison filter" captures the full detail.
**Status:** active.

## 2026-05-22 overnight — Per-night per-tenant Fleadh + event-night clamp relax

**Decided by:** Claude Code (autonomous overnight, per `TONIGHT-FLEADH-PER-NIGHT-FIX-2026-05-22.md`)
**What:** Three coherent changes. Comparison/report path only — **no customer-facing prices changed.**

1. **Per-night, per-tenant Fleadh events.** Flat +40% range entry replaced with single-date per-tenant entries. Mon-Wed + lead-in Sun (08-02) + post-event Sun (08-09): 0% (no entry) on both tenants. LF Thu/Fri/Sat: +30 / +60 (cap) / +60 (cap). SB Thu/Fri/Sat: +15 / +50 / +25. Routing by `tenant.slug.startsWith('little-feather' | 'stay-belfast')`. `TRIAL_EVENT_ADJUSTMENT_PCT_CAP=60` artifact guard retained.
2. **Event-night daily-rate clamp relax.** Two constants: `NORMAL_NIGHT_RATE_MULTIPLE=2.5` (unchanged) and `EVENT_NIGHT_RATE_MULTIPLE=3.5` (new). Clamp uses 3.5× when the cell has `localEventAdjPct !== null && adjPct !== 0`, 2.5× otherwise. Both manual and standard pipelines updated. 3.5× covers Fleadh Sat's 3.39× PL/base with margin.
3. **Global `DEMAND_CEIL` (1.40), `DEMAND_FLOOR` (0.92), `DEMAND_PASS_THROUGH` (0.7) deliberately untouched** — per the spec, a global demand-ceiling lift would lift every hot date in every market and must be Mark's conscious call, not an overnight change.

**Tests:** 8 new cases (5 in new `trial-events.test.ts`, 2 in `trial-pricing.test.ts` for the clamp relax, 1 existing test reframed). `npm run test:pricing-anchors` **103/103** pass. typecheck + lint clean.

**Per-night Fleadh result post-change:**

| Tenant | Night | events | ourΔPL post | vs pre |
|---|---|---|---|---|
| LF | Thu 08-06 | 1.30 | **+1.0%** | was +6.7% |
| LF | Fri 08-07 | 1.60 | **-4.1%** | was -17.4% |
| LF | Sat 08-08 | 1.60 (cap) | **-15.4%** | was -27.6% — **base-price residual** |
| LF | Sun 08-09 | 1.00 | **-7.8%** | was +25.4% |
| SB | Thu 08-06 | 1.15 | **+2.3%** | was +13.6% |
| SB | Fri 08-07 | 1.50 | **+7.5%** | was -8.1% |
| SB | Sat 08-08 | 1.25 | **+1.0%** | was +12.1% |
| SB | Sun 08-09 | 1.00 | **+13.3%** | was +48.8% |

All Thu-Sat peaks within ±10% of PL on both tenants except LF Sat. The +60% event cap + relaxed clamp + demand at ceiling cannot bridge LF Sat's PL/base = 3.39× — this is the **LF base-price residual flagged for next session**.

**Castle Buildings base-check side-output (read-only):** 7 of the 9 listings are 1-bed; ALL 7 1-beds sit **-15% to -20% under PL base** (our £132-£139 vs PL £165). The 2 2-beds are essentially at PL. Indicative of where LF's broader base-price calibration sits.

**Worker:** Restarted at 22:58 BST 2026-05-22 (PIDs 13801/13802; previous 10683/10684 stopped cleanly). Next automatic emailed report = 2026-05-23 06:00 BST.

**Customer-facing prices: unchanged.**

**Affects:** `BUILD-LOG.md` entry "2026-05-22 overnight — Per-night per-tenant Fleadh + event-night clamp relax" captures the full detail.
**Status:** active.

---

## 2026-05-23 — Four-rung confidence ladder for trial base + LF Fleadh re-size

**Owner:** Mark McCracken
**Approved by:** Mark (push + commit instruction 2026-05-24)
**Authors of work:** Claude (autonomous build through context-summary boundary)

**Decision:** Replace the linear own/market/size-blend formula in `computeTrialBase` with a four-rung confidence ladder driven by trailing-12mo sold-night count. Drop the size-anchor blend term (no independent information). Re-size the LF Fleadh Thu/Fri per-night events on the new base.

**Trial path only:** `buildRecommendedBaseFromHistoryAndMarket` (market-anchor.ts, production base) is NOT touched. Customer-facing prices on the calendar / Hostaway push do not change. The redesign moves only the KeyData comparison agent's `computeTrialBase` / `computeTrialMinimum` — what the daily report shows.

**Why now:** the 2026-05-23 read-only base-price diagnostic found that the trial base was structurally under PL by 17-20% on listings the model SHOULD calibrate well (CB-1 1-beds: own £127, PL £165, market-blend pulled us toward £132 instead of recognising that 308 sold nights at 84% occupancy is high-confidence own data that deserves a market-aware upward nudge). The same diagnostic found a +25% OVER on Templemore — a fundamentally cheaper listing whose own £107 had been blended UP by the market signal. A single linear blend couldn't fix both.

**The four rungs:**

| Rung | Trigger | Anchor |
|---|---|---|
| 1. Rich own | `soldNights ≥ 100` | own ADR × occupancy-lift (factor 1 + (ownOcc/marketOcc − 1) × 0.20, clamped [0.92, 1.25]). Lift skipped when no KD P50, cheap segment (ownAdr < kdP50 × 0.70), or already at/above market (ownAdr ≥ kdP50) |
| 2. Thin own | 20 ≤ soldNights < 100 | confidence-weighted blend of rung-1 and (rung-3 OR rung-4) |
| 3. Comp inheritance | rung-2 residual + `group:` tag cluster exists | mean rung-1 anchor of same-bedrooms siblings with rich own history |
| 4. KD market P50 | no own, no comps | bedroom-band P50 fallback |
| Manual anchor | `manualBaseAnchor` set | short-circuits all rungs (plumbed, intentionally unset on every trial listing today) |

**Minimum sub-proposal E:** the KD-P20 × similarity floor is disabled when `ownAdr ≥ kdP50 × 1.05`. The KD market floor is irrelevant when the listing has already proven it can sell at or above market; previously the KD floor was pushing CB-2 minimums £21 over PL.

**Calibration outcome (vs PL targets):**

| Listing | bd | old | new | PL | result |
|---|---|---|---|---|---|
| CB-1 1-beds (×7) | 1 | £132-139 | £155-£171 | ~£165 | HIT (median ~£158) |
| CB-2 2-beds (×2) | 2 | £195-200 | £188-£195 | ~£204 | HIT (target was unchanged) |
| Templemore 1+2 | 2 | £134-135 | £106-£107 | £108-£111 | HIT (cheap-segment branch fires) |
| Portland 711 (thin) | 3 | £198 | £222 | £311 | HIT (rung-4 KD floor lifts) |
| Portland G05 (R2) | 3 | £190 | £197 | £274 | HIT (rung-2 blend lifts) |
| SB Fitzrovia (×3) | 1 | £137-144 | £144-£156 | £150-£153 | HIT (unchanged / slight up) |

All five spec targets hit on the 2026-05-23 PM verification run. No listing in the sample was made worse.

**Fleadh re-size:** the four-rung lift raised LF base 132 → 160 mean, so the Thu/Fri events sized on 2026-05-22 (when base was 132) now over-fire. Re-sized LF Thu 30→15%, Fri 60→50%, Sat 60→60% (cap held — Sat still under PL £500 by 8%, structural limit). SB unchanged (SB base barely moved; SB Thu lands -1.9% under PL on existing +15%).

**Verification:**
- 116 / 116 tests pass (13 new tests for the ladder + sub-proposal E)
- `npm run typecheck` clean / `npm run lint` clean
- Manual `runDailyTrialPipeline` for 2026-05-23: 6,721 cells, 0 errors, defensibility {defensible: 0, borderline: 21, questionable: 3}
- LF Fleadh week after re-size: Thu median +1%, Fri median -2%, Sat -8% (cap), Sun +1% — all within ±10% target band

**Risks:**
1. **Cluster cheap-vs-mid mis-classification.** If a listing is genuinely high-spec but has a temporarily low ownADR (e.g. mid-renovation), the 0.70 cheap-threshold pins it. Mitigation: re-check Templemore weekly to confirm it stays a cheap-segment listing; revisit threshold if drift seen.
2. **Occupancy lift drives over-pricing in low-occupancy years.** If a listing has 50% occupancy because demand fell (not because of pricing skill), the lift formula still fires. Mitigation: SLOPE 0.20 + MAX 1.25 deliberately conservative; we tune up only if calibration evidence sustains.
3. **Comp anchor pollution across `group:` tags.** Renaming a `group:` tag mid-trial moves a listing in/out of the cluster instantly. Mitigation: warned in the agent code; group changes should ride with a deliberate snapshot run for monitoring.
4. **Manual anchor is plumbed but invisible to UI.** When a settings field exists, agent.ts will read it; no UI work tonight. Acceptable — the trial doesn't need anchors; production webapp adds the field when reconciliation begins.

**Trade-off accepted:** the trial divergence from production (market-anchor.ts) widens until reconciliation. That reconciliation is the post-trial follow-up task; it is in scope for the next major chapter, not this one.

**Affects:** `BUILD-LOG.md` entry "2026-05-23 — Base-price redesign BUILD (Phase 1 + 2, checkpoint pending)" captures the full per-listing arithmetic and the TO DEPLOY block.
**Status:** active.

---

## 2026-05-24 — Demand horizon fix: pace data-sufficiency gate + NI holiday calendar layer

**Owner:** Mark McCracken
**Approved by:** Mark (spec authorised autonomous overnight build, "push if successful before morning")
**Authors of work:** Claude (autonomous overnight)

**Problem:** the 2026-05-24 trial report exposed the cross-sectional demand multiplier producing 2× PriceLabs recommendations on far-future off-season cells (City Gate £335 vs PL £128 for 2026-12-01; Castle Buildings 1-beds £215 vs PL £115 for 2027-02-10; dozens like them). The cross-sectional pace signal was pinning at the +40% ceiling on noise because its data-sufficiency check counted PEER DATES, not PEER CONTENT. At 130-270 days out the cohort was large by count and tiny by content; tiny absolute fluctuations blew up the `target_fill / peer_median_fill - 1` ratio to the rails.

**Decision:** two-layer fix.

**Layer 1 — data-sufficiency gate (Phase B, MUST-SHIP):**
- New constant `DEMAND_PACE_MIN_PEER_FILL = 0.15` in `cross-sectional-demand.ts`.
- `computeOwnCrossSectionalDelta` returns `delta: null` when `peer_median_fill < 0.15`, even if peer count passes the existing 8-gate.
- Null delta cascades to `computeDemandMultiplier`'s neutral fall-back (multiplier = 1.0, no NaN).
- Threshold calibrated against today's horizon diagnostic: 0-30d avg fill 41%, 31-60d 28%, 61-90d 21%, 91-180d 20%, 180d+ 12%. The gate excludes the 180d+ tail entirely (where pinning was worst) and trims the bottom of 91-180d.

**Layer 2 — NI holiday calendar (Phase C):**
- New file `holiday-calendar.ts` hardcodes NI bank-holiday windows 2024-2027 from gov.uk's official Northern Ireland list (St Pat's, Easter, both May bank holidays, Twelfth, August bank holiday, Christmas, NYE).
- `loadHolidayDemandFactors(tenantId)` learns per-date-type multipliers from the tenant's own NightFact history. RPAN (revenue per available night) inside each holiday window is compared against RPAN on non-holiday dates in the same calendar period — isolates the holiday effect from underlying seasonality.
- `HOLIDAY_DELTA_CAP = 0.20` symmetric (vs Fleadh's 0.60 — modest by spec).
- Thin-sample fallback at `HOLIDAY_MIN_SOLD_NIGHTS_SAMPLE = 8` → `HOLIDAY_DEFAULT_DELTA = 0.05`.
- Direction-agnostic — the learned multiplier for Christmas Eve/Day/Boxing Day this tenant came in at 0.95 (SOFT, as expected for city STR), NYE/NYD at 1.14 (LIFT). Spec: "trust the data, don't assume every holiday lifts."

**Horizon handoff:** clean. The sufficiency gate IS the switch. `computeDemandMultiplier` only consults `calendarFallbackDelta` inside the both-pace-signals-null branch — pace leads when it has data, calendar leads when it doesn't, never both compounded.

**Calibration outcome (sample):**

| Listing | Date | Old rate | New rate | Old demand | New demand |
|---|---|---|---|---|---|
| Belfast - City Gate | 2026-12-01 | £335 | £239 | 1.40 | 1.00 |
| CB Apt 5-9 | 2027-02-10 | £206-215 | £147-154 | 1.40 | 1.00 |

Horizon-wide:
- 91-180d ceiling pins: 329 → 101 (cut by 69%)
- 180d+ ceiling pins: 96 → 10 (cut by 90%)
- 180d+ cells now neutral (pace gated): 1384
- 180d+ cells now holiday-driven: 84 (Christmas SOFT, NYE LIFT)

**Verification:** 135 / 135 tests pass (19 new). Typecheck + lint clean. Manual comparison run: 6,731 cells, 0 errors, 0 NaN. Worker restarted on the new code so the 06:00 BST run on 2026-05-25 uses the fix.

**Risks:**
1. **Threshold is one number across all tenants.** A larger portfolio with naturally lower fill might be over-gated. Mitigation: 0.15 is calibrated against the 24-listing trial portfolios; review after Day 14 when broader Belfast portfolio data is available.
2. **Holiday calendar is hardcoded.** Year-end editions or holiday-date changes need manual updates. Mitigation: spec comments call this out; reviewed yearly when the trial window crosses a new year. NI gov publishes the list well in advance.
3. **Thin-sample fallback (8 sold nights) might still trust noise.** A single weak occurrence could move the learned delta. Mitigation: cap at 0.20 bounds the damage; default 0.05 only applies below the gate; flag the fellBackToDefault flag for the trial report.
4. **A handful of cells remain >50% off PL on non-event dates (790 / 6731 ≈ 12%).** These are BASE-PRICE artefacts on a few listings (City Gate base £216 vs PL £128; Apt 8 Spire £196 vs PL £94), NOT demand-pin artefacts. Documented for a separate base-calibration session — out of scope for tonight.

**Affects:** `BUILD-LOG.md` entry "2026-05-24 — Overnight Demand Horizon Fix (Phase A → D)" captures the full Phase A diagnostic plus the per-horizon before/after counts. Code commits `c1d35a7` (Phase B) and `df9d400` (Phase C). No customer-facing pricing changed.

**Deploy state at decision time:** local worker restarted on the new code so the 2026-05-25 06:00 BST run uses the fix locally. The three commits (`c1d35a7`, `df9d400`, `419e263`) are LOCAL-ONLY on `unify/main-trial-2026-05-20` because the autonomous shell couldn't push without a fresh interactive credential. Mark to run the three `git push` commands from the BUILD-LOG morning task to sync `main` + `keydata-trial-overnight-2026-04-28` for any Railway-side workers.

**Status:** active.

---

## 2026-05-25 — Over-base fix: comp-bounded occupancy lift + banded agreement reporting

**Owner:** Mark McCracken
**Approved by:** Mark (Part B checkpoint approval of Option B comp-bounded lift mechanism)
**Authors of work:** Claude (supervised)

**Problem:** the 2026-05-24 demand horizon fix cleared the far-future demand noise and exposed that ~12% of cells are base-price errors — now mostly OVER PriceLabs. The four-rung ladder (2026-05-23) was calibrated on a sample of under-priced and at-PL listings (Castle Buildings, Templemore); it over-prices a set of listings it never sampled (Belfast City Gate ~£227 vs PL £128; Apt 8 Fitzrovia Spire ~£204 vs £94). Separately, the ±10% trial KPI has been immovable across six fixes — Mark wanted the report to show the full agreement distribution so genuinely-broken cells are distinguishable from cells off by a known, explainable margin.

**Decision:** ship two parts.

**Part A — banded agreement reporting (low-risk, shipped first):**
- The report now shows within ±10/15/20/25 (cumulative) + beyond ±25 ("off") + beyond ±50 ("genuinely broken") per tenant, per booking-window band.
- The existing within ±10% KPI is preserved — this is honest reporting, not a changed pass mark.
- Pure helper `classifyAgreementBands` exported so agent + report share band boundaries.
- 6 new tests cover empty input, cumulative within-bands, strict-tail beyond-bands, inclusive boundaries, invalid-value skipping, within25+beyond25=count identity.

**Part B — diagnostic findings:** the over-set splits into TWO patterns, not one:
1. **In-band + lifted (the lift over-fires):** C-315 St Annes (+33%), City Gate (+28%), Half Bap (+20%) AND Castle Buildings 1-bed Apt 1 (+22%) all sit in own/KD 0.70-1.0 with lift factor 1.17-1.24. The lift over-fires across the board, not only on budget listings. Mark's hypothesis ("lift can't tell premium-selling-cheap from correctly-priced-budget") confirmed for the in-band branch.
2. **At-market (no lift, but ownADR > PL):** Spire (+36%), Sir Thomas (+24%), CB-2 Apt 6 (+17%). own/KD ≥ 1.0 → at-mkt branch → no lift fires. The over-pricing is the ownADR itself being inflated vs PL's view — probably channel-fee / LOS-distorted bookings. Separate from the lift problem.

**Part C — comp-bounded lift implementation (Option B per Mark's call):**
- `computeRung1OccupancyAdjustedOwnAdr` accepts a new `compAnchor` parameter. The in-band lift is capped at `max(ownAdr, compAnchor)` — upward-only ceiling so we never drop below own.
- Cheap-branch and at-mkt branches short-circuit BEFORE the comp check (preserves Templemore + Castle Buildings 2-bed behaviour exactly).
- Comp anchor extended to two tiers in agent.ts:
  - **Tier 1:** siblings sharing ALL of the listing's `group:` tags (intersection, not union) + same bedrooms + rich-own.
  - **Tier 2 (fallback):** mean rung-1 across all same-tenant + same-bedrooms rich-own listings.
- **The intersection rule (not union) is load-bearing.** Without it, Templemore 3 (1br, tagged only `group:CB + Templemore`) was polluting Castle Buildings 1-bed comps and pulling the cap to £150 — below the £155-171 calibration band. With intersection, CB-1 listings get only true CB peers in the cap pool.

**Calibration outcome (post-fix manual run 2026-05-25, 6,738 cells):**

| Listing | Pre | Post | PL | over% | Cal band |
|---|---|---|---|---|---|
| CB-1 Apt 1 | £170 | **£159** | £139 | +14% | inside £155-171 ✓ |
| CB-1 Apt 4 | £158 | £158 | £159 | -1% | inside ✓ |
| Templemore 1 | £107 | £107 | £93 | +15% | ~£107 ✓ |
| C-315 St Annes | £222 | £182 | £167 | **+33% → +9%** |
| City Gate | £215 | £179 | £168 | **+28% → +7%** |
| Half Bap | £162 | £152 | £135 | **+20% → +13%** |
| Spire (at-mkt) | £196 | £196 | £144 | +36% (unchanged, pattern 2) |
| Sir Thomas (at-mkt) | £171 | £171 | £138 | +24% (unchanged, pattern 2) |

**Hard constraint check:** all Castle Buildings 1-beds inside £155-171; Templemore at £107. No regression on the base-redesign calibration sample. ✓

**Banded distribution:** within ±10% 20.7→21.2%; within ±25% 51.3→52.5%; beyond ±50% 12.1→11.4%. Modest tightening — the residual over-set is pattern 2 (at-market), which the comp-bounded lift can't help and which is documented as out of scope for tonight.

**Verification:** 146 / 146 tests pass (up from 135 — 11 new across the banded helper and the comp-bound). Typecheck + lint clean. Worker restarted on the new code.

**Risks:**
1. **Comp anchor depends on rich-own peers.** A listing with no rich-own siblings at all (newest properties) gets null comp → lift uncapped (existing behaviour). Acceptable; the fix is intentionally conservative.
2. **Tier 2 fallback can drag a true premium listing down.** If a tenant's broader 1-bed pool is mostly budget, a premium 1-bed inside it gets a budget-level cap. Mitigation: the cap is `max(own, comp)` — never drops below own, so the regression scenario is bounded.
3. **Pattern 2 (at-market over-pricing) is NOT fixed.** Spire and Sir Thomas still sit +24-36% over PL because their ownADR is genuinely high vs PL's view. Documented for a separate base-calibration session — possibly a channel-fee diagnostic on the trailing ADR helper.
4. **Group: tag intersection rule treats multiple tags as conjunction.** Listings with multiple tags now need peers matching ALL their tags, which can shrink the Tier 1 pool. Tier 2 fallback catches the case when Tier 1 returns empty.

**Trade-off accepted:** the over-set tail (pattern 2) remains at ~12% beyond ±50% on the report. Not a quick win; deferred deliberately rather than papered over with a non-data-driven cap.

**Affects:** `BUILD-LOG.md` entry "2026-05-25 — Over-base fix (comp-bounded lift) + banded agreement reporting" captures the full Part B decomposition, the calibration table, and the banded before/after. Code commit `77bcbf6`. No customer-facing pricing changed.

**Deploy state at decision time:** local worker restarted on the new code. Commit `77bcbf6` plus the four overnight demand-fix commits remain LOCAL on `unify/main-trial-2026-05-20` — the autonomous shell still cannot push without an interactive keychain prompt. Push commands documented in the BUILD-LOG morning task.

**Status:** active.

---

## 2026-05-26 — Demand + Occupancy redesign: one booking curve, lead-time-controlled

**Owner:** Mark McCracken
**Approved by:** Mark (Phase A checkpoint + Phase C verified-numbers sign-off)
**Authors of work:** Claude (supervised)

**Problem:** two trial signals were both wrong for the same reason — they read raw forward booking data, which is lead-time-contaminated. A date 90 days out has low fill because it's 90 days out, not because demand is soft. The cross-sectional demand signal compared a date's fill to its same-calendar-month peers (which mixed lead times of ~5d vs ~30d as "peers" within a single month). The reverted forward-occupancy-multiplier attempt (commit `6dd7665`) hit the same wall on the occupancy ladder. The fix is one instrument: a booking curve — typical forward fill at each lead time — so each signal is judged against what's normal for a date that far out, not against raw fill.

**Decision:** rebuild demand and occupancy on a per-tenant booking curve, with the following design:

1. **Single booking curve per grain.** Built from own reservation history (395→30 days ago). Lead anchors at 0/7/14/21/28/35/42/56/70/84/98/112/126/154/182/210/238 days. Linear interpolation between anchors. Per-tenant curve always; per-`group:` tag curve when ≥3 listings AND ≥500 observations per lead anchor. Listings resolve to the most-specific group: tag they belong to (smallest sibling pool); fall back to tenant curve when no qualifying group exists.

2. **Demand = own pace vs the curve, at building grain.** Per Mark's Phase-A checkpoint: tenant-grain dilutes building-level events into "neutral." Castle Buildings late-June worked sample: tenant-grain -2% / -13% / -3% (missed) vs building-grain +43% / +47% / +71% (caught). The grain decision is load-bearing. Same demand-multiplier pass-through + clamp + sufficiency-gate + holiday-calendar-fallback as before — only the input changed.

3. **Occupancy = per-listing scarcity in the next 14 days.** `OCCUPANCY_NEAR_TERM_LEAD_DAYS = 14`. Beyond 14d lead, scopeOccupancy returns null → ladder neutral 1.0 (avoids the lead-time-empty problem that sank commit `6dd7665`). Within 14d, raw fill of the listing's next-14-day window feeds the existing ladder unchanged. Lead-time floor's `propertyOccLow` gate uses the same input — floor only engages at ≤14d lead anyway so the change is in-domain.

4. **KeyData signal lead-time fix.** `computeKdCrossSectionalDelta` peers are now same-day-of-week + within ±21 days of target (`KD_PEER_WINDOW_DAYS`), not same-calendar-month. `KD_PEER_MIN_SAMPLE_SIZE = 3` (calibrated for the windowed cohort). Same supply-guard + effective-delta logic.

5. **Low-curve guard at 0.15.** Calibrated 2026-05-26 PM after the first Phase-B run. With guard at 0.05, 91-180d cells (LF curve ~14-20% at those leads) passed through and small absolute deltas inflated demand sharply positive (overall mean Δ on 91-180d flipped from -1.2% baseline to +12.6% over). 0.15 returns near neutral on 91-180d cells (where the curve is shallowest) while preserving the signal on 0-90d cells where curve values sit comfortably above the threshold.

6. **No double-count.** Demand fires at ALL lead times (date-level signal at grain). Occupancy fires only at ≤14d lead (per-listing scarcity). Far-out cells: only demand. Near-term cells: both, measuring distinct things (date-level vs listing-level remaining inventory). Multiplicative combination is fine.

**Verification numbers (quoted from the report file `keydata-comparison-2026-05-26.html`):**

| | baseline 2026-05-25 | redesign + guard 0.15 |
|---|---|---|
| within ±10% (overall) | 23.1% | 20.0% |
| within ±25% | 54.0% | 51.6% |
| beyond ±50% | 11.9% | 12.6% |
| 91-180d mean Δ vs PL | -1.2% | +2.2% |
| 181-270d mean Δ vs PL | +9.3% | +8.4% |
| LF cells / ±10% / mean Δ | 3537 / 23.4% / -2.8% | 3542 / 17.8% / -4.7% |
| SB cells / ±10% / mean Δ | 3201 / 22.7% / +4.4% | 3207 / 22.4% / +2.4% |

The cell-level signal works as designed — Castle Buildings 25 June Thu (genuinely soft, 2/9 booked vs CB curve 53.5%) gets demand floor 0.92 (was 0.949); 26 June Fri (busy, 7/9 booked vs 52.8%) gets +47% pace_delta → demand 1.171 (was 1.250); 24 June Wed gets demand 1.152 (was 1.035). The reasoning string `n=9, peerMed=53.5%` confirms building-grain.

Within-±10% headline dropped -3.1pp vs baseline. Mark's call: this is the redesign correctly diverging from PriceLabs, not a bug — do not chase it. SB is essentially back to baseline; LF is genuinely more conservative with the curve-aware demand.

**Risks:**
1. **LF -5.6pp on within-±10%.** The redesign is more confident that LF cells should price below PL in many forward windows. Whether that's right depends on whether PL is the right baseline; the trial decision (2026-06-01) is the rendezvous point.
2. **The 50/50 own/KD blend dilutes strong building-grain signals.** A +47% own pace at CB-1 Apt 5 26 June gets halved to +24% after blending with KD's +1.6%. Spec said "own leads, KD corroborates" but did not specify a new weight; left at 50/50 per the existing constant. Easy follow-up.
3. **`computeOwnCrossSectionalDelta` + `loadPortfolioForwardFill` left in cross-sectional-demand.ts** but no longer called from the agent hot loop. Backwards-compat for existing tests. Could be removed in a follow-up clean-up.
4. **Holiday calendar fallback path still works** but is now wired against pace-null events (low-curve-guard firing OR no curve at all), not the prior cross-sectional sufficiency-gate. Behavior verified equivalent in tests.

**Affects:** `BUILD-LOG.md` entry "2026-05-26 — Demand + Occupancy Redesign: One Booking Curve" captures the Phase-A worked sample, the per-listing decomposition, the guard calibration story, and the verification numbers. Code commit: see below.

**Deploy state at decision time:** local pricing-comparison worker restarted on the new code. Commit pushed to all three branches (`main`, `keydata-trial-overnight-2026-04-28`, `unify/main-trial-2026-05-20`) — gh CLI credential helper still working from the 2026-05-25 setup.

**Status:** active.

## 2026-05-27 PM — Internal demand + DoW multiplier floors REMOVED (`DEMAND_FLOOR` 0.80 → 0; `DOW_FLOOR` 0.75 → 0)

**Decided by:** Mark (resumed in a fresh thread after the demand-signal consolidation deploy).

**What:** Two outer artefact-guard floors in the trial pricing chain set to 0 (effectively removed):
- `DEMAND_FLOOR` in `src/lib/pricing/trial-pricing.ts`: 0.80 → **0**.
- `DOW_FLOOR` in `src/lib/pricing/trial-pricing.ts` (the downstream blend-time clamp on `blendDayOfWeek`): 0.75 → **0**.

Mark's stated principle: the customer-facing safety against undesirable rate descent is the per-listing `minimumPriceOverride` (production-side rate-push setting, untouched), which clamps the final daily rate. Multiplier-level floors inside the engine were redundant artefact guards.

The just-shipped KD 48h fallback (`keydata-fallback.ts`) covers outage-class KD glitches — a real KD outage now reads last-known-good for up to 48h before falling back to neutral 1.0; in-band KD noise on a real day is intentionally allowed to produce a low demand multiplier, with the per-listing minimum being the right place to truncate downside.

**Explicitly OUT of scope (not changed):**
- `DEMAND_CEIL` (1.40) and `DOW_CEIL` (1.50) — ceilings kept. Mark elected floors-only treatment; ceilings stay as upper artefact guards.
- Lead-time floor (`computeLeadTimeFloor`) — different mechanism (last-minute-discount cap), kept.
- Daily-rate outer caps (`NORMAL_NIGHT_RATE_MULTIPLE` 4.0×, `EVENT_NIGHT_RATE_MULTIPLE` 5.0×) — outer chain caps, not multiplier floors; untouched.
- `SEASONALITY_FLOOR` (0.75) — different multiplier, not in Mark's "all floors" scope.
- The upstream `DOW_LEARNED_MIN/MAX` clamp in `dow-multiplier.ts` (which bounds the LEARNED per-tenant DoW table BEFORE it reaches `blendDayOfWeek`) — untouched.
- Per-listing `minimumPriceOverride` (production-side) — never touched; it IS the customer-facing safety this change relies on.

**Why:** Standing principle, repeated across multiple specs today: "engine constants are outer guards; the per-listing min/max-price override is the customer-facing safety." Today's earlier cap-widening verification flagged the demand floor as the dominant binding constraint (52.2% of 31-90d trough cells pinned at the 0.80 floor on the post-AM-ship report — engine was being held UP by the artefact guard). Lowering 0.92 → 0.80 partially addressed this; full removal is the logical endpoint.

**Implementation:**
- `DEMAND_FLOOR = 0` and `DOW_FLOOR = 0` (constants kept so existing `clamp(raw, FLOOR, CEIL)` call sites and `floorHit` reporting in the breakdown shape continue to work; with floor=0 and `raw` always positive, the clamp only enforces the ceiling and `floorHit` becomes effectively dead — always false in normal operation).
- Test assertions updated for the new behaviour: `KD -50% raw → 0.50 unclamped` (was `0.80`, `floorHit=true`); `Christmas calendar -25% → 0.75 unclamped` (was `0.80`, `floorHit=true`); comment in the integration test updated.
- Trial chain math unchanged structurally; only the lower clamp moved.

**Tests:** `node --import tsx --test src/lib/pricing/trial-pricing.test.ts` → **48/48 pass**. (Four `keydata-fallback.test.ts` failures observed are pre-existing and unrelated — hardcoded absolute path `/Users/markmccracken/Documents/signals/.claude/worktrees/.../cache/keydata-fallback` in `FALLBACK_DIR` breaks the test outside Mark's exact machine. Flagged separately; should be made env-overridable before relying on the cache in production.)

**Affects:**
- `src/lib/pricing/trial-pricing.ts` — `DEMAND_FLOOR`, `DOW_FLOOR`, surrounding comment blocks.
- `src/lib/pricing/trial-pricing.test.ts` — two assertion updates + comment cleanups.
- `pricing-report-assembly.ts` (production path), `market-anchor.ts`, the events helper, the trial events source — **all untouched.** Customer-facing prices on non-trial paths unchanged.

**Order vs other open tasks:** Mark picked floors-first; the Fleadh peer-set fix (Aug 8 mispriced at 0.913 in daily trial reports) is the next one to action after this lands.

**Verification asks (deferred to the trial reporting run):**
- For each cell previously pinned at the 0.80 floor (52.2% of 31-90d trough cells on today's post-AM-ship report), quote the new demand multiplier and confirm where it lands naturally.
- Identify cells whose new multiplier is < 0.70 with per-cell reasoning — these are the cells the floor was masking and where signal quality may need a closer look.
- Confirm Aug 22 Sat (1.357 post-consolidation) is unchanged — ceiling/floor on that cell should be untouched.
- Per-tenant within-±10% + mean Δ + banded distribution before/after, as standard.

**Deploy state at decision time:** code change applied **locally** in the worktree at `unify/main-trial-2026-05-20`. **Not yet committed, pushed, or deployed.** Per the deploy-confirmation rule, Mark to confirm deploy vs keep-local in the next message; deploy steps will be provided in copy-paste form when confirmed.

**Status:** active (local-only pending Mark's deploy confirmation).

## 2026-05-27 PM (later) — Fleadh peer-set fix + trial-report aggregation fix

**Decided by:** Mark (continuing the same-day sequence after floor-removal verification surfaced two distinct defects).

**What — two coordinated fixes in one ship:**

### Fix 1: Cross-sectional peer-set "whole-period elevation blind spot"

In `src/lib/agents/pricing-comparison/cross-sectional-demand.ts`, two mechanisms added to `computeKdCrossSectionalDelta`:

(a) **Adaptive peer-window widening.** When the ±21d `KD_PEER_WINDOW_DAYS` first-pass yields `supplyDelta ≤ SUPPLY_GUARD_CONTRACTION_THRESHOLD (-0.20)` — the event-week supply-tightening shape — the function recomputes deltas at `KD_PEER_WINDOW_WIDE_DAYS = 60` (new exported constant). Defensive fallback to narrow if widening gives fewer peers. New `peerWindowWidened: boolean` diagnostic surfaced on the result.

(b) **Booking-window escape valve.** Asymmetric override on top of the existing positive-only corroborator. New constant `BOOKING_WINDOW_ESCAPE_GATE = 0.30`. Fires when `revparDelta ≤ 0` AND `bookingWindowDelta > 0.30`. Bonus computed by the same `min(BOOKING_WINDOW_BONUS_CAP=0.10, bw × 0.5)` formula as the corroborator. Mutually exclusive with the corroborator (different primary-sign branches). New `bookingWindowEscapeFired: boolean` diagnostic.

Order of operations:
1. ±21d primary delta computation.
2. If `supplyDelta_local ≤ -0.20` → recompute at ±60d (adopt if peer count holds).
3. Booking-window corroborator on positive primary.
4. Booking-window escape on non-positive primary + bw > 0.30 (mutually exclusive with step 3).
5. Supply guard damping (existing logic, unchanged).

### Fix 2: Trial-report aggregation bug

`pricing_comparison_snapshots` is append-only (no `runId`, no upsert key on the tuple). Each `npx tsx scripts/run-comparison.ts` rerun inserts a new row per `(tenantId, listingId, targetDate, snapshotDate)`. Today's verification surfaced this when the floor-hit % aggregated 30.4% across-all-runs vs 0% on the latest run alone.

New shared helper `src/lib/agents/pricing-comparison/snapshot-dedup.ts` → `dedupSnapshotRows<T>(rows: T[])` keeps only the latest `createdAt` per tuple. Applied at all four `pricing_comparison_snapshots` read sites that aggregate for the report path:
1. `report-html.ts:renderStructuralMissesSection` (7-day lookback).
2. `report-html.ts:renderTroughDiagnosticSection` (31-90d trough).
3. `report-html.ts` per-tenant detail loop (banded distribution + DoW + divergence-cause).
4. `summary-email.ts:loadAllSnapshots` (trial summary email).

Each site now selects `createdAt` and pipes the rows through `dedupSnapshotRows` before processing. The schema-level fix (add `runId` or `@@unique` on the tuple) is a bigger spec — flagged for after the trial decision date.

**Why:** Fleadh Aug 8 Sat 2026 was mispriced at multiplier 0.913 (adr_unbookedΔ -8.7%) post-events-lever-removal because its ±21d same-DoW peers (Jul 25 / Aug 1 / Aug 15 / Aug 22 / Aug 29) are themselves Fleadh-contaminated — three of them sit inside the Fleadh window. The trial-report bug separately produced 30.4% floor-hit on a metric that should have read 0% post-floor-removal because manual reruns blended pre- and post-removal rows.

**Implementation:** Additive only. No existing constants changed. New constants: `KD_PEER_WINDOW_WIDE_DAYS = 60`, `BOOKING_WINDOW_ESCAPE_GATE = 0.30`. New diagnostic fields on `KdCrossSectionalDelta`: `peerWindowWidened`, `bookingWindowEscapeFired`. New module `snapshot-dedup.ts`. Four sites in `report-html.ts` + `summary-email.ts` updated.

**Tests:** Full suite **222 / 222 pass** (was 206 pre-fix; net +16: 8 new in `cross-sectional-demand.test.ts` for adaptive widening + escape valve + pre-existing test patched for new escape semantics, 7 new in `snapshot-dedup.test.ts`, 1 net across miscellaneous). `npm run typecheck` and `npm run lint` clean.

**Explicitly OUT of scope:** Rolling the events lever back in (Mark's data-led principle stands). YoY peer anchors. Broadening peer set beyond same-DoW. Schema-level `runId` column. Production rate-push path (`market-anchor.ts`, `rate-copy-push-service.ts`, `pricing-report-assembly.ts`, `manual-override.ts`) — untouched.

**Verification targets** (per spec, to be confirmed on post-deploy run):
- Aug 8 Sat 2026 demand multiplier ≥ 1.20 (was 0.913).
- Aug 9 Sun 2026 ≥ 1.10 (was 0.808).
- Aug 7 Fri 2026 stays ≥ 1.167 (no regression).
- Aug 22 Sat 2026 stays at 1.357 (no regression).
- 5 non-event Saturdays within ±2pp of pre-fix multipliers.
- Report-aggregation self-correcting: trough floor-hit % matches latest-run-only metric (0% post-floor-removal) without the manual `createdAt` filter we needed yesterday.

**Affects:**
- `src/lib/agents/pricing-comparison/cross-sectional-demand.ts` + matching `.test.ts`.
- `src/lib/agents/pricing-comparison/snapshot-dedup.ts` (new) + `.test.ts`.
- `src/lib/agents/pricing-comparison/report-html.ts` (3 query sites).
- `src/lib/agents/pricing-comparison/summary-email.ts` (1 query site).
- `package.json` (test runner script: new test file added).

**Deploy state at decision time:** **shipping now** (per Mark's go-ahead in the spec). Single commit, push to all three branches, restart local pricing-comparison worker, manual run for verification.

**Status:** active (shipping).

## 2026-06-01 — Signals rate scanner (read-only situation→change→outcome dataset)

**Decided by:** Mark (build prompt + `SIGNALS-RATE-SCAN-SPEC.md`).

**What:** A twice-daily (07:00 + 12:00 Europe/London) scanner that records how live Hostaway rates move — price, min-stay, availability — into a growing `{situation → change → outcome}` dataset, then attributes bookings made within 48h of a change to that change. Four new tables (RateScan, RateState, RateChange, BookingRateContext), all with `tenantId` + `@@index([tenantId, ...])`. New `src/lib/signals/` modules (config, baseline, scan-service, attribution, summary), a new `rate-scan` BullMQ queue, a new `rate-scan-worker.ts`, and a key-gated read-only `GET /api/signals/monthly-summary` route.

**Why:** Build an outcome-labelled dataset of pricing-lever moves so future recommendations can be validated against what actually converted, without waiting on the KeyData decision or touching the customer-facing pricing path.

**Implementation:** **Additive only, fully read-only w.r.t. the rest of the tool.** Rates are fetched via `getHostawayGatewayForTenant(tenantId).fetchCalendarRates(...)` — a pure GET. The scanner does **not** call `runCalendarSyncForListing` (which writes the shared `CalendarRate` table); it diffs in-memory against its own `RateState`. Writes go **only** to the four new tables, every query filters by `tenantId`, and the new worker/queue are isolated from all existing queues. `run-all-workers.ts` and `queues.ts` got purely additive blocks; no existing line was modified.

**Rate-copy exclusion (spec §4 step 2):** before scanning, every listing involved in rate-copy — **both** the `rate_copy` targets (a property-scope `PricingSetting`'s `scopeRef`) **and** the sources they copy from (`rateCopySourceListingId`) — is filtered out. Their rates are driven by push / an external tool, not Mark's instinct, so recording them is noise; they stay untouched. A pure helper `collectRateCopyExclusionIds` (read-only SELECT on `PricingSetting`, parsed via `parsePricingSettingsOverride`) builds the set; it deliberately does **not** gate on `rateCopyPushEnabled` (a rate_copy target is noise whether or not push is live). The scan logs the excluded count and returns it on `RateScanResult`.

**Audit-flag decision:** `scripts/audit-tenant-isolation.ts` (a static, non-required check) flags the new route for having no auth context. This is **by design** — the route is gated by `?key=SIGNALS_SUMMARY_KEY` and returns 404 when the env var is unset or mismatched. Per spec §2.1.6 (flag, don't touch out-of-scope files) the audit script was left untouched. The required `npm run test:tenant-isolation` passes. One-line opt-in for Mark if he wants the audit clean: add `"signals/monthly-summary"` to `PUBLIC_ROUTES` in that script.

**Tests:** New `src/lib/signals/*.test.ts` (36 tests, incl. 4 for the rate-copy exclusion helper — target+source both excluded, non-rate_copy ignored, target-only when no source, and listings filtered out before scanning) wired into `npm run test:signals`, all green. `npm run typecheck`, `npm run lint`, and `npm run test:tenant-isolation` all clean. `git diff --stat` on tracked files = 167 insertions / 0 deletions across the five additively-modified files; everything else is new untracked files.

**Explicitly OUT of scope:** Change-source tracking (manual vs automated lever moves — deliberately omitted). Any write to an existing table (CalendarRate, Reservation, NightFact, PricingSetting). Any Hostaway push/PUT. The customer-facing pricing path, AirROI, and Hostaway public-API/webhook code. `SIGNALS_SUMMARY_KEY` is read in exactly one place (the route) and nowhere else.

**Affects (all additive):**
- `prisma/schema.prisma` (+4 models, +7 relation fields) + migration `20260601120000_add_signals_rate_scan`.
- `src/lib/signals/{config,baseline,scan-service,attribution,summary}.ts` (new) + `*.test.ts`.
- `src/lib/queue/queues.ts` (new `rate-scan` queue + two schedule helpers).
- `src/workers/rate-scan-worker.ts` (new) + additive wire-in to `src/workers/run-all-workers.ts`.
- `app/api/signals/monthly-summary/route.ts` (new, key-gated, SELECT-only).
- `.env.example` (`SIGNALS_SUMMARY_KEY=`, disabled by default), `package.json` (`test:signals`).

**Deploy state at decision time:** **local only — not committed, pushed, or deployed** (per the build prompt's explicit "do NOT deploy or push"). Migration is generated but not applied to any DB. Worker restart + `SIGNALS_SUMMARY_KEY` setting are morning tasks for Mark.

**Status:** active (local-only, built + green, pending Mark's deploy decision).

## 2026-06-02 — Rate-copy push cadence 1×/day → 5×/day (BUILT + GREEN, NOT DEPLOYED — env mismatch)

**Decided by:** Mark (overnight prompt `SIGNALS-RATE-COPY-5X-CLAUDE-CODE-PROMPT.md`) + Claude Code.

**What:** The rate-copy queue's two repeatable jobs now fire 5× a day instead of once. Source-sync cron `0 10 * * *` → `0 6,10,14,18,22 * * *`; push cron `30 10 * * *` → `30 6,10,14,18,22 * * *` (both Europe/London). One repeatable per kind on a 5-slot cron — NOT five jobs. Pull at 06/10/14/18/22:00, push 30 min after each. No pricing-logic change — the source-derived value is pushed as-is (no new floor); the higher frequency is the entire fix.

**Why:** On the night of 2026-06-01 the PriceLabs-driven source listing moved (a promo overlapped some days) and our derived price updated, but the once-a-day push left the live target listings stale and cheap bookings landed before the next push. 5×/day caps staleness at ~4h.

**Correctness trap fixed:** BullMQ keys a repeatable by name + pattern + tz, so changing only the cron pattern ADDS a second repeatable rather than replacing the old one — the old 10:00/10:30 (and the earlier 06:30) jobs would keep firing in parallel. `ensureSchedulesForActiveTenants` now enumerates `getRepeatableJobs()` and `removeRepeatableByKey()` for each BEFORE re-adding the desired two, so the queue ends in a known-good state on every worker boot (only rate-copy repeatables live on this queue, so prune-all-then-re-add is safe).

**Scope unchanged:** push still targets every property-scope PricingSetting with `pricingMode==="rate_copy"` AND `rateCopyPushEnabled===true`. No widening.

**Tests:** new `src/workers/rate-copy-push-worker.test.ts` (3 tests, mocking the queue + an in-memory repeatable store keyed by name+pattern+tz): asserts the push cron, the source-sync cron, and that after `ensureSchedulesForActiveTenants` runs against a fake 2-tenant set with stale 10:00/10:30/06:30 repeatables seeded, the queue holds EXACTLY the two 5-slot repeatables per tenant and no leftovers. Wired as `npm run test:rate-copy-schedule`. Full gate green: `typecheck`, `lint` (--max-warnings=0), `test:tenant-isolation`, the new schedule test (3/3), plus regression: push-service (6/6) and pricing-anchors (222/222).

**Files (comments-only except cron + cleanup + test):** `src/lib/queue/queues.ts` (two patterns + block/doc comments), `src/workers/rate-copy-push-worker.ts` (cleanup + comment + boot-log + `export`), `src/lib/pricing/rate-copy.ts`, `src/lib/pricing/rate-copy-push-service.ts`, `src/workers/run-all-workers.ts`, `app/api/pricing/rate-copy/push-now/route.ts` (header comments), `app/components/rate-copy-settings.tsx` (two UI strings), `package.json` (test script). Did NOT touch `src/lib/hostaway/**`, AirROI, cancelled-pace, or trial-events. No price floor / occupancy / anchor change.

**Deploy state: BUILT + FULLY GREEN, but NOT DEPLOYED and NOT pushed — DELIBERATELY HELD.** The prompt authorised full auto-deploy to `main` conditional on (a) §3 green and (b) the deploy mechanism it described: a launchd worker `com.signals.hostaway-analytics-mvp.worker` in a live tree at `/Users/markmccracken/Documents/hostaway-analytics-mvp`, restarted via `launchctl kickstart`. §3 is green, but that mechanism DOES NOT EXIST on this machine:
- No launchd service by that label is loaded; no plist for it on disk.
- `/Users/markmccracken/Documents/hostaway-analytics-mvp` is an empty stale folder (only an April `.next-dev` cache; no `package.json`; not a git repo).
- No worker/web/node process was running; dev Postgres + Redis (Docker) were stopped (exited at the ~6h-ago boot, no restart policy). I started them only to run `test:tenant-isolation`.
- The dev checkout `/Users/markmccracken/Documents/signals` is the only real git repo (on `main`, tracking `github.com/Markroomyrevenue/Signals`). Real production is almost certainly Railway (per [[reference-local-vs-railway]] + BUILD-LOG "Railway has been deploying main").

Because the deploy chain's steps 2-5 (pull into the live tree, restart the launchd worker, inspect Redis repeatables, state next-fire-times, fire the gap-closing manual push) are impossible here AND unverifiable — which the prompt itself calls "the part that matters" — pushing to `main` blind would be an unverifiable, partial production change (e.g. web redeploys but the worker keeps the old cron until restarted; the cleanup only runs on worker boot). Per CLAUDE.md's local-vs-live rule and the "surface a contradicted premise rather than proceed" principle, I committed to branch `feat/rate-copy-5x-daily-schedule` (NOT main) and left a one-action TO-DEPLOY block for Mark.

**Affects:** `BUILD-LOG.md` entry "2026-06-02 — Rate-copy 5×/day" (full detail + exact deploy steps). `CLAUDE.md` unchanged (it doesn't pin the rate-copy time — checked).

**Status:** active (branch `feat/rate-copy-5x-daily-schedule`, built + fully green, NOT deployed; awaiting Mark's deploy via the real prod mechanism).

## 2026-06-08 — KeyData trial closed; branches reconciled onto main; main is the single source of truth and deploy branch; monthly-summary 500 fixed

**Decided by:** Mark (prompt `CONSOLIDATE-TO-MAIN-CLAUDE-CODE-PROMPT.md`) + Claude Code.

**What:**
1. **Monthly-summary bind-param 500 fixed.** `src/lib/signals/summary.ts` — the converted-changes lookup (`prisma.bookingRateContext.findMany`) was a single `rateChangeId: { in: changeIds }` query. For a tenant logging >32.7k rate changes in a month it crashed with "too many bind variables" because Postgres caps a statement at 32767 bind parameters and `tenantId + ids` exceeded it. Now chunked at 1000 ids per batch (well under cap) and union-merged into the converted-id set. Pure shape change; tenant scoping unchanged (`where: { tenantId, rateChangeId: { in: chunk } }` per call). Commit `96e6373`.
2. **`unify/main-trial-2026-05-20` cherry-picked.** Only commit not on main was `b5d6c70 trial: snapshot script + keep running until KD endpoints die` — additive trial-archive tooling (`scripts/snapshot-trial-final.ts`, `scripts/worker-supervised.sh`, KD-dead detection in `keydata-provider.ts`). Cherry-picked as `2ab0ed9`. No runtime / pricing impact.
3. **`main` is now the canonical source of truth and the deploy branch.** The KeyData pricing trial branch `keydata-trial-overnight-2026-04-28` was already fully merged into main (0 unique commits) and the trial itself ended 2026-06-01. All `feature/*`, `feat/*`, `claude/*`, `review/*` branches were fully merged (0 unique commits). `hotfix/sync-stale-cleanup-2026-05-20`'s logical fix (`STALE_RUNNING_SYNC_GLOBAL_THRESHOLD_MS` + cross-tenant cleanup at `src/lib/sync/engine.ts:47,77,113`) is already on main via a different commit path; the hotfix branch is a stale snapshot that diverged earlier and never landed cleanly. Branches pruned from origin + locally (where not held by an active worktree); list in commit message + Claude Code report. Future work goes on main (or a feature branch off main, merged via PR back to main). No branch is ever "the deploy branch" except main.

**Why:** Without consolidation, future sessions and Railway alike could pin the wrong branch as deploy target. The KeyData trial ran on `keydata-trial-overnight-2026-04-28` and `unify/main-trial-2026-05-20`, but those were stop-gaps during a trial that's now over. Multiple long-lived parallel branches create the deploy-state confusion CLAUDE.md's "Local vs live" rule was written to prevent.

**Gate state at consolidation:** `npm run typecheck` green, `npm run lint -- --max-warnings=0` green, `npm run test:signals` green (36/36 incl. the chunking-fix's monthly-summary-route tests). `npm run test:tenant-isolation` was NOT run — Docker Desktop wasn't up and the script needs local Postgres; the chunking fix is a pure shape change in the existing tenant-scoped `where` clause, no new isolation surface introduced.

**Manual deploy steps required (Mark's job — Railway):**
1. In Railway service settings, confirm the deploy branch is `main` (was likely already; flip explicitly if not). Pushes to `main` should auto-deploy.
2. After redeploy lands, restart the background workers (sync, pricing-comparison, rate-copy-push) so they pick up new code — workers started before the deploy keep running stale code until restarted.
3. Verify the fix by opening `/api/signals/monthly-summary?key=…` and confirming a 200 JSON response (was returning 500 for tenants over the 32.7k-row threshold).

**Out of scope (untouched):** pricing logic, `src/lib/pricing/**` (including floors, `trial-events.ts`, `market-anchor.ts`), AirROI (still disabled per [[feedback-airroi-disabled]]), `src/lib/hostaway/**`. This task was branch consolidation + one bug fix only.

**Status:** SHIPPED to main, awaiting Mark's Railway deploy-branch confirmation + worker restart.

---

## 2026-06-29 — Metric & UI trust audit + fixes shipped live

Full independent audit of every page/metric (Calendar excluded from metric/UI scope),
reconciled against the live Hostaway API + raw DB for all 5 live tenants. Mark chose
**checkpoint-before-deploy**, reviewed the customer-facing changes, then approved deploy.

Decisions made (Mark):
- **Multi-unit occupancy/RevPAR: fix now.** Scale the inventory denominator by `unit_count`
  and stop the floor/clamp that masked overflow. Little Feather occupancy 75% → ~28%, RevPAR
  ~3× lower — the honest figure; only LF affected. Revenue/ADR/nights unchanged.
- **Occupancy lifecycle-gating: gate to each listing's first booked night** (the default view
  previously counted pre-onboarding days). Raises single-unit tenants' occupancy (e.g. Yo's
  54%→75%).
- **Signal Lab: retired.** Its second (registry) engine produced impossible numbers (occupancy
  >100%) that disagreed with the main tabs; it was already off-nav. Bulletproof-hidden; dead
  code left for a follow-up deletion.
- **Date-preset expansion: deferred** — needs per-tab wiring + a placement decision (forward
  presets belong on Pace/Sales, not the booking-date filter). Picker left untouched (no
  regression). Design retained in AUDIT-UI.md.

Confirmed CORRECT (no change): stay revenue, ADR, occupied nights, booked revenue, cancellation
rate, avg LOS, YoY/pace ADR, cancelled-at-cutoff inclusion, multi-room reservation ADR, tenant
isolation. Mark's #1 suspicion (multi-room ADR inflation) was disproved.

Shipped live 2026-06-29 (prod `f90f50d`, rollback `backup/prod-live`=`82841b3`). Open items:
rotate old AIRROI_API_KEY; confirm Alma Place room count; wire date presets; optional unset of
dead AIRROI_* Railway vars. Full report: AUDIT-REPORT.md.

---

## 2026-06-29 (later) — INDEPENDENT post-audit review: verdict SHIP-SAFE

Fresh-session adversarial review of the metric & UI audit above, with a **second,
independent reconciliation harness** (`scripts/review2/`, different logic from
`scripts/audit/`). Calendar excluded per brief. Read-only against prod; **nothing
deployed or changed** (no code fix was needed).

**Verdict: SHIP-SAFE.** Independently confirmed:
- **Live health:** web `Signals` + worker `signals-worker` BOTH on `b6d31c2`, deployed
  21:42:51, SUCCESS/Online; migrations 21/21 applied; rollback tag `backup/prod-live`=`82841b3`.
- **Metrics reconcile to the penny** (≤£0.02 FX) for all 5 tenants — nights, revenue, ADR,
  inventory, occupancy, RevPAR. **Little Feather live occupancy = 20.46%, RevPAR = £22.96**
  (14,176 occupied unit-nights ÷ 69,302; no clamp/double-count). NightFact not stale (0
  mismatches). The second harness initially "disagreed" only because of a bug in *my own*
  recompute (counted removed listings); the app's `removed_at` exclusion is correct.
- **Mark's 7 issues:** #1 multi-unit ADR not skewed ✔ (per-room reservations, Alma £54/Edge
  £75 median, peak concurrency ≤ unit_count); #2 drilldown ADR-vs-LY ✔ (code + null→"—" +
  YoY to the penny + confirmed live on May 2026); #4 business-review export ✔ (independent
  5-page PDF: running headers + Page X/Y); #6 headlines reconcile ✔; #7 Hostaway note holds ✔
  (vs freshly-synced raw_json); **#5 date presets ✗ deferred, not delivered**; #3 UI overlap
  ✔ desktop / mobile-tablet UNVERIFIED (tooling pinned to desktop width).
- **Green gate independently green:** typecheck/lint/tenant-iso/build all EXIT 0;
  pricing-anchors 225/0, signals 36/0, observe clean. Tenant isolation: every guarded-model
  query is tenant-scoped (one intentional key-gated admin metadata read, no booking data).

**Findings (non-blocking):**
1. **Docs stale.** `AUDIT-REPORT.md`/`AUDIT-ROLLBACK.md`/the entry above say prod=`f90f50d`,
   LF occ ~28%. Reality: prod=`b6d31c2`, LF occ **20.46%**. Two post-report commits
   auto-deployed after the "checkpoint-before-deploy" approval: `8564c35` (unit_count from
   Hostaway `listingUnits[]` — Alma 20→50, Edge 100→150; independently verified correct, 0
   mismatches across all active listings) and `b6d31c2` (dashboard UI; reviewed, UI-only,
   safe). Both correct, but undocumented and `8564c35` moved a customer-facing number after
   sign-off — confirm they were intended.
2. **Latent:** `resolveOccupancyPercent` still clamps to 100%; not biting today (all reconcile)
   but would mask a future numerator>denominator data error.
3. **"Create Business Review" CTA** gave no visible feedback when clicked live (export engine
   verified correct; likely capture-step UX nit). Mobile/tablet layout unverified.

Full report: `AUDIT-INDEPENDENT-REVIEW.md`. Harness: `scripts/review2/`.

## 2026-06-30 — Calendar: released-stock occupancy + hourly delta push + individual scope (SHIPPED LIVE)

**Decided by:** Mark (prompt `Calendar Tab: Occupancy + Group-Scope + Hourly-Push`,
supervised same-day run; grouping + deploy approved at the gate) + Claude Code.

**Reality correction:** "The Edge = ~150 individual listings gated out of occupancy
pricing" was stale. The Edge/Alma are **3 multi-unit Hostaway listings** (515526 Edge
150u, 514009 Alma studios 50u, 554857 Alma 6-bed 6u), all already live + on the push
allowlist + pushing via **`rate-copy.ts`** (source PriceLabs rate × multi-unit
occupancy matrix × min floor), NOT `pricing-report-assembly.ts`. They priced
per-listing (occupancyScope=group was set but the push path ignored it).

**Shipped (commit `4d25490`, prod was `2abcb9c`):**
1. **Fix 2 — released-stock occupancy denominator.** `multi-unit-occupancy.ts`:
   denominator = booked + `availableUnitsToSell` (Hostaway calendar `rawJson`), per
   date, with static `unit_count` fallback. Cell gains `unitsDenominator` +
   `denominatorBasis` (released/static/mixed). Verified: 100% released basis on all 3
   LF listings (fallback never fired).
2. **Fix 1 — group-scope pooling incl. single-unit members** (`poolSingleUnitMembers`);
   the rate-copy push service pools group members when `occupancyScope==="group"` and
   drops the `unitCount>=2` gate for them. **Chosen grouping: individual** —
   `occupancyScope` set to `property` on the 3 listings so each prices on its OWN
   released stock (no cross-contamination; the £300 6-bed no longer dragged by the £50
   studios). Pooling capability stays built; flip back to `group` to pool (they still
   share `group:Student Accomodation`).
3. **Fix 3 — hourly delta push.** Rate-copy worker 5×/day → HOURLY (source-sync :00,
   push :30, Europe/London) for every push-toggled listing; **delta-only** (push only
   changed dates); per-cycle cap (400) + structured cycle log; allowlist intact. Stale
   5×/day crons pruned on boot.
4. **Fix 4 — calendar truthfulness.** Cell shows booked ÷ released-denominator, basis
   tooltip, `*` on static-fallback dates.

**Verified live:** delta push pushed 30/3/2 changed dates (not 366), Hostaway
verify-after-push `success`; read-back matched recompute to the pound (Edge 07-04
£112). Min-floor never breached (`belowFloor=0`); matrix-bounded. Green gate fully
green; tenant-isolation passed; both web + worker on new code; hourly schedule
registered.

**Allowlist:** unchanged — `513515, 514009, 515526, 554857` (the 3 were already on it;
NO widening). NB: the live allowlist already had 4 ids, not just 513515 as older memory
claimed.

**No schema migration** (code + one settings value). **audit harness:**
`npm run audit:occupancy`. **Rollback:** `backup/prod-live`=`2abcb9c`; rate snapshot
`CALENDAR-PUSHED-RATES-SNAPSHOT-2026-06-30.json`; scope revert to `group`. Full report:
`CALENDAR-AUDIT-REPORT.md`.

**Status:** SHIPPED + verified live.

## 2026-06-30 (follow-up) — Per-property 3-way occupancy scope + dead filter + label fixes (SHIPPED LIVE)

**Decided by:** Mark (same-session follow-up) + Claude Code. Prod `8325205` → `09cb647`.

1. **Per-property occupancy scope is now a real 3-way choice** — Portfolio / Group /
   Individual — in the calendar Occupancy section. **Bugfix:** `calendar-utils.ts`
   `normalizeCalendarSettingsForm` silently coerced `occupancyScope` to `portfolio`-or-
   `group`, so "Individual" (property) could never save — that's why a grouped listing
   couldn't price on its own occupancy without leaving the group. Scope is now
   **independent of the view-group**: a listing stays in a `group:` tag for
   filtering/viewing yet can price Individual. Engine: the rate-copy push path honours
   all three (portfolio pools the whole tenant into one released-stock denominator;
   group pools the group; property = own released stock). No current rate change (the
   3 LF listings are already Individual/property).
2. **Removed the dead calendar group filter** — the "All properties" pricing-group
   select set a focus banner but never filtered the grid. Kept the working "Filter
   calendar by group or tag" dropdown (filters visible rows).
3. **Push-frequency labels** 5×/day → hourly (rate-copy settings UI + dev comments).

Green gate green (typecheck/lint/tenant-iso/build; pricing-anchors 235/235). UI +
dormant-engine only — no schema migration, no pushed-rate change. Both web + worker
redeployed; worker re-registered the hourly schedule.

**Status:** SHIPPED live.
