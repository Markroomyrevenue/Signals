# Rollback doc — 2026-07-13 overnight: Guesty (Cityscape) + multi-PMS Add Client + Avantio sandbox

## Tags created tonight

- `backup/main-guesty` = `62f1f1e` (local main tip at start of night)
- `backup/prod-live` = `62f1f1e` (commit live in prod at start of night; force-moved from the
  stale 2026-07-07 value `65dcd5c` — old value recorded here in case it is ever needed)

## Prod baseline (captured 2026-07-13 before any push)

- `https://signals.roomyrevenue.com/` → 200, 7404 bytes, renders the real app (`<!DOCTYPE html>...`)
- `https://signals.roomyrevenue.com/login` → 200, 12387 bytes
- Railway CLI reachable (`railway whoami` → mark@roomyrevenue.com)

## Rollback — local

```
git checkout main
git reset --hard backup/main-guesty
```

## Rollback — production (one line)

```
git push --force-with-lease origin backup/prod-live:main
```

Then let Railway redeploy both services (web `Signals` + worker `signals-worker`); the worker
restart happens as part of the redeploy. Verify `https://signals.roomyrevenue.com/` returns 200
and renders, matching the baseline above.

## Migrations note

Any schema changes tonight are ADDITIVE ONLY (new tables for PMS connections / Guesty token
cache). Rolling back the code does NOT require dropping the new tables — additive tables are
safe to leave in place, same pattern as the 2026-07-04 observe migrations.

## Tenants provisioned tonight (for cleanup if rolling back)

- "Cityscape" (Guesty) — real client, keep unless rollback demands otherwise.
- "Avantio Sandbox (delete me)" — disposable; Mark deletes it in the morning via the app.
