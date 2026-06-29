# AUDIT — Resume note (paused 2026-06-29 ~17:00 London)

Single source of truth for restarting the full metric & UI trust audit in a fresh
session. Read this, then `AUDIT-FINDINGS.md` (the triage), then resume at "Next actions".

## Where we are

- **Branch:** `audit/full-metric-ui-2026-06-29` (3 commits this session, below).
- **Prod is UNTOUCHED and healthy** — `/`, `/login`, `/dashboard` → 200 at pause. Nothing deployed.
- **Rollback target unchanged:** tag `backup/prod-live` = `82841b3` (= prod's live commit). See `AUDIT-ROLLBACK.md`.
- **Deploy decision (Mark):** *checkpoint before deploy* — fixes land on the branch + pass the hard green gate, then Mark reviews the customer-facing number changes and gives an explicit "go" before any push.

### Commits made this session (on the branch)
```
d211e33 chore(audit): exclude scripts/audit from the production typecheck
8596f7d docs(audit): consolidated findings + per-discipline reports + reconciliation harness
318dd4a fix(reports): subtract VAT from stay/arrivals headline when Ex-VAT toggle is off   [F-VAT ✔]
```
All three pass `npx tsc --noEmit` (app code). Background implementation agents were stopped
mid-setup and their worktrees/branches removed — **nothing of theirs was kept**; re-launch fresh.

## Decisions already made (do NOT re-ask Mark)
1. **Multi-unit occupancy/RevPAR (D-MUOCC): FIX IT NOW.** Scale inventory by `unit_count`; drop the
   `max(occupied,inventory)` floor + 100% clamp that hides overflow. LF occupancy ~75%→~22.5%,
   RevPAR ~£84→~£25. Only Little Feather affected. Prep a 1-paragraph client explanation.
2. **Lifecycle gating (D-LIFECYCLE): GATE TO GO-LIVE DATE.** Gate each listing's available-nights to
   its first-booked-night by default. Raises single-unit occupancy (Yo's 54%→~75%, Coorie 50%→~66%).
3. **signal_lab (D-SIGLAB): RETIRE / HIDE IT.** Remove the orphaned tab + its broken second (registry)
   engine. Low risk — already off the nav; main tabs are the verified-correct engine.
4. **Alma Place uc=20 (D-ALMA):** Mark to verify the real room count (44 reservations overlapped one
   night). Data fix only — set `unit_count` once confirmed; no code.
5. **AirROI:** remove all of it (dead). Mark to **rotate** the `AIRROI_API_KEY` in `.env.local` and
   delete the dead `AIRROI_*` / `ROOMY_ENABLE_LIVE_MARKET_REFRESH` vars on the `Signals` +
   `signals-worker` Railway services (still set; harmless but dead).

## Two gotchas that bit the agents (fix these on restart)
1. **Prod creds are session-bound.** The harness reads `…/<THIS session>/scratchpad/.audit-env`,
   which will NOT exist in a new session. `scripts/audit/run.sh` also hard-codes that path.
   Re-create the env file in the NEW session's scratchpad and update `run.sh`'s `SCRATCH=` to the
   new path (or just export the vars inline). Regenerate without printing secrets:
   ```bash
   PUBURL=$(railway variables --service Postgres-1_Oc --kv | grep '^DATABASE_PUBLIC_URL=' | sed 's/^DATABASE_PUBLIC_URL=//')
   ENCKEY=$(railway variables --service Signals --kv | grep '^API_ENCRYPTION_KEY=' | sed 's/^API_ENCRYPTION_KEY=//')
   # write to <new scratchpad>/.audit-env (chmod 600):
   #   export AUDIT_DATABASE_URL='…'   (host shuttle.proxy.rlwy.net:48932, db railway, user postgres)
   #   export API_ENCRYPTION_KEY='…'   (44 chars)
   ```
   Live tenants (Demo is empty — skip): Little Feather Management (multi-unit), Escape Ordinary,
   Stay Belfast, Yo's House & Short Stay Harrogate, Coorie Doon Stays.
2. **`.env` is gitignored → absent in fresh worktrees.** Worktree agents' verification command
   `node --env-file=.env …` fails because the new worktree has no `.env`. Either copy the main repo's
   `.env` into each worktree, or point `--env-file` at the absolute path of the main repo's `.env`.

## Next actions (resume here)

**Phase 4 — implement remaining fixes** (one commit each, conventional messages, owner wants
one-fix-per-commit). Re-launch the implementation agents (worktree-isolated, distinct files, with
the two gotchas above pre-solved), OR do them inline:

- **Metrics** (`src/lib/reports/service.ts` + `PropertyDeepDiveRow` + `pricing-report-assembly.ts`):
  D-MUOCC, D-LIFECYCLE, F-RESV (reservations double-count, `:1770`/`:3378`), F-CALADR backend
  (surface `calendarAdr`/`lyStayedAdr`), F-TZ backend (Europe/London "today", `:3415`/`:3114`).
  Verify each delta with the `scripts/audit` reconciliation (expected numbers in `AUDIT-FINDINGS.md`).
- **Frontend** (`app/components/revenue-dashboard.tsx`) — RUN AFTER metrics is merged (needs the new
  fields): F-CALADR display (`:8382-8384`,`:8416-8417` → render `liveVsReferenceAdrPct`, "—" when
  null), D-SIGLAB retire the tab, F-TESTLST strip test listings from client exports.
- **Business-review PDF** (`src/lib/business-review.ts`): UI-2 delete dead pagination branch (`:219`),
  UI-1 running header on every page, UI-3 page numbers. Verify by rendering
  `scripts/audit/ui-business-review.ts` → out PDF.
- **Date presets** (`app/components/date-range-picker.tsx`): UI-6 Europe/London anchor; UI-9 add
  Last 30/90, MTD/QTD/YTD, Last month, **Next 30/60/90**, Trailing-12m (math in `AUDIT-UI.md`).
- **Dead-wood** (Phase 4b, green-gate-guarded, revert anything that breaks build): AirROI removal,
  `display-name.ts`, `client-setup.tsx`, unused deps; whitelist the 3 key-gated routes in
  `scripts/audit-tenant-isolation.ts` (F-ISOAUDIT) + register `observationWindow`. KEEP
  `market-recommendations.ts` (KeyData scaffold) and the `external_api_cache` table (needs migration).
- **CLAUDE.md** (lead does this, not an agent): update the "AirROI is intentionally disabled" section
  to "removed" once the removal merges. (CLAUDE.md currently has uncommitted local deploy-protocol
  edits — preserve them.)

**Phase 5 — hard green gate, then deploy CHECKPOINT (not auto-deploy):**
`npm run typecheck` · `npm run lint -- --max-warnings=0` · `npm run test:tenant-isolation` ·
the new/changed tests · `npm run build`. Then present Mark the before/after of every customer-facing
number (esp. LF occupancy 75%→~22%) and wait for his "go" before pushing. On go: push fast-forward,
restart `signals-worker`, health-check vs the `AUDIT-ROLLBACK.md` baseline, self-heal per CLAUDE.md.

**Phase 6 — report** (`AUDIT-REPORT.md`, plain-English) + append dated entries to `DECISIONS.md`
and `BUILD-LOG.md`.

## Status snapshot (from AUDIT-FINDINGS.md)
Fixed: F-VAT. Pending: D-MUOCC, D-LIFECYCLE, F-RESV, F-CALADR, F-TZ, F-PDF1/2/NUM, F-TESTLST,
D-SIGLAB, date presets (UI-6/9), dead-wood + F-ISOAUDIT. Verified-correct (no action): the full
PASS list in AUDIT-FINDINGS.md §D (stay revenue, ADR, occupied nights, booked revenue, cancellation
rate, YoY arithmetic, pace, cancelled-at-cutoff inclusion, tenant isolation).
