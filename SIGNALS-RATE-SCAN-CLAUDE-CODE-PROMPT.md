# Copy-paste prompt for Claude Code

One self-contained prompt that builds the whole rate scanner, including the
rate-copy exclusion. Paste everything inside the box into Claude Code from the
`signals` project root, on `main`. (If a prior session already built part of
this, Claude Code will reconcile what exists to match the spec.)

---

```
Build the Signals rate scanner exactly as described in SIGNALS-RATE-SCAN-SPEC.md
at the repo root — read it IN FULL first (especially §2.1 Read-only / isolation
rules and §4 step 2 rate-copy exclusion), then read CLAUDE.md (multi-tenant
isolation + "always confirm deployment"). If some of this already exists from an
earlier session, reconcile it to match the spec rather than duplicating.

WHAT IT IS: a twice-daily (07:00 + 12:00 Europe/London) scanner that records how
live Hostaway rates move (price, minimum-stay, open/close) into its own tables,
and links any booking that lands within 48h of a change on the same stay-date.
The point is to build a teachable {change → outcome} dataset of Mark's pricing
instinct.

ABSOLUTE REQUIREMENT — READ-ONLY AND FULLY ISOLATED. This feature must not
change the behaviour of any existing part of the tool:
- It writes ONLY to its four new tables (rate_scans, rate_states, rate_changes,
  booking_rate_contexts). NO INSERT/UPDATE/DELETE/upsert on any existing table —
  especially CalendarRate, Reservation, NightFact, PricingSetting.
- Hostaway access is GET-only. Fetch rates with getHostawayGatewayForTenant(
  tenantId) + gateway.fetchCalendarRates(...). DO NOT call
  runCalendarSyncForListing (it writes the shared CalendarRate table) and DO NOT
  write a new fetcher. Diff in-memory against the scanner's own RateState table.
  Never call any Hostaway push/PUT path.
- Every Prisma query on the new tables filters by tenantId; new indices are
  @@index([tenantId, ...]).
- The only edits to existing files are purely additive: new Prisma models +
  relations, an additive block in src/lib/queue/queues.ts, an additive
  import+start in src/workers/run-all-workers.ts, a new test script line in
  package.json, and a new .env.example var. Do not change how existing workers
  boot or any existing logic.

BUILD:
1. Four Prisma models (RateScan, RateState, RateChange, BookingRateContext) with
   tenantId on each, plus a migration named <timestamp>_add_signals_rate_scan.
   The migration must only CREATE the new tables (no ALTER/DROP on existing ones).
2. Modules under src/lib/signals/: config.ts, baseline.ts (trailing-365-day
   median of booked nightly rates), scan-service.ts, attribution.ts (48h /
   same-stay-date), summary.ts.
3. RATE-COPY EXCLUSION (§4 step 2): before scanning, exclude EVERY listing
   involved in rate-copy — both targets AND sources. Build an exclusion set:
   read property-scope PricingSettings (scope:"property", scopeRef not null),
   parse each with parsePricingSettingsOverride from @/lib/pricing/settings; for
   every row with parsed.pricingMode === "rate_copy" add scopeRef (the target
   listing id) and, if parsed.rateCopySourceListingId is a non-empty string, add
   that (the source listing id). Filter those listings out before scanning so
   they are never fetched, diffed, or written — they remain exactly as they are.
   Log how many were excluded. Factor the set-builder into a pure helper.
4. A "rate-scan" BullMQ queue + idempotent 07:00 and 12:00 Europe/London
   schedule helpers per tenant in src/lib/queue/queues.ts (do not touch existing
   queues). A worker src/workers/rate-scan-worker.ts mirroring
   rate-copy-push-worker.ts, scheduling only tenants with an active Hostaway
   connection. Wire it into run-all-workers.ts (additive import + start only).
5. A read-only GET route app/api/signals/monthly-summary/route.ts guarded by
   ?key=process.env.SIGNALS_SUMMARY_KEY — return 404 when the env var is unset or
   the key mismatches (don't advertise the route). It returns the trailing-month
   JSON summary from summary.ts (SELECT-only). Add SIGNALS_SUMMARY_KEY to
   .env.example, defaulting disabled. This env var must not be read anywhere else.

NO change-source tracking (manual vs automated). NO dashboard/UI. NO Hostaway
public-API/webhook work. NO AirROI. NO email reporting.

TESTS (existing node --import tsx --test style, wired into a new test:signals
npm script):
- scan-service: no-change, price move above/below epsilon, min-stay change,
  open↔close, first-seen seeds with no change, pctOfYearlyAdr math.
- rate-copy exclusion: the exclusion set contains both target and source ids and
  those listings are filtered out (pure helper, no DB).
- attribution: booking within/outside 48h, no-change stay-date, re-run
  idempotency.
- baseline: median odd/even, null below min-nights.
- summary: aggregation roll-up on a fixture; route 404s when key unset/mismatched.

VERIFY (all must pass): npm run typecheck, npm run lint, npm run test:signals,
npm run test:tenant-isolation. Then run `git diff --stat` and confirm only the
additive files above changed (the spec's isolation proof). Write a BUILD-LOG.md
entry and append a short DECISIONS.md entry.

DO NOT deploy or push. Stop after green tests and tell me:
(1) the migration name,
(2) how to run a one-off manual scan for a single tenant to smoke-test,
(3) the exact worker-restart command for production,
(4) whether you set SIGNALS_SUMMARY_KEY (and to what) or I should, plus the full
    monthly-summary URL to point the Cowork task at,
(5) how many listings the exclusion skipped on a manual smoke-test (so we can
    confirm rate-copy listings are being left out).
```

---

## Then — your simple steps, in order

1. **Paste the prompt above into Claude Code** and let it build. It stops with
   green tests and the five answers.

2. **Send the result back to me.** I'll re-run the read-only / isolation review
   on the actual diff before anything goes live — the review half of how we work.

3. **Deploy to `main` (I'll drive it once you say go).** `main` is the live
   branch (the old trial branch is now fully folded into it). The path:
   apply the migration → set `SIGNALS_SUMMARY_KEY` on the webapp **and** worker →
   push to main → **restart the worker** (a running worker keeps using old code,
   so this is required for the 07:00/12:00 jobs to register) → I plug the live
   summary URL into your monthly chat task.

4. **Verify it's live:** after the first scan, `rate_scans` gets a row per live
   tenant and `rate_changes` starts filling in (excluding rate-copy listings).
   I can pull those counts for you.

You won't need to run terminal commands blind — I'll hand you each deploy step as
a copy-paste when you're ready.
