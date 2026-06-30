# CALENDAR-ROLLBACK.md — rollback for the Calendar occupancy-scope / availability-denominator / hourly-push work

**Task branch:** `calendar/occupancy-scope-hourly-2026-06-30`
**Date:** 2026-06-30
**Live prod commit at task start (revert target):** `2abcb9c` (tagged `backup/prod-live`)
**Local main backup tag:** `backup/main-calendar-occ` = `2abcb9c`

## What this task changes (blast radius)

Live, allowlisted, currently-pushing 5×/day via rate-copy mode:
- `515526` **Studio Apartment at The Edge** — 150 units
- `514009` **Alma Place Short Stays** — 50 units
- `554857` **City Centre 6 bedroom apartment at Alma Place** — 6 units

All three sit in tenant **Little Feather Management**, pricing mode `rate_copy` + `rateCopyPushEnabled=true`, `occupancyScope=group`, currently all sharing one pool `group:Student Accomodation`.

The live push path for these is `rate-copy-push-service.ts → rate-copy.ts` (source rate × multi-unit occupancy lead-time matrix, floored at user min), **not** `pricing-report-assembly.ts`.

## 1. Local rollback (discard all task code)

```bash
cd /Users/markmccracken/Documents/signals
git switch main
git branch -D calendar/occupancy-scope-hourly-2026-06-30   # or keep for inspection
# main is unchanged at 2abcb9c
```

## 2. Prod code rollback (if a bad deploy landed)

```bash
cd /Users/markmccracken/Documents/signals
git push --force-with-lease origin backup/prod-live:main    # resets prod main to 2abcb9c
# Railway auto-redeploys 'Signals' from main. Then restart the worker so it
# drops any new schedule and returns to the 5×/day rate-copy cadence:
railway redeploy --service signals-worker --yes
# verify health:
curl -s -o /dev/null -w "%{http_code}\n" https://signals.roomyrevenue.com/
```

## 3. Rate revert (if a bad rate was pushed to Hostaway)

The exact per-date rates last pushed BEFORE this task are snapshotted in:
- `CALENDAR-PUSHED-RATES-SNAPSHOT-2026-06-30.json` (repo root) — the full `payload`
  of the latest successful `HostawayPushEvent` per toggled listing (captured
  2026-06-30T07:00:33Z).

To revert, re-PUT those exact rates to Hostaway via the proven range endpoint
(`PUT /v1/listings/{id}/calendar`, one date per PUT, `startDate===endDate`).

> ⚠️ **Heads-up (found in the 2026-06-30 independent review):** the revert
> **script does not exist** in the repo — `scripts/_revert-pushed-rates.ts` was
> referenced here but never committed. Until it is written, the snapshot has to
> be replayed manually. Build the script to: read
> `CALENDAR-PUSHED-RATES-SNAPSHOT-2026-06-30.json`, and for each toggled listing
> push every `{date, dailyPrice, minStay}` back through the existing per-tenant
> push client (`getHostawayPushClientForTenant` → `pushCalendarRatesBatch`,
> which already does verify-after-push + allowlist). Run it with the prod public
> DB URL + prod Hostaway creds via `railway run`. Mirror the shape of
> `executeRateCopyPush`'s push step in `src/lib/pricing/rate-copy-push-service.ts`.

Snapshot summary (n dates per listing):
- The Edge (515526): 126 dates, last push 2026-06-30T05:30Z
- Alma Place (514009): 366 dates, last push 2026-06-30T05:34Z
- Alma 6BR (554857): 366 dates, last push 2026-06-30T05:32Z

## 4. Allowlist

Current prod `HOSTAWAY_PUSH_ALLOWED_HOSTAWAY_IDS = 513515, 514009, 515526, 554857`
(513515 = removed test listing). No widening is performed without the Phase-5
approval gate. To narrow back, set the env on the `signals-worker` + `Signals`
Railway services and redeploy.

## End state guarantee

Healthy-and-correct, or rolled back to `2abcb9c` + rates reverted to the snapshot.
Nothing in between.
