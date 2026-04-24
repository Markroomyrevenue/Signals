# Agents for Signals — a practical plan

You asked: _"someone suggested I build agents inside my app that will
continuously improve and monitor it. What agents, how many, and what should
they specialise in?"_

Here is the short, honest answer, followed by a specific proposal.

## The short answer

There are **two distinct buckets** people mean when they say "agents":

1. **Development agents** — sub-agents in Claude Code / Cowork mode that help
   you write, test, review, and ship code faster. These run only when you're
   at your desk. Cost: basically free (part of Claude).
2. **Runtime agents** — background jobs that watch your _live_ app and your
   _live_ data, and either fix things automatically or alert you. These run
   24/7 in production and cost a bit in compute + LLM tokens.

You want both, but in that order. Start with the dev agents because they
compound on every future change. Layer on the runtime agents once the app is
live with staff using it, because that's when "bad things happening silently"
starts costing real money.

Do **not** start with five agents. One or two, used well, beats five that
nobody trusts.

---

## Bucket 1: Development agents (ship this first)

Four specialised agents, invoked manually when you need them. All of them are
defined as Claude Code sub-agents — a single markdown file each in
`.claude/agents/`. I can scaffold them for you whenever you say the word.

### 1. `reporting-reviewer` — the guard for your daily reports

_Role:_ every time you change anything under `src/lib/reports/`,
`app/api/reports/`, or `app/components/revenue-dashboard*`, this agent runs
against your diff and checks:

- Are date boundaries correct (stay-date vs booking-date, inclusive vs
  exclusive)?
- Does the new code handle cancelled bookings the same way the rest of the
  app does (via `cancelled_at`, not just `status`)?
- Does it respect `tenantId` filtering in every query (multi-tenancy
  isolation)?
- Does it return the same shape as the existing reports so the frontend
  doesn't silently break?

_Why it matters:_ reports are the product. A silent wrong number is worse
than an outage.

### 2. `ui-guardian` — the reporting UX watchdog

_Role:_ reviews any change to the sidebar, tabs, filters, or the login/team
pages. Catches things like:

- A new metric appearing for viewers that should be admin-only.
- Accessibility regressions (contrast, keyboard focus).
- Empty/loading/error states missing.
- Strings that assume GBP or Europe/London when a tenant has a different
  currency/timezone.

_Why it matters:_ your staff member is the first person other than you who
will use this. Their first bad experience is expensive.

### 3. `integration-auditor` — the Hostaway / Key Data safety net

_Role:_ every time `src/lib/hostaway/`, `src/workers/sync-worker.ts`, or the
webhook route changes, this agent:

- Diff-checks the Hostaway payload shape against what the sync code assumes.
- Flags any time we silently catch-and-swallow a Hostaway error (a classic
  source of silent data divergence).
- Reviews idempotency keys so a replayed webhook can't create duplicates.
- When you swap AirROI → Key Data, this agent's whole job is to make sure the
  anchor values feeding the pricing logic stay numerically comparable across
  the swap.

_Why it matters:_ bad ingestion is invisible for days, then catastrophic.

### 4. `release-planner` — your project-manager agent

_Role:_ you describe a change in plain English ("I want the Booked tab to
group by reservation creation date by default"). It returns a short
implementation plan: the files to touch, the database migrations (if any),
the tests to add, the rollout risk, and a checklist you can hand to Claude
Code or to Codex to execute.

_Why it matters:_ you have little coding experience. This agent is your
translator between "what the business needs" and "what the code needs to do".

### What I do _not_ recommend building right now

- A "code-writer" agent that edits whatever it likes. You already have Claude
  Code for that. Adding a second one on top just creates confusion.
- A "UI-designer" agent that generates Figma mocks. Not useful until you have
  a design system to compare against.
- A "security-reviewer" agent in parallel with the reporting-reviewer. Fold
  security checks into the three reviewers above — a dedicated agent for it
  adds friction without catching meaningfully more issues on a small codebase.

---

## Bucket 2: Runtime agents (ship these after staff onboarding)

Three jobs, each with a narrow and testable brief. All run on a schedule from
a small cron / cloud job and alert you via email or Slack.

### A. `sync-watchdog` (critical, ship first)

Runs every 15 minutes. For each tenant with an active Hostaway connection,
checks:

- `last_sync_at` is within the last 60 minutes.
- No `SyncRun` has been `status = "failed"` for > 2 consecutive attempts.
- The webhook has produced at least one message in the last 24h on a working
  day.

If anything is off, it opens a ticket / pings you. Without this you can lose
a day of bookings silently.

### B. `data-sanity-sentinel`

Runs nightly at 03:00 Europe/London. For each tenant:

- Compares `SUM(accommodation_fare) from reservations` against
  `SUM(revenue_allocated) from night_facts` for each of the last 30 days.
  More than 1% drift = alert (almost always a bug in the allocation logic).
- Counts occupied nights per listing vs CalendarRate availability — big
  mismatches are either sync bugs or stale calendars.
- Flags any reservation where `cancelled_at IS NOT NULL` but `status !=
  cancelled` (defensive — should never happen, but we'd want to know).

This is the agent that lets you sleep at night once a second staff member is
using the tool and you're not personally eyeballing every number.

### C. `pace-anomaly-detector` (optional, phase 2)

Each morning it runs the pace report for every tenant and asks, in plain
English via an LLM call: _"is there anything in here that looks out of
character vs the last 30 days?"_. Examples it would flag: a channel pause
(Booking.com pickup falls to zero), a listing that has 0 bookings for 14 days
when it normally has 3+, a sudden spike in cancellations on a specific date.

Keep this one for phase 2 — it's the kind of agent people build too early
because it sounds cool, then turn off because it alert-fatigues them. Earn
the right to deploy it by getting A and B stable first.

---

## Suggested sequencing

| Week | What ships | Why |
|------|-----------|-----|
| 1 (now) | Reporting-reviewer, UI-guardian, Release-planner dev agents | Compound on every future change, including the shipping work itself |
| 2 | Live on `signals.roomyrevenue.com` + staff onboarded | Per `SHIP-SIGNALS.md` |
| 3 | Integration-auditor dev agent | Just before Key Data swap |
| 4 | Sync-watchdog runtime agent | As soon as your sync is the source of truth for two humans |
| 6–8 | Data-sanity-sentinel runtime agent | Once you have enough daily history to set thresholds confidently |
| 10+ | Pace-anomaly-detector | Only if A+B have been silent for ≥ 2 weeks and you want a pro-active layer |

---

## What I need from you to start

One decision: do you want me to scaffold the four dev agents now as a single
PR? I will drop four small `.claude/agents/*.md` files into this repo with
each agent's brief, scope, and "when to invoke" — you'll then be able to call
them by name from Claude Code (e.g. `/agent reporting-reviewer`) or they'll
auto-trigger on matching file edits.

Runtime agents are a separate piece of work I'd do against the live Railway
stack, not this repo, and I would not start on them until
`signals.roomyrevenue.com` is serving real traffic. Until then they are
premature optimisation.
