# Pricing Recommendations page — overnight run summary (2026-07-18 → 19)

**End state: LIVE + HEALTHY.** Web + worker on the new code, migration applied, every
engine connected, all seven clients generated and populated on the page, both push
self-tests passed (pushed → verified → reverted → verified-gone), Claude oversight
running. Mark saw the page mid-build and his three feedback changes are already live.

---

## 2-minute "how to use the page"

1. Log in → sidebar → **Pricing Recommendations** (or `/dashboard/recommendations`).
2. The overview lists every client: engine badge, nights at risk (next 14 days),
   £ at risk, pending drops vs holds, what you actioned in the last 7 days, a
   freshness stamp, and a **low-confidence banner with a question for you** where
   the evidence didn't earn confidence.
3. Click a client → each listing, night by night for the next 14 days (available
   nights only). Each row: current £ → recommended £, % chip, £ at risk, floor, a
   short "why", and **"how this was sized"** (the honest decomposition: curve →
   account prior with n → outcome evidence → market). Far-out "on pace" holds are
   hidden by default — "Show all holds (N hidden)" brings them back.
4. Actions per night: **Approve** (pushes to that client's engine and verifies),
   **Edit** then approve (validated against the floor), **Reject** (remembered —
   not re-suggested for 3 days unless the price basis moves), **Leave**. Bulk:
   tick nights → "Approve selected" → confirm modal shows exactly what will push.
   Applied rows get a **Revert** button (removes the override; engine returns to
   its own price).
5. Claude's overlay: a chip per night (✓ endorse / amber flag with its reason) and
   a client-level read (3-5 bullets). It never changes a price — it's a second
   opinion, and ghost scoring will settle over time whether its flags were right.
6. "Regenerate now" re-runs a client on demand. Otherwise everything regenerates
   at the **05:30 daily observe run**, which now also captures engine snapshots
   (keys live on the worker) — decisions you've made are never overwritten.

## What happens at 05:30 (and weekly)

- 05:15 reconcile → 05:30 per-tenant observe run: engine snapshot capture (now
  real — keys are live), learning accumulation, **recs generation** (fresh 14-day
  window; approved/rejected nights preserved; suppressions visible), then one
  **Claude oversight call per client** with pending recs.
- Monday 06:00 settle: ghost scorer settles outcomes (booked-without-drop /
  booked-after / expired-empty / cancelled — **including holds**, kept out of the
  drop calibration), pickup measurement, and — new — **the sizing evidence
  re-mines itself from the live record** (provenance flips to `live-observed`;
  our own pushed nights are excluded via PushLog so the learner never learns
  from its own actions).

---

## Deploy evidence

| Check | Before (21:54 UTC) | After |
|---|---|---|
| `/` | 200 (7,404b) | 200 (7,404b — identical render) |
| `/login` | 200 (12,387b) | 200 (12,387b) |
| `/dashboard/recommendations` | 404 (route absent) | 200 for internal admin; login-redirect unauth; **404 body for non-internal admins** |
| `/api/recs/overview` | 404 (8,005b Next 404 page) | 404 (9b route gate) unauth; 200 for internal |

- Prod `0077566` → `ad0a185` (13 commits). Migration `20260718220000_recs_page`
  applied via `prisma migrate deploy` (validated on a scratch shadow DB first).
- Worker boot: `[observe] registered daily (05:30) + weekly settle (Mon 06:00) +
  reconcile (05:15) Europe/London for 7 tenants` + all five workers started.
- Env on BOTH services: 5 PriceLabs keys (incl. the `PRICELABS_KEY_STAY_BELFAST`
  short alias — see surprises), Wheelhouse read+write, `ANTHROPIC_API_KEY`,
  `OBSERVE_ENGINE_COORIE_DOON=wheelhouse`, `INTERNAL_RECS_EMAILS`,
  `RECS_PAGE_ENABLED=true`, `RECS_OVERSIGHT_MODEL=claude-fable-5`,
  `RECS_OVERSIGHT_ENABLED=true`.
- Connectivity (prod tenants): **pricelabs ×5** (EO, Stay Belfast, Yo's,
  Cityscape, Little Feather — all 200 OK) + **wheelhouse** (Coorie Doon, 200 OK,
  48 listings) + hostaway-scan fallback (Demo Property Manager).

## Warm-start (prod data) + per-client fidelity posture

| Client | Episodes (≥3%) | Settled treated nights | Posture |
|---|---|---|---|
| Little Feather | 7,576 | 520 | **confident** |
| Stay Belfast | 5,189 | 288 | **confident** |
| Yo's House | 8,153 | 542 | **confident** |
| Escape Ordinary | 5,180 | 162 | low-confidence (R2 — no outcome cell reaches n=20) |
| Coorie Doon | 9,728 | 816 | low-confidence (R4 — moves are Wheelhouse autoposts, not Mark's; wording is attribution-neutral everywhere) |
| Cityscape | 0 | 0 | watch-only (no drop history; Guesty read-side) |
| Demo PM | 0 | 0 | watch-only |

**Morning questions on the page (one per demoted client):**
- **Escape Ordinary:** is PriceLabs set to auto-push on this account, or do you
  push its numbers by hand? (Resolves whose behaviour the 5,180 moves are.)
- **Coorie Doon:** Wheelhouse autoposts most moves — do you ever hand-price it,
  and should recs lean on the engine's pattern at all?
- **Cityscape:** is the PriceLabs account actively repricing, and do you want recs
  shown at all before local evidence exists?

## First generation (all clients, ~23:20-23:40 London)

Cityscape 51 rows · Coorie Doon 131 (market context for all 48 listings) ·
Escape Ordinary 224 (1 floor-block) · **Little Feather 278 — the Fleadh event
shield held back 12 nights and floors 12 more** · Stay Belfast 70 · Yo's 159 ·
Demo 0 (no calendar data). All rows `warm-start` + `provisional` (correct — no
client has graduated). Safety gates and floors all bound; deepest single drop
capped at 30%.

## Push self-tests (both engines, live, no-op, reverted)

- **PriceLabs** (Yo's listing 139972, 2027-04-04, 260d out): read current £154 →
  pushed £154 fixed-GBP override → verified via GET overrides (observed 154) →
  DELETE → verified gone. PushLog rows kind=`selftest` in prod.
- **Wheelhouse** (Coorie listing 407381, 2027-04-04): read current £120 → PUT
  custom_rate fixed GBP → verified → DELETE (204) → verified gone. Owner's
  December rows untouched (preview conflict check).
- **The self-tests earned their keep** — four real API-contract bugs found live
  and fixed + re-tested + redeployed before any real push could hit them:
  1. `POST /v1/listing_prices` needs a **wrapped** `{listings:[…]}` body (bare
     array silently returns no data).
  2. Fixed-price DSOs **require `currency`** (400 `DSO-CUR-MS` without it).
  3. Wheelhouse `price_calendar` wants `start_date`+`end_date` (`days` ignored).
  4. Wheelhouse calendar rows carry `stay_date`, not `date`.

## Claude oversight (live)

Model `claude-fable-5`. Night-one reality: the defaults needed two fixes —
max_tokens 4000 → 16000 and per-attempt timeout 60s → 300s (fable-5's always-on
thinking counts as output and takes 1-3 min for a 50-verdict reply). Both
env-overridable (`RECS_OVERSIGHT_MAX_TOKENS` / `RECS_OVERSIGHT_TIMEOUT_MS`).
Failures degraded exactly as designed — recs shipped unannotated with an
"oversight unavailable" note, never blocked. Input capped at the top 50 rows
per client (drops first, then by £ at risk).

**First full estate pass (measured, audit-corrected): 161,043 tokens in /
65,338 out — $4.88 total** (~£3.85; over the £1-2/day estimate because night
one sends 50 rows per client with cold caches — prompt caching and settling
flag counts should pull it down; env caps exist if not). Per client:
EO $0.82 (6 flags) · LF $0.86 (2) · SB $0.79 (2) · Yo's $0.96 (2) · Cityscape
$0.59 (6) · Coorie $0.86 (2).

One bullet from each client-level read (full reads on the page):

- **Escape Ordinary:** "roughly 40% of past empty nights were held too high …
  most cuts in this batch are modest and match the account's own history."
- **Little Feather:** "a large share of the batch's value sits on listings named
  'test' and 'zzz' — confirm these are live, bookable units before approving."
  *(Genuine catch — check these two listings, Mark.)*
- **Stay Belfast:** "six clearly behind-pace nights are pinned at their minimum
  prices — if those keep expiring empty, the floors are the lever to revisit,
  not the recommendations."
- **Yo's:** "where your own outcome data exists it supports the engine: 7-15%
  cuts one-to-two weeks out filled roughly 16 points more comparable nights
  than holding."
- **Cityscape:** "all warm-start with zero observed episodes — drop sizes and
  confidence are engine defaults, not lessons learned from this client."
- **Coorie Doon:** "same-day and next-day cuts on this account have essentially
  never produced a fill in the recorded history, yet two same-day
  recommendations carry high confidence."

Example flagged night (Cityscape, 20 Jul): *"The engine calls this on pace only
because it scales expectations down to this portfolio's low occupancy — the raw
curve says 91% of similar nights would be booked by now."* — exactly the
second-opinion overlay the design wanted; the verdict never changes the rec.

## Mark's live feedback (implemented mid-run, deployed)

1. Far-out "on pace" holds hidden by default (>4 days out; toggleable; held-back
   drops and actioned nights always visible).
2. Short "why" line; the sizing bullets carry the decomposition; full sentence in
   the expander.
3. Holds are ghost-scored (hold-validation evidence) while staying out of the
   drop calibration; the weekly settle re-mines the sizing evidence from live
   data. Rejections/approvals/edited prices are all recorded per night. NOT yet
   built (small follow-up if wanted): mechanically re-weighting the sizing
   formula from Mark's accept/reject pattern.

## Surprises & honest notes

- **Prod tenant names differ from dev**: "Stay Belfast" (no "Apartments") needed
  a short key var added mid-deploy; "Yo's House & Short Stay Harrogate" (with &)
  resolved fine. The Avantio sandbox is gone (Mark deleted it); a "Demo Property
  Manager" tenant exists.
- **Pre-graduation approvals are live by design** — Mark's explicit 18 Jul call
  overriding the earlier review's silent-window stance; the mitigations are the
  human gate on every push + provisional labels + the fidelity demotions.
- **Suggestion-table volume**: full 14-day coverage writes up to ~800 rows/day on
  the biggest client (superseded daily). A pruning job for superseded rows >120d
  old is the known follow-up (also flagged pre-build).
- **Engine forward-state evidence** (`--engines` warm-start sweep) was NOT run
  tonight — the market-context cache already collects the same forward view
  daily, and running the sweep during deploy verification would have contended
  with the same rate limits. `npm run recs:warmstart -- --prod --engines` any
  quiet afternoon if wanted; stored evidence is explicitly marked "insufficient
  for causal read" either way.
- **Dev-DB note**: I overwrote the local dev-DB password for mark@roomyrevenue.com
  (dev only, for page testing; password in no file — ask me) and added a
  `client-admin@example.test` dev user for gate testing. Prod users untouched.
- The day-30 readout emails, weekly learner report, and all client-facing
  dashboards are unchanged (recs rows are excluded from their streams; verified
  by the data-integrity review + isolation tests).

## Rollback

- **Kill switch (no redeploy):** set `RECS_PAGE_ENABLED=false` on the `Signals`
  service → page, nav links and APIs vanish.
- **Full rollback:** `git push --force-with-lease origin backup/prod-live:main`
  (= `0077566`), then restart `signals-worker`. Migrations are additive — safe to
  leave. Details: `RECS-PAGE-ROLLBACK.md`.
- **Per-night revert:** the Revert button on any applied row.

## Independent audit

**Verdict: SAFE-WITH-NOTES** (`RECS-PAGE-AUDIT.md`, fresh-context adversarial
pass). All 11 checks PASS: gates (incl. bypass attempts — spoofed headers,
fabricated cookies, case variants), cross-tenant construction attempts, no
push path without an explicit approval, floors + at-most-once idempotency,
self-tests fully reverted on both engines (prod PushLog holds ONLY selftest
rows — zero real pushes yet), full green gate re-run, live health vs baseline,
oversight isolation + degradation, customer-facing surfaces unchanged,
migration additive + applied. Findings: one LOW (the oversight cost figure
above — corrected), two INFO (regeneration churn vs first-gen counts; the two
failed-then-reverted selftest attempts that found the API-contract bugs).
