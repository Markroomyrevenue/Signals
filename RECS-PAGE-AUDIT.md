# Recs Page — independent auditor report (2026-07-18 → 19 overnight build)

## VERDICT: SAFE-WITH-NOTES

The Pricing Recommendations build is safe to leave live. Every safety-critical
control the brief demanded holds up under adversarial testing: the internal gate
rejects every bypass attempt, no scheduled/worker path can fire an engine write,
floors and push-once idempotency bind, the guarded self-tests were reverted and
the live engines are clean, customer-facing surfaces are untouched, and the
migration is additive and applied. One LOW documentation finding (the oversight
cost headline in the run summary is understated and internally inconsistent) plus
two informational notes. Nothing blocks shipping.

Audited at commit `ad0a185` (prod HEAD == origin/main == local main). Green gate
re-run clean. Evidence below, item by item.

---

## Findings (ranked)

### LOW-1 — RUN-SUMMARY oversight cost headline is wrong and self-contradictory
`RECS-PAGE-RUN-SUMMARY.md` (Claude oversight section) states the first estate
pass was **"115,563 tokens in / 45,431 out — $3.43 total"**. The authoritative
`oversight_runs` rows on prod (6 `status=ok` runs with accounting) sum to
**161,043 in / 65,338 out / $4.8773**. The summary's own per-client breakdown
($0.82 + $0.86 + $0.79 + $0.96 + $0.59 + $0.86) sums to **$4.88**, so the stated
$3.43 headline contradicts the same paragraph. Per-client figures are each
accurate to the DB; only the aggregate is wrong.
- Impact: cost reporting only — no safety, isolation, or functional effect.
- Smallest fix: change the headline in `RECS-PAGE-RUN-SUMMARY.md` to
  `161,043 tokens in / 65,338 out — $4.88 total` (≈£3.85).

### INFO-1 — "First generation" row counts differ from current pending
Summary "First generation" lists LF 278 / SB 70 / Yo's 159 / Coorie 131; current
prod pending `recs-night` is LF 228 / SB 68 / Yo's 109 / Coorie 130. This is
expected regeneration churn (rows superseded + re-inserted), and the summary
labels them "First generation", so it is not dishonest — noted only so a reader
doesn't treat those as live counts. Cityscape 51 and EO 224 still match exactly.

### INFO-2 — Two `failed` PriceLabs self-test push rows on prod (expected)
`push_logs` holds 2 `pricelabs`/`failed`/`selftest` rows at 22:42 — the live
API-contract bugs the build found (missing `currency` → 400 DSO-CUR-MS). Each was
immediately followed by a verified revert, and the final self-test pair for each
engine is a clean push→verify→revert→verify-gone. No action needed; documented so
the failed rows aren't mistaken for a live mispush.

---

## Checklist results

### 1. GATES — PASS
Code: `isInternalRecsUser` (`src/lib/recs/auth.ts:25`) requires all three —
`env.recsPageEnabled` (RECS_PAGE_ENABLED === "true"), `auth.role === "admin"`,
and `env.internalRecsEmails.includes(email)`. Every `/api/recs/*` route calls
`getInternalRecsAuth()` and returns `404 "Not found"` when null (overview,
client/[tenantId], action, bulk-approve, explain, regenerate — all verified).
Pages call `notFound()` for non-internal and `redirect("/login")` when
unauthenticated. Nav links render only on the server-computed `showRecsLink`
boolean (dashboard/page.tsx:16, select-client/page.tsx:14, revenue-dashboard.tsx
additive `showRecsLink = false` default; client-selector.tsx:137 gated).

Live bypass attempts against `https://signals.roomyrevenue.com` (unauth):
- `/api/recs/overview` GET → **404, 9-byte "Not found"** (route gate, not the
  Next 404 page).
- action / regenerate / bulk-approve POST → **404**; `client/abc` GET → **404**.
- GET on action route → **405** (POST-only export).
- Fabricated `Cookie: session=admin; role=admin` → **404**.
- Spoofed `X-Forwarded-Email` / `X-User-Role` → **404**.
- Query-param spoof `?email=…&role=admin&RECS_PAGE_ENABLED=true` → **404**.
- Case/trailing variants (`/api/recs/Overview`, `/API/RECS/OVERVIEW`) → **404**.
- `/dashboard/recommendations` unauth → **200 with NEXT_REDIRECT to /login**, body
  sniff shows only "login"/"NEXT_REDIRECT", zero recs content leaked.
- Observe key-gated `/api/observe/readout` → 404 without key (unchanged, separate
  from the recs gate).

### 2. CROSS-TENANT — PASS
`npm run test:tenant-isolation` → **passed**. Every Prisma query in the recs
surface filters by `tenantId`: `src/lib/recs/data.ts` (all reads),
`actions.ts`, `push/push-service.ts` (`DEFAULT_SUGGESTION_STORE.load/update/
claimForPush` all `where {id, tenantId}`), `oversight/store.ts` (every query
tenant-scoped; `mergeSuggestionOversight` uses `updateMany where {tenantId, id}`),
`market/stores.ts` (snapshot key includes tenantId). The only non-tenant-filtered
reads are `prisma.tenant.findMany/findUnique` (the tenant table itself — the
internal cross-client surface, gated). Cross-tenant action attempt (tenantId A +
suggestionId B) resolves via `loadActionable` = `findFirst({where:{id, tenantId}})`
→ null → `"suggestion not found"` (actions.ts:69-70); same pattern in the push
store and oversight store. `GlobalMethodology` is the only cross-client prompt
input and is anonymised (allowed by §4 Phase G).

### 3. PUSH CANNOT FIRE WITHOUT APPROVAL — PASS
`executeApprovedPush` has exactly one caller: `approveSuggestion` in
`actions.ts`, reachable only from `/api/recs/action` and `/api/recs/bulk-approve`
(both gated). No `src/workers/**`, observe-service, or generate.ts path imports
the push service, the adapters, or `approveSuggestion` (grep-verified). The push
adapters are imported directly only by `push-service.ts` and `selftest.ts`; the
self-test CLI (`scripts/recs-push-selftest.ts`) refuses without `--confirm-live`
(line 50-52). Approve sets status to exactly `"approved"` via `updateMany` guarded
on `status:"pending"` (actions.ts:107) in the same human request. Atomic
`claimForPush` (`updateMany where {status:"approved", pushRef:null}` →
`count===1`) serialises concurrent approvals. `node --test src/lib/recs/push/*.test.ts`
→ **71 pass**, including "RACE FIXED: two concurrent pushes … exactly one engine
write" and the sequential double-push idempotency test.

### 4. FLOORS + IDEMPOTENCY — PASS
- `below_floor` gate in `push-service.ts:192-196` blocks any price < floor,
  including a human-edited `approvedPrice` (test: "price below floor → skipped
  below_floor — including a human-EDITED approvedPrice").
- floorUnknown edits bounded: `actions.ts:88-100` refuses an edited price
  `< basis * 0.5` when no floor exists.
- pushRef idempotency: pushRef gate is checked FIRST (line 182); pushRef is set
  after every attempted execute (line 319, 329-335) so a mismatch/failed attempt
  can't double-fire.
- verify-mismatch leaves the row `approved` (status set to `applied` only when
  `verify.verified`, line 332) with pushRef set — a human decides next.

### 5. SELF-TESTS REVERTED / ENGINE STATE CLEAN — PASS
`push_logs` on prod contains **only** `kind=selftest` rows (no `kind=push` or
`kind=revert`). Per engine, the final self-test pair is push→verify(observed=
current)→revert→verify-gone:
- PriceLabs (listing 139972, 2027-04-04): last push 22:43:45 success
  observedPrice=154; revert 22:43:47 success `verify.verified=true, observedPrice
  null`. (Two earlier `failed` pushes each followed by a verified revert — see
  INFO-2.)
- Wheelhouse (listing 407381, 2027-04-04): push 22:45:40 success observedPrice=120;
  revert 22:45:46 success `verify.verified=true, observedPrice null`.
Every engine ends on a revert whose recorded verify shows the override gone. Zero
suggestions have `actioned_by_email` or `push_ref` set (0 of 4,050 rows), so there
are no real human pushes — consistent with "no non-selftest push rows".

### 6. GREEN GATE — PASS
- `npm run typecheck` → exit 0.
- `npm run lint -- --max-warnings=0` → exit 0.
- `npm run test:tenant-isolation` → "Tenant isolation check passed."
- `npm run test:observe` → 256 pass / 0 fail.
- `npm run test:signals` → 36 pass / 0 fail.
- `npm run test:recs` → 174 pass / 0 fail.

### 7. LIVE HEALTH vs BASELINE — PASS
- `/` → 200, **7,404 bytes** (baseline 7,404).
- `/login` → 200, 12,387 bytes (baseline 12,387).
- `/api/recs/overview` unauth → 404, **9 bytes** (baseline "404 9b route gate").
- `/dashboard/recommendations` unauth → 200 + login redirect (baseline behaviour).
All match `RECS-PAGE-RUN-SUMMARY.md`'s deploy table.

### 8. PHASE G ISOLATION + DEGRADATION — PASS
`oversight/prompt.ts`: system prompt is static (no client data, no dates, no ids,
no keys); `buildUserPrompt` renders only the single client's `OversightInput`
(name, clientKey, engine, profileSummary, recentDecisions, suggestions,
anonymised globalMethodology). tenantId is never rendered; no key material can
appear. `run.ts` disabled path (`!config.enabled || !config.apiKey`, line 268)
writes a `status:"disabled"` OversightRun row and returns **without calling the
model** (no fetch). The catch-all (line 374) writes a `status:"error"` row and
resolves — never throws. `generate.ts:186-190` calls oversight AFTER suggestions
are already persisted and only when `env.recsOversightEnabled`, so generation
succeeds regardless of oversight outcome. Prod `oversight_runs`: 6 per-client
`status=ok` runs with model `claude-fable-5`, suggestionCount, flag counts, token
in/out, and cost_usd populated; earlier `error` rows (the pre-fix timeout/max-
tokens attempts) and 2 Demo PM `ok` zero-suggestion rows all recorded — the
degradation path demonstrably wrote audit rows without blocking.

### 9. CUSTOMER-FACING UNCHANGED — PASS
`git diff 0077566..HEAD -- app/api/observe` → **0 files**. The observe/report
changes only exclude the new row type/holds:
- `readout.ts`: pending readout adds `excludeTypes:["recs-night"]`; drop
  calibration filters out `detail.hold===true`.
- `weekly-report.ts`: outcomes query + pending count add `type:{not:"recs-night"}`.
- `suggestion-scoring.ts`: holds are now scored for hold-validation but kept out
  of drop-calibration aggregates (recs-night excluded from customer reports
  upstream).
- `revenue-dashboard.tsx`: additive `showRecsLink` nav link, default `false`.
With `RECS_PAGE_ENABLED` unset, `observe-service.ts:191-193` routes to the legacy
`generateSuggestionsForClient` and the recs-evidence refresh (line 272) is skipped
— the diff hunk shows the ternary explicitly.

### 10. MIGRATION SAFETY — PASS
`20260718220000_recs_page/migration.sql` is additive only: `ADD COLUMN` ×6 on
`suggestions` (provenance, provisional, actioned_at, actioned_by_email,
approved_price, push_ref), 3 new tables (recs_evidence, recs_market_snapshots,
oversight_runs), new indexes + FKs. No DROP, no ALTER of an existing column, no
repurposing. Applied on prod: `_prisma_migrations` shows
`20260718220000_recs_page` finished 2026-07-18 21:55.

### 11. DOCS HONESTY — PASS-WITH-NOTE (see LOW-1)
Spot-checked against prod:
- Deploy commit range `0077566 → ad0a185`: **matches** (prod HEAD ad0a185).
- Warm-start settled treated nights (LF 520 / SB 288 / Yo's 542 / EO 162 /
  Coorie 816 / Cityscape 0 / Demo 0): **all match** `recs_evidence`
  drop-outcomes `treatedNightsSettled`.
- Warm-start episode totals (LF 7,576 / SB 5,189 / Yo's 8,153 / EO 5,180 /
  Coorie 9,728): **all match** `recs_evidence` mark-prior `episodesTotal`.
- Fidelity-note rows exist only for the demoted clients (Cityscape, Coorie, EO,
  Demo), not for the confident LF/SB/Yo's: **consistent** with the posture table.
- Per-client oversight costs ($0.59 / $0.86 / $0.82 / $0.86 / $0.79 / $0.96):
  **all match** `oversight_runs.cost_usd`.
- Oversight aggregate total: **MISMATCH** — see LOW-1.

---

## Notes on scope / things checked and cleared
- Concern investigated and cleared: `generate.ts:175` passes `status:"shadow"`
  for non-graduated clients, but `suggestions.ts:1006` forces every in-window
  `recs-night` draft to `status:"pending"` regardless, so the daily 05:30
  regeneration keeps the page populated (all 6 clients are `observing`, not
  graduated, and all 810 pending rows are `recs-night`). Human-actioned rows
  (approved/applied/rejected) are outside SUPERSEDABLE_STATUSES and survive
  regeneration.
- No writes were made to prod during this audit (SELECT-only DB access; a temp
  read-only query helper was created inside the repo and deleted afterward).
