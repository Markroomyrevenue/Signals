# Overnight run summary — 2026-07-13/14: Multi-PMS (Guesty + Avantio + Add Client)

**Everything is DEPLOYED and LIVE. Nothing is waiting on a deploy step.**

## The three mission goals — all done

1. **Cityscape is live in the app** (Guesty, GBP, Europe/London). First sync completed on prod:
   **10 listings, 654 reservations** (463 confirmed / 106 cancelled — every one carrying its true
   Guesty cancellation timestamp / 84 inquiries / 1 expired), 1,506 occupied nights worth
   **£380,577.03** accommodation revenue, 4,560 calendar days, 1,506 pace rows. Open the app →
   switch portfolio → Cityscape.
2. **Add Client has a PMS picker** — Hostaway, Guesty, Avantio. Each asks only for that PMS's
   credentials, validates them against the PMS before creating anything, and stores them
   encrypted. You will never need a code change to add a client on any of the three.
3. **"Avantio Sandbox (delete me)"** was added through that same flow and synced read-only
   (204 listings, 937 reservations, EUR). **Delete it whenever you like:** portfolio switcher →
   open any OTHER portfolio → delete "Avantio Sandbox (delete me)". Deletion of non-Hostaway
   tenants cleans up completely (covered by the extended isolation test).

## Numbers that prove the sync is right

- Guesty's own API reports **10 listings and 654 reservations** for the exact synced window —
  Signals matches 1:1 (no duplicates, reservations ≠ night-rows).
- 3 reservations hand-checked against raw Guesty JSON: totals, rent-only fare, taxes and
  commission all match **to the penny**. Revenue basis = accommodation fare, same as Hostaway.
- July 2026 stayed: 235 nights, £74,989, ADR £319.10, **occupancy 75.81% = 235 ÷ 310**
  (31 days × 10 listings — denominator scales correctly, no 100% clamp).
- Pace YoY shows zero for last year — honest: Cityscape only exists in Guesty since June 2026,
  so there are no historical booking dates yet. It fills in as real bookings accrue.

## One thing to look at (pre-existing, needs your call)

**The "Booked" headline counts inquiries and cancellations for every tenant** (that definition
was signed off in the 2026-06-29 audit). Guesty attaches FULL quote money to inquiries, so
Cityscape's "Booked this month" shows **£645k, of which £407k is 51 unbooked inquiry quotes**.
Hostaway tenants have the same behaviour but with smaller amounts. If you want the headline to
count real bookings only, say the word — it is a one-line default filter change.

## Guesty token budget (the 5-per-24h limit)

**2 tokens used tonight (budget was ≤2).** The token is cached encrypted in the database and
shared by the web app, the worker, and any script — steady state is ~1 token per day, refreshed
automatically. No action needed from you, ever.

## How Cityscape stays fresh

Guesty has no webhooks wired (same as Avantio), so a new daily schedule at **04:15 London**
delta-syncs every non-Hostaway client automatically. Hostaway clients are untouched (webhooks +
hourly rate-copy as before). Rate-copy/push/rate-scan workers skip non-Hostaway tenants cleanly —
nothing will ever push a price to Guesty or Avantio (the code can only read).

## Deploy evidence

- Prod `62f1f1e` → **`b3ff519`** (+ docs commits after). Both Railway services rebuilt and healthy.
- Baseline vs post: `/` 200 / 7,404 bytes (identical render), `/login` 200. Zero failed sync runs.
- Worker boot log (new code confirmed):
  - `[sync-worker] registered daily 04:15 London pms-daily-sync repeatable`
  - `[rate-copy-push] registered HOURLY … for 6 Hostaway tenants … non-Hostaway tenants skipped`
- Migrations: 2 additive tables applied via `prisma migrate deploy` BEFORE the code push.
- Full green gate before push: typecheck, lint 0 warnings, tenant-isolation (extended for the new
  connection tables + cascade delete), 560+ tests across 8 suites, production build.

## Rollback (if ever needed)

- Tags: `backup/main-guesty` and `backup/prod-live`, both = `62f1f1e`.
- Production, one line: `git push --force-with-lease origin backup/prod-live:main` → Railway
  redeploys both services. The new tables are additive and safe to leave in place.
- Full detail: `ROLLBACK-2026-07-13-GUESTY.md`.

## Small housekeeping notes (no action urgent)

- The repo has ~40 untracked Finder-duplicate files (`something 2.ts`) from an old copy —
  harmless, left untouched; worth a cleanup sweep sometime.
- When the real Avantio key arrives: Add portfolio → Avantio → paste key. That's it.
