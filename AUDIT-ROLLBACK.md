# AUDIT — Rollback & Baseline (2026-06-29)

Branch: `audit/full-metric-ui-2026-06-29`
Audit type: Full independent metric & UI trust audit (Calendar excluded from metric/UI audit; in-scope for dead-code removal).

## Backup tags (safety net)

| Tag | Commit | Meaning |
| --- | --- | --- |
| `backup/prod-live` | `82841b3` | **Rollback target** — exactly the commit live in prod when the audit started (= `origin/main`). |
| `backup/main-audit-2026-06-29` | `82841b3` | Local tip when the audit branch was cut. |

## Known-good PROD baseline (captured before any change)

URL: `https://signals.roomyrevenue.com`  ·  captured 2026-06-29

| Route | Status | Notes |
| --- | --- | --- |
| `/` | 200 | renders real app |
| `/login` | 200 | `<title>Signals by Roomy Revenue</title>` ✓ |
| `/dashboard` | 200 | |
| `/select-client` | 404 | verify true route during inventory (likely guarded / different path) |
| `/api/health` | 404 | no health route exists |

Railway: project `bubbly-quietude`, web service `Signals` (Online), worker `signals-worker`, prod URL above. Logged in as mark@roomyrevenue.com.

## ROLLBACK COMMANDS

### Local (undo audit branch work, return to clean main)
```bash
git checkout main
git reset --hard backup/main-audit-2026-06-29   # restores pre-audit local tip
git branch -D audit/full-metric-ui-2026-06-29    # optional: delete the audit branch
```

### Production (restore the exact commit that was live before deploy)
```bash
# Force prod main back to the known-good commit, then Railway redeploys it:
git push --force-with-lease origin backup/prod-live:main
# Then in Railway: redeploy Signals + restart signals-worker so both run the rolled-back code.
# If a migration was applied during the failed deploy, assess whether it must be reversed.
```

Verify health after rollback: `curl -sS -o /dev/null -w "%{http_code}" https://signals.roomyrevenue.com/login` → expect 200, and root renders the real app (title "Signals by Roomy Revenue").

## Deploy decision (this run)
Mark chose **checkpoint before deploy** (2026-06-29): audit + fixes land on the branch and pass the hard green gate, then Mark reviews customer-facing number changes and gives an explicit "go" before any prod push. No autonomous prod deploy in this run.
