# Signals — Calendar Fixes: INDEPENDENT Post-Review (Claude Code prompt)

> Run this in a **fresh Claude Code session** AFTER the main calendar run
> (`CALENDAR-AUDIT-CLAUDE-CODE-PROMPT.md`) has deployed and pushed.
> Its job is to **distrust the first run** and independently confirm the calendar pricing is correct,
> the hourly push is safe, and live Hostaway rates are right — or catch what was missed or broken.
> Mark has little coding experience; verify it yourself and report plainly.

## ROLE & MANDATE
You are an **independent reviewer**. A previous run changed Signals' occupancy pricing (denominator,
group/building scope, a 3-way scope selector), added an **hourly** occupancy recompute + push for
sync-toggled listings, and deployed live across **Little Feather, The Edge, Alma Place**. You did
not do that work and must not take it on trust. Deliverable: a verdict — **SHIP-SAFE** or
**NOT-SAFE** — backed by your **own** evidence, not by re-reading the first run's report.

Read `CLAUDE.md`, `DECISIONS.md`, and the first run's artefacts (`CALENDAR-INVENTORY.md`,
`CALENDAR-FINDINGS.md`, `CALENDAR-AUDIT-REPORT.md`, `CALENDAR-ROLLBACK.md`) only to know what to
test — treat every claim as a hypothesis. Cross-check against the **Hostaway API directly**.

> NOTE: the first run's `git clean` deleted this prompt file last time. Before doing git cleanup,
> move any loose prompt/`*.md` you want to keep out of the working tree first, or commit them.

## WHAT TO DO
1. **Independent occupancy recompute.** Write your OWN recomputation (do not reuse the first run's
   `audit:occupancy` harness) of `booked ÷ (booked + available)` excluding blocked, per date, for
   all three tenants, and compare to what the **live** calendar serves. Any delta beyond rounding =
   finding. Independently confirm the blocked-unit exclusion and the fallback-to-total-count path
   (and that fallback only fires where Hostaway truly lacks the split).
2. **Scope isolation + scope independent of grouping.** Prove **Alma Place is absent from The Edge's
   denominator** and vice versa (pick dates, show the member list and the sums). Confirm the 3-way
   scope selector (Portfolio/Group/Individual) persists and actually drives the math. Confirm
   single-unit members of a group now receive occupancy pricing and that the old `unitCount >= 2`
   gate no longer wrongly excludes them — without breaking the standalone property path.
   **CRITICAL (Mark's follow-up):** occupancy scope must be **fully independent of group
   membership**. A listing must be settable to **Portfolio** or **Individual** scope *while it
   stays in its group* — groups are for viewing/filtering only and must NOT force group scope, and
   Mark must NOT have to remove a listing from its group to price it individually. Test concretely:
   take a grouped listing, set Occupancy scope = Individual, save, and confirm (a) it now prices on
   **itself alone** (its own booked/available), (b) it is **still a member of the group** for
   filtering, and (c) the other group members are unaffected. Repeat for Portfolio scope on a
   grouped listing.
3. **Reactivity / guardrails.** Full reactivity is intended (a 10 → 80 availability jump *should*
   drop the price), so volatility itself is NOT a defect. Independently model The Edge's July release
   curve only to confirm the **guardrails** hold: no pushed rate falls below the min floor
   (`round(base × 0.7)`) or exceeds the matrix cell's %. A guardrail breach is NOT-SAFE; swing size
   alone is not.
4. **Hourly push safety.** Confirm the hourly job: selects strictly by the push toggle (not a fixed
   count), pushes **only changed** rates, respects `HOSTAWAY_PUSH_ALLOWED_HOSTAWAY_IDS`, backs off on
   429, and does not double-fire (no stale duplicate repeatables). Verify on Hostaway that a sample
   of live rates matches your independent recompute. Confirm **only the listings Mark approved at the
   allowlist gate** are receiving live writes — nothing extra.
5. **Pipeline + regression.** Re-verify the full price build (`base → occupancy → seasonality → DoW →
   pace → demand → override → min floor`) composes correctly and the min floor `round(base × 0.7)`
   holds; no double-count; manual/fixed overrides still win. Re-run `npm run typecheck`,
   `lint --max-warnings=0`, `test:tenant-isolation`, the suite, `build`. Re-grep calendar/push
   queries for missing `tenantId`. Re-screenshot the calendar (mobile/tablet/desktop) for overlap.
   Also verify the two UI follow-ups Mark handed to the build run:
   (a) **Duplicate group filter removed** — the calendar previously had TWO group filters, one
   working and one dead. Confirm exactly **one** group filter remains, it works, and the dead one is
   fully gone (no orphaned component, handler, state, or query left behind — grep for the removed
   filter's identifiers).
   (b) **Push-frequency label corrected** — the UI must read **hourly** everywhere; confirm NO stale
   "5×/day" / "5x" / "5 times a day" / old fixed-time (06:30/10:30/…) push-cadence text survives
   anywhere in the calendar or settings UI. Grep the codebase for those strings and confirm the
   label now reflects the actual hourly schedule.
6. **Live health + worker.** Health-check prod root + calendar routes; confirm **web AND
   `signals-worker` run the new commit** and the **hourly schedule is registered** (logs); confirm any
   migration is applied (no `P2021`/`P2022`); confirm `backup/prod-live` and the rate-revert snapshot
   exist and the rollback commands in `CALENDAR-ROLLBACK.md` are correct.
7. **If you find a regression or mispush:** if small/safe, fix it, re-run the green gate, redeploy,
   self-heal per protocol. If risky or it touches owner-confirmed `pace.ts` logic, or would change a
   live rate unexpectedly — **do not ship**; document precisely for Mark. If a bad rate is live,
   recommend/execute the rate-revert to the Phase-0 snapshot. Stay within the self-heal cap; if you
   can't reach healthy, roll prod back, verify, and report the one blocker.

## DELIVERABLE — `CALENDAR-INDEPENDENT-REVIEW.md`
- **Verdict** (SHIP-SAFE / NOT-SAFE), one line, top.
- **Live health now:** status codes, web+worker on new commit, hourly schedule registered, migration
  applied.
- **Independent occupancy results:** your numbers vs the live calendar vs Hostaway, per tenant,
  PASS/FAIL — explicitly noting where you **disagree** with the first run.
- **Mark's asks:** group-scope isolation, **scope independent of grouping** (set Individual/Portfolio
  without leaving the group), availability denominator, hourly push, truthful calendar, the
  **de-duplicated group filter**, and the **corrected hourly push label** — each confirmed-done / not,
  with evidence.
- **Reactivity verdict** (guardrails held?) + any new findings (severity-ranked) and what you did
  about each.
- **Live writes:** exactly which listings are pushing, confirmed against the approved allowlist.
- **Residual risk + one-action next steps.** Append a dated entry to `DECISIONS.md`.

Be adversarial. A clean report that merely echoes the first run is a failed review — your value is
catching the mispriced date, the leaked denominator, or the duplicate cron the first run didn't.
