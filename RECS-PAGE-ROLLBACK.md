# Recs Page — rollback doc (2026-07-18 overnight build)

**Safety-net state (recorded before any change):**

- Local `main` tip at build start: `0077566` ("docs: afternoon ship record — push freshness + refresh buttons")
- `origin/main` (= commit live in prod) at build start: `0077566` — same commit.
- Tags created: `backup/main-recs-page` = `0077566`, `backup/prod-live` = `0077566` (force-moved from `b491e92`, which was one commit behind the docs commit; `0077566` is docs-only on top of it and is what prod is running).
- Build branch: `feat/recs-page` off `main`.

## Rollback — production (one line)

```bash
git push --force-with-lease origin backup/prod-live:main
```

Railway auto-redeploys both `Signals` (web) and `signals-worker` from main. Then **restart
`signals-worker`** in the Railway dashboard so the worker is definitely on the rolled-back code.
Verify: `curl -s -o /dev/null -w "%{http_code}" https://signals.roomyrevenue.com/` → 200.

Any migrations shipped tonight are **additive only** (new tables/columns, no drops, no
repurposed fields) and are safe to leave in place after a code rollback.

New env vars set tonight (`PRICELABS_KEY_*`, `WHEELHOUSE_*`, `INTERNAL_RECS_EMAILS`,
`RECS_PAGE_ENABLED`, `RECS_OVERSIGHT_*`, `ANTHROPIC_API_KEY`, `OBSERVE_ENGINE_COORIE_DOON`)
are inert on the rolled-back code (nothing on `0077566` reads the recs vars; the engine key
vars only feed the observe registry, which existed before and treats them as an upgrade from
the hostaway-scan fallback). To fully revert the observe engine change too, set
`OBSERVE_ENGINE_COORIE_DOON=hostaway-scan` back.

## Rollback — local

```bash
git checkout main && git reset --hard backup/main-recs-page
git branch -D feat/recs-page   # optional; keeps the work if omitted
```

## Kill-switch (no rollback needed)

Set `RECS_PAGE_ENABLED=false` on the Railway `Signals` service and redeploy — the page,
nav link, and `/api/recs/*` routes all hide/404. No git action required.

## Reverting a pushed price (per night, no deploy)

Every pushed night has a Revert action on the Recommendations page. Manually:
- PriceLabs: `DELETE /v1/listings/{id}/overrides` with the same date + `pms`, tenant's customer key.
- Wheelhouse: `DELETE /ss_api/v1/listings/{id}/custom_rates?channel=hostaway&start_date=D&end_date=D`
  with paired read+write headers. DELETE returns dates to Wheelhouse's recommended price.
