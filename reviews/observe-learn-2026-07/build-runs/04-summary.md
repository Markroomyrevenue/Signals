> **Update 2026-07-04:** everything below was subsequently built, independently audited (SAFE, three auditors) and **deployed live** (prod `7500a9e`, then `9e71e9f` docs). TO DEPLOY blocks below are historical. See DECISIONS.md entry 2026-07-04.

# Build run 04 — Regret semantics, artefact client rules, global aggregate

Prompt: `reviews/observe-learn-2026-07/BUILD-PROMPTS/04-fix-regret-rules-global-aggregate.md`
Branch: `feat/observe-learn-fixes-2026-07` · Starting commit: `7685c4a` · Date: 2026-07-03/04 (overnight, autonomous)

## TO DEPLOY (nothing deployed by this run — Mark was asleep)

Nothing here is live. Until deployed, prod keeps computing the degenerate regret daily and
the two false live rules (Little Feather `below_min_short_window` with
`allowBelowMinInShortWindows: true`; the pinned `tolerates_empty_premium` on the no-engine-key
tenants) stay in the profiles — and the day-30 readout on 2026-07-28 would email them.

1. No migration — all changes live inside existing JSON columns (`client_profiles.profile`,
   `global_methodology.methodology`) and code.
2. Merge/push `main` per the standing deploy protocol (backup tags first) → Railway
   auto-deploys the `Signals` web service.
3. **Restart the `signals-worker` Railway service** — the regret computation, the rules and
   the settle-time global rebuild all run in the worker.
4. Verify: after the next 05:30 observe run, the key-gated readout
   (`/api/observe/readout?...&format=text`) shows the new regret block per client
   (`windowDays: 90`, `baselineSource`, and `heldTooLowPct: null` for Coorie Doon / Yo's
   House) and the two artefact rules are gone from `profile.rules`. After the next Monday
   06:00 settle, `global_methodology` shows `samples` = number of current tenants (6, not
   42) and non-null `feeDragPctMean` that stays put through the week.

## What changed (one fix per commit)

| Commit | Change |
|---|---|
| `f0a804b` | **Regret over settled nights only.** `computeRegret` no longer counts forward availability (a night that books tomorrow is not a regret today). `held_too_high` = nights that expired empty in the trailing 90d IN EXCESS of a seasonal expectation — same-week-last-year (window shifted 364d, DOW-aligned) from `PaceSnapshot` where available (read-only; pace writing untouched), else a trailing same-DOW empty rate from `DailyAgg` over the year BEFORE the window. `held_too_low` = gross booked nightly rate (`Reservation.accommodationFare / nights`, not the discount-spread `revenueAllocated`) at/below the min in force NEAR the booking date (`nearestMinAt`: nearest `EngineSnapshot` by `capturedAt`, not the latest — kills the anachronistic-min flags), at lead ≥ 1.5× median; returns **null (not 0)** when the tenant has no min data. Near-zero-revenue nights (≤ £5: owner blocks, artefact rows) excluded from every input. `classifyRegret` is now called from the wrapper and the `none` class is restored, so the two shares no longer sum to 1 by construction. New pure cores: `computeSettledRegret`, `nearestMinAt` (in `learnings-core.ts`). |
| `2c5a9c3` | **Rule guards.** A rule may not fire on one-sided/absent input: below-min rule requires `heldTooLowPct !== null`; `tolerates_empty_premium` requires a seasonal baseline (`baselineSource !== "none"`). Every rule carries `n` + `windowDays`. `below_min_short_window` → `below_min_long_lead` with a description matching its actual trigger (long leads); `allowBelowMinInShortWindows` dropped — emitted as an observation (`observationOnly: true`), never a permission, until validated against settled outcomes. |
| `60565d6` | **Global aggregate = recompute-from-latest.** New `rebuildGlobalMethodology` (pure, equal weight per client, per-field sample counts, `samples` = contributing clients) + `recomputeGlobalMethodology` (DB): on each weekly settle the doc is rebuilt from the latest profile per CURRENT tenant. Daily runs stop folding entirely (they read the sample count only). Deleted-tenant ghosts evicted on next settle; feeDrag daily-null overwrite gone (recompute happens only on settle). `anonymiseForGlobal` + whitelist untouched; `mergeGlobalMethodology` kept for its unit tests, no longer the production path. `bootstrapOrUpdateGlobalMethodology` removed. |
| `a0feabd` | **Readout surfacing.** Regret block renders each figure as {value, n, window, baseline} with explicit insufficient-data states ("no engine min data — unmeasurable, not zero"; "no settled nights yet"). Rules render their n + window evidence. Defensive against pre-rewrite profile JSON until the next daily recompute. |
| (this commit) | Build-run summary. |

## Before/after profile values (LOCAL dev DB — prod not touched per overnight rules)

Recomputed every tenant's profile with the new code (temporary script, deleted after the run):

| Tenant | BEFORE (stored) | AFTER (new code) |
|---|---|---|
| Avantio Demo | regret=null · no rules | low=null high=0.000 total=85 baseline=none · no rules |
| Coorie Doon Stays | low=0.000 **high=1.000** (pinned) · **tolerates_empty_premium** | **low=null** high=0.000 total=3878 (empties 1803 vs ~3859 expected, trailing_dow) · **no rules** |
| Escape Ordinary | low=0.000 **high=1.000** · **tolerates_empty_premium** | low=null high=0.000 total=4293 · no rules |
| Little Feather Management | low=0.000 **high=1.000** · **tolerates_empty_premium** | low=null high=0.000 total=4076 · no rules |
| Stay Belfast Apartments | low=0.000 **high=1.000** · **tolerates_empty_premium** | low=null high=0.000 total=1269 · no rules |
| Yo's House/Short Stay Harrogate | low=0.000 **high=1.000** · **tolerates_empty_premium** | low=null high=0.000 total=2188 · no rules |

Global doc: BEFORE `samples=42`, `regret={heldTooLowPct:0, heldTooHighPct:1}` (the degenerate
pair). AFTER `samples=6`, `regret={heldTooLowPct:null, heldTooHighPct:0}`, `regretSamples=6`,
`regretHeldTooLowSamples=0`, feeDrag preserved. **Both artefact rule classes disappear on
recompute, confirmed.** (`heldTooLowPct` is null for ALL tenants locally because the dev DB has
no `EngineSnapshot` min rows; on prod the PriceLabs tenants have min data, so Little Feather's
held-too-low becomes a measured value there — expected to fall well below 0.849 once compared
against booking-time mins and gross rates. Prod's `below_min_short_window` rule disappears
either way: the key no longer exists and the permission param is never emitted.)

## Test evidence (full green gate at `a0feabd`)

- `npm run typecheck` — exit 0
- `npm run lint -- --max-warnings=0` — exit 0
- `npm run test:tenant-isolation` — "Tenant isolation check passed."
- `npm run test:observe` — **142/142 pass** (124 at baseline; +18 new/updated). New coverage:
  pcts no longer sum to 1 (a `none` case exists); `heldTooLow` null without min data and the
  dependent rule does not fire; zero/near-zero-revenue nights excluded; anachronistic-min case
  (min raised after booking) no longer flags, with a control asserting the latest-min comparison
  WOULD have; no-baseline ⇒ `baselineSource: "none"` and the empty-premium rule blocked; global
  rebuild weights clients equally, per-field sample counts, deleted tenant drops on next
  rebuild, null `heldTooLowPct` skipped not zeroed; rebuild-path leak check (no ids/raw rates);
  readout regret {value,n,window} + insufficient-data states + rule evidence rendering.
- `npm run test:observe-schedule` — 6/6 pass.

## Notes for auditors

- **Pace YoY baseline never engaged locally** (no year-old `PaceSnapshot` rows in the dev DB);
  every tenant fell back to `trailing_dow` from `DailyAgg`. On prod the pace path engages only
  where snapshot history reaches back 364d+; the fallback chain (pace → DailY-agg DOW → none +
  rule guard) is the designed behaviour, not an error.
- Local `trailing_dow` expected-empty rates are ~1.0 because the dev `daily_aggs` history shows
  near-zero occupancy in the pre-window year — a property of the dev data, not the formula
  (Coorie Doon's 3859.4/3878 shows the per-DOW rates varying).
- The pace-baseline query loads (stayDate, snapshotDate) pairs where both fall inside the
  shifted 90d window and filters snapshotDate == stayDate in JS (Prisma cannot express column
  equality); worst case a few tens of thousands of small rows once nightly. Multi-unit listings
  are treated at listing-night granularity in the baseline (undercounts empties — conservative,
  commented).
- `ClientProfileDoc.regret` gained fields and `heldTooLowPct` became nullable; old-shape
  profile JSON in prod renders defensively in the readout and is fully replaced on the first
  post-deploy daily run.
- The global doc shape changed (`leadTimeSamples`, `regretHeldTooLowSamples`, nullable regret
  pcts, `samples` = clients). The stored prod doc is overwritten wholesale on the first
  post-deploy Monday settle; nothing reads the old shape in between except the readout, which
  does not render the global doc.
- Rule key rename `below_min_short_window` → `below_min_long_lead`: nothing else in `src/`
  references either key (grepped); prod profiles carrying the old key are overwritten daily.
- Pre-existing untracked files (`.claude/`, `RELIABILITY-FINDINGS.md`, `trial-reports/`,
  `OBSERVE-LEARN-REVIEW-CLAUDE-CODE-PROMPT.md`) were present before this run and left alone.
