# Observe-and-Learn Review — Multi-Agent Audit Prompt

Copy-paste this whole file into Claude Code from the `signals` repo root.

---

## Mission

Run a multi-agent review of the observe-and-learn pricing system (`src/lib/observe/**`, shipped live 2026-06-27, commit lineage from `82841b3`). The question is not "does the code work". The question is:

**Is what this system is learning actually going to get Mark to his three end goals, and if not, what has to change, why, and how?**

The three end goals, in Mark's words:

1. **Improve the methodology.** Daily price drops currently feel finger-in-the-air. The learning should turn them into a defensible, evidence-based method.
2. **Train people on the method.** A new team member should be able to learn the daily-drop method from what this system captures and codifies.
3. **Train the app itself.** The app should eventually do the daily drops and give recommendations Mark can trust, with him approving rather than deriving.

Judge everything against those three goals. A learning signal that is elegant but serves none of them is a finding, not a feature.

## Mark's revenue philosophy (context, and itself under review)

The method the system should ultimately learn, in Mark's words: **be a little more competitive a little further out than competitors, to take charge of the booking window.** You are first to sharpen price, so you capture more of the high-value early bookings and end up with fewer gaps. Late drops still happen - in short-term rental every night counts for owners, so unfilled nights get dropped close-in - but that is the tactical tail, not the strategy. The strategy is deliberately not rigid: it requires reacting to the market and to what is landing.

Two instructions follow from this:

1. **Treat it as the target methodology, not as gospel.** Agents 1, 2 and 6 must also test it: does the data support that early competitiveness wins higher-value bookings and reduces gaps, under what conditions does it fail (e.g. leaving money on the table in genuinely inelastic windows), and how would we measure that honestly?
2. **Check the system can even see it.** The current suggestion trigger (empty + behind expected fill ⇒ drop) is close-in and reactive - it automates the tactical tail. Nothing obviously learns or recommends the far-out positioning move. If true, the learner is blind to the highest-leverage part of the method it is meant to codify.

## Hard constraints (read before anything else)

- **Read-only review.** No code changes, no schema changes, no migrations, no deploys, no worker restarts. Writing review documents (listed under Outputs) is the only writing allowed.
- **Live data access is read-only.** You may query prod via `DATABASE_PUBLIC_URL` with SELECT-only statements (psql or a throwaway Prisma script), and you may call `GET https://signals.roomyrevenue.com/api/observe/readout?key=$OBSERVE_READOUT_KEY`. Never run `prisma migrate` anything against prod. Never UPDATE/INSERT/DELETE.
- Read `CLAUDE.md` and `DECISIONS.md` in full first, per house rules.
- Work on a branch `review/observe-learn-2026-07`. Commit the review outputs there. Do not push to `main`, do not deploy. This stays local until Mark says otherwise.
- Outputs go in `reviews/observe-learn-2026-07/` at repo root.
- Prose style: UK English, plain language, no em dashes (en dashes are fine).

## Context you should load

- Spec: `SIGNALS-OBSERVE-LEARN-SPEC.md`. Build prompt: `SIGNALS-OBSERVE-LEARN-CLAUDE-CODE-PROMPT.md`.
- Code: `src/lib/observe/**` (learnings-core, learnings, client-profile, global-methodology, peer-ladder, suggestions, snapshot, observation-window, day30-runner, readout, engine adapters) plus the rate-scanner substrate (`RateScan`/`RateState`/`RateChange`/`BookingRateContext`) and the Prisma models: `EngineSnapshot`, `EngineChange`, `ObservationWindow`, `PeerControl`, `ClientProfile`, `GlobalMethodology`, `Suggestion`, `PushLog`.
- Live state: 5 tenants on the daily 05:30 Europe/London run; all currently on the hostaway-scan fallback (no engine API keys set in prod), so engine-reaction learning (learning #5) is starved for everyone right now. 30-day window gates suggestions, not observation; observation runs indefinitely.

## Preliminary hypotheses (verify or refute — do NOT treat as conclusions)

A first pass by the planning assistant suggested the following. Each agent must confirm or overturn these with cited evidence (file:line for code claims, actual row counts/values for data claims):

- H1: The system is strong on signal capture (seven learnings per client) but has **no closed loop**: once a suggestion is applied, nothing re-observes the outcome (booking, cancellation, realised revenue) and feeds it back into the suggestion logic or the profile.
- H2: Drops are validated by **pickup velocity only** (booked nights moved vs control), never by **revenue delta** (nights × rate, old vs new). A drop that fills a night at a rate that loses money overall would still score as a win.
- H3: The drop-sizing formula (`dropPct = min(0.25, max(0.05, (expectedFill − 0.5) × 0.5 + 0.05))`) and the confidence value (`min(0.9, expectedFill)`) are **hand-tuned constants wearing a learning costume** — nothing in the learning pipeline ever updates them.
- H4: `GlobalMethodology` aggregates statistics but contains **no causal recipes** — no rules of the form "when X, do Y, because Z" that a human could be trained on.
- H5: Attribution (48h `BookingRateContext` window) and the peer ladder (rungs 1/2/3, confidence 0.8/0.5/0.3) have untested validity: rung 3 has no counterfactual at all, and cancellations are never re-linked to the drop that won the booking.
- H6: Because all tenants run hostaway-scan, the system currently cannot distinguish RMS moves from Mark's moves, which undermines learning #5 and any "what did the human do differently from the engine" methodology extraction.
- H7: The suggestion engine only automates late reactive drops and captures nothing about far-out competitive positioning - no comp-set rate-position signal, no measure of early-window booking share or value, no suggestion type for "sharpen 60-120 days out". If so, it is blind to the core of Mark's stated strategy (see philosophy section) and goal 3 as currently built would automate the wrong half of the method.

## Agent roster

Spawn these as parallel subagents where independent. Each writes its own findings file in `reviews/observe-learn-2026-07/` and must (a) answer its charge questions, (b) rule on the hypotheses in its remit, (c) contribute at least **three improvement ideas that are not already implied by the current design or the hypotheses above** — the brief is to go beyond Mark's current thinking, not to polish it.

### Agent 1 — Revenue management scientist (`01-rm-science.md`)
Persona: 15 years of hotel/STR revenue management, has run pricing teams.
Charge: Are the seven learnings the *right* signals for a daily-drop method? What would a senior revenue manager look at before dropping a price that this system does not capture (booking curve vs pace targets, displacement risk, length-of-stay and orphan nights, day-of-week and seasonality interaction, comp-set rate position, event demand shape, channel mix)? Is "empty + behind expected fill ⇒ drop" the right trigger, or does it systematically drop nights that should be held? Is the 5–25% drop band defensible? Which learnings would they cut as noise?

### Agent 2 — Causal inference and experimentation statistician (`02-causal-stats.md`)
Persona: statistician who designs pricing experiments at a marketplace.
Charge: Can this design ever *prove* a drop worked? Audit: the 48h attribution window (why 48? what leaks?), the peer ladder as a control (selection bias, contamination once peers also get suggestions, rung-3's missing counterfactual), sample sizes at 5 tenants (is the 20-booking graduation floor statistically meaningful?), seasonality and demand confounds, min-price censoring, survivorship in the regret tallies, and the made-up confidence numbers. Specify the *minimum viable measurement design* that would let Mark say "drops of size X at lead time Y earn Z% more revenue" with honest uncertainty — including whether any randomisation (e.g. holdout nights or staggered application of suggestions) is feasible at this portfolio size.

### Agent 3 — Learning-systems engineer (`03-learning-loop.md`)
Persona: ML engineer who builds decision systems, allergic to "learning" that is actually a one-shot feature extractor.
Charge: Trace the full data flow and rule on H1/H3. Is anything actually *updated by outcomes*? Design the missing closed loop concretely for this codebase: what table records suggestion→outcome, what job re-scores applied suggestions after the stay date, how outcomes should adjust drop sizing and confidence over time (even a simple win-rate-per-bucket table beats hand constants), and how to prevent feedback contamination once the app's own suggestions start moving prices (the system learning from itself). Also: does GlobalMethodology transfer across clients legitimately, or does it average away exactly the per-client differences that matter?

### Agent 4 — Methodology codifier and trainer (`04-teachability.md`)
Persona: someone who writes training material for operational teams; cares about explainability, not code.
Charge: Goal 2 test. Take what ClientProfile + GlobalMethodology actually contain (pull real prod rows) and attempt to write down the decision procedure a new hire would follow on a Tuesday morning. Where does the attempt break — missing thresholds, missing reasons, missing worked examples? What must the system additionally capture or emit so the method becomes teachable (e.g. every suggestion carrying a human-readable "because" chain; a per-client one-pager; a decision tree with the actual learned numbers in it)? Deliver the honest partial version as `methodology-draft-v0.1.md` — the gaps in it ARE findings.

### Agent 5 — Live data auditor (`05-live-data-audit.md`)
Persona: sceptical data QA. SELECT-only against prod plus the readout endpoint.
Charge: Is the learner actually learning, one week in? Row counts and freshness for every observe table per tenant; are ClientProfiles populated and are the values sane (lead-time medians plausible? regret tallies non-degenerate? pricing-power labels stable run to run?); which learnings are empty or starved (expect #5) and which tenants will hit the 20-booking graduation floor and when; whether the peer ladder is finding rung-1 peers in practice or collapsing to rung 3; any evidence of the aggregation and dedupe bug classes that have bitten this app before (stale-run leakage, double counting). Numbers in the report, not adjectives.

### Agent 6 — Red team (`06-red-team.md`)
Persona: adversarial reviewer whose job is to describe how this system confidently reaches wrong conclusions and damages revenue.
Charge: Failure narratives with mechanisms, not vibes. At minimum: learning from its own actions once suggestions are applied (death spiral: drop → booking → "drops work" → drop more); peer contamination; a bad season being read as "hold higher fails"; drop suggestions racing the RMS's own daily moves (double-dropping); a client whose profile is built on 20 unrepresentative bookings; and the trust failure mode for goal 3 — one visibly stupid suggestion in week one costing Mark's confidence in all of them. For each: how would we detect it early, and what guard is missing?

### Agent 7 — Synthesiser (final, sequential — runs after 1–6)
Reads all six findings files. Produces the top-level deliverables below. Where agents conflict, the synthesiser rules and says why. No diplomatic averaging.

## Outputs (all in `reviews/observe-learn-2026-07/`)

1. **`REVIEW.md`** — the verdict. For each of the three goals: **on track / on track with changes / not on track as designed**, with the load-bearing evidence in one paragraph each. Then the ruling on H1–H6. Then the top findings ranked by impact on the goals. Maximum 3 pages; agent files carry the detail.
2. **`IMPROVEMENT-BACKLOG.md`** — every accepted improvement as: what, why (which goal it serves and what breaks without it), how (concretely, in this codebase), effort (S/M/L), and sequence. Separate "measure first" items from "build" items — the statistician's measurement design likely gates several builds.
3. **`BUILD-PROMPTS/`** — one ready-to-run Claude Code prompt file per top-priority improvement (aim for the top 3–5, not all of them), each self-contained, green-gated, and ending with the standard deploy-confirmation ask. These must respect CLAUDE.md constraints (tenant isolation, cancelled-pace logic untouched, no AirROI).
4. **`methodology-draft-v0.1.md`** — Agent 4's honest first-pass training doc, gaps marked inline as `[GAP: ...]`.
5. Append one entry to `DECISIONS.md` (append-only, bottom): date, "observe-learn review run", the three per-goal verdicts in one line each, and where the outputs live.

## Working rules

- Every code claim cites file:line. Every data claim cites the query and the returned numbers.
- Prefer "this is fine, leave it alone" findings where true — a review that recommends changing everything has failed. The cancelled-pace logic and anything in `src/lib/hostaway/**` are explicitly out of scope for change proposals.
- If prod is unreachable or `DATABASE_PUBLIC_URL`/`OBSERVE_READOUT_KEY` are not available in the environment, do not stall: run agents 1–4 and 6 on code only, have agent 5 output the exact queries it would have run, and flag the gap at the top of REVIEW.md.
- Finish by reporting: branch name, files written, the three per-goal verdicts, and the single most important next action.
