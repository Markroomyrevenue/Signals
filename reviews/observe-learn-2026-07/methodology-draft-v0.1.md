# The Daily Price-Drop Method – training draft v0.1

**Status: honest partial.** This is the decision procedure a new team member would follow on a
Tuesday morning, written *only* from what the observe-and-learn system actually captures and
emits as of 2026-07-03 (prod client profiles revision 7, global methodology revision 42, plus
the code that generates suggestions). Every place the procedure cannot be completed from the
system's own output is marked inline as `[GAP: ...]`. The gaps are findings, not padding: this
document is the Goal 2 test, and the gaps are where it fails.

Audience: a new revenue team member with STR basics but no knowledge of Mark's method.
Scope: the daily close-in drop routine. The far-out positioning strategy (being a little more
competitive a little further out than competitors) is Mark's actual core method and is covered
in section 6 – briefly, because the system captures nothing about it.

---

## 1. What you are trying to do

Every unfilled night costs the owner the whole night. The daily routine is: find the forward
nights that should have booked by now but have not, and sharpen their price before the window
closes. The system's one codified trigger is:

> An available night is **at risk** when the share of bookings that normally arrive at least
> this far ahead has passed 50%, and the night is still empty.

That is the entire codified trigger. It compares the night's days-to-stay against the client's
lead-time curve and flags nights "behind the curve".

[GAP: the 50% threshold (`RISK_FILL_THRESHOLD`, suggestions.ts:20) is a hand-set constant.
No emitted document says why 50%, whether it should differ by client, season, or day of week,
or what evidence supports it. A trainee cannot defend it to an owner. System change: learn
and emit the threshold per client from observed fill outcomes, with its evidence base.]

[GAP: "curve expects ~62% booked by now" in the suggestion reasons is subtly the wrong
number. It is the share of *eventual bookings* that normally land this far out, not the
probability the *night* is booked – the two only match at 100% final occupancy. Taught
literally, a trainee will systematically over-read urgency on low-occupancy properties.
System change: scale the curve by expected final occupancy before emitting it.]

## 2. Know your client first (the per-client profile)

Each client has a learned profile. Here are the four real ones (prod, 2026-07-03):

| Client | Median booking lead | What that means for you |
| --- | --- | --- |
| Stay Belfast | 25 days | Empty nights inside ~3-4 weeks deserve attention; beyond that, most bookings have not arrived yet. |
| Coorie Doon | 24 days | Similar close-booking market. |
| Yo's House / Harrogate | 39 days | Guests commit further out; an empty night 4 weeks out is already late. |
| Little Feather | 50 days, and 37% of bookings land 91+ days out | A far-booking client. Close-in panic drops fit this book worst; the battle is largely decided months out. |

This table is genuinely learned and genuinely useful: the same empty night 30 days out is
"fine" in Belfast and "behind" for Little Feather. Internalise your client's curve before
touching a price.

The profile also records "divergence rules" – habits where this client departs from the norm:

- Little Feather: "routinely sells at/below minimum in short booking windows" (84.9%).
- Stay Belfast: both "sells below min in short windows" (65.1%) AND "tolerates empty premium
  nights to the wire" (34.9%).
- Coorie Doon and Yo's House: "tolerates empty premium nights to the wire" (100%).

**Do not train on these rules yet.** They are currently unreliable:

[GAP: the two rule percentages always sum to 100% by construction (the "no regret" case is
never counted – learnings.ts:154-156), so nearly every client trips at least one rule and
Stay Belfast trips both, describing opposite habits at once. Worse, the 100% figures for
Coorie Doon and Yo's House are an artefact: detecting "sold below minimum" needs the
engine-side minimum price, which does not exist for hostaway-scan clients, so their
below-min count is forced to zero and everything lands in the other bucket. System change:
count no-regret outcomes, benchmark held-too-high against the booking curve, and suppress
the rule when its input data is absent.]

[GAP: the profile says every client's cancellation signal is "cheaper_cancel_more". This is
computed by comparing cancel rates of the cheapest third vs the most expensive third of
bookings *across the whole portfolio*, so it largely compares budget properties against
premium properties, not pricing decisions. Do not conclude "drops attract flaky guests"
from it. System change: compute within-listing, against that listing's own typical rate.]

[GAP: "Pricing power by date type" – which dates book regardless of price, i.e. the nights
you HOLD rather than drop – is null for every client. Its data source (daily_aggs) is empty
in production, and "event" dates can never be classified even in principle as written. This
is the single most important missing section of this manual: a drop method without a hold
method prices through every peak. System change: repair the aggregation feed and route the
trial events calendar into date typing.]

## 3. The Tuesday-morning routine (as the system supports it today)

1. **Open the pending suggestions for your client** (readout route or day-30 email). Each row
   gives: date, listing, current rate → proposed rate, revenue at risk, confidence, and a
   reason like "empty at 43d out; curve expects ~62% booked by now". They are sorted by
   revenue at risk – work top down.

   [GAP: suggestions only exist after the client's 30-day observation graduates. Today, all
   four clients are day 5/30 and there are zero suggestion rows in production. Until day 31
   this manual has no step 1, and neither do you. System change: generate shadow suggestions
   from day 1, clearly labelled unvalidated, so trainees can practise against them.]

2. **Sanity-check each proposed drop.** The system sizes drops between 5% and 25%, larger the
   further behind the curve the night is.

   [GAP: the sizing formula and its 5%/25% bounds are constants in code (suggestions.ts:76),
   never emitted, never updated by outcomes, and not explained in any suggestion. You cannot
   answer "why 12% and not 8%?" – and an owner will ask. System change: carry the size
   computation in each suggestion's detail field, and adjust the bounds from realised
   win rates once outcomes are recorded.]

   [GAP: the proposed price has NO floor. It is rate × (1 − drop%), unclamped
   (suggestions.ts:77) – nothing checks the listing minimum, and the client rules from
   section 2 are never consulted by the generator at all (the profile's only reader is the
   display layer). Until fixed, YOU are the floor: check the listing's minimum price by hand
   before applying anything. System change: clamp to min, and make the generator read the
   profile it is built from.]

3. **Check what you are NOT being shown.**

   [GAP: the system emits no "considered and held" list, so you cannot learn restraint from
   it – every example it ever shows you is a drop. It also caps at 50 rows per client with
   no indication of what fell off the list. System change: emit the top held-nights with
   reasons alongside the drops.]

4. **Apply approved changes and record the outcome.**

   [GAP: nothing closes the loop. There is no record linking a suggestion to what happened
   next (booked? at what rate? cancelled later?), so there are no worked examples in this
   manual – not one "we dropped £120→£102 at 14 days, it booked in 36 hours" story, which is
   how humans actually learn this job. System change: an outcomes table re-scored after each
   stay date, feeding both this manual's examples and the sizing formula.]

5. **Escalate when unsure.**

   [GAP: no escalation criteria exist anywhere in the system's output. When does a trainee
   act alone vs ask Mark? Suggested interim rule: act only on suggestions under 10% size for
   listings with no event overlap; queue the rest for review. System change: emit a
   per-suggestion "requires review" flag from size, event proximity, and confidence.]

## 4. What the "confidence" number means

Each suggestion carries a confidence (max 0.9). Treat it as ranking only.

[GAP: confidence is simply the expected-fill number capped at 0.9 (suggestions.ts:83) – it is
not a probability of anything and has never been calibrated against outcomes. Do not quote it
to owners as "90% confident". System change: replace with a win-rate-by-bucket from recorded
outcomes once the loop is closed.]

## 5. The global playbook (what transfers between clients)

The global methodology doc currently says, in effect: portfolio-wide median lead ~36 days;
regret split 38% dropped-too-cheap / 62% held-too-long; fee drag ~1.3% of gross; cheaper
bookings cancel more everywhere.

[GAP: these are running averages re-folded daily from the same four clients (42 "samples" =
client-runs, not clients), with the regret and cancellation caveats from section 2 baked in.
There are no rules of the form "when X, do Y, because Z" in it – nothing in the global doc
tells anyone what to DO. Treat it as background statistics, not a playbook. System change:
promote it to explicit conditional recipes with evidence counts, or stop presenting it as
methodology.]

## 6. The part this system does not see (and Mark's actual strategy)

Mark's stated method is to be a little more competitive a little further out than
competitors – win the high-value early bookings, take charge of the booking window, and treat
close-in drops as the tactical tail. **Nothing in this manual so far serves that method,
because the system captures nothing about it**: no comp-set rate position, no early-window
booking share, no far-out sharpening trigger. Everything above automates the tail.

[GAP: the highest-leverage part of the method is entirely absent from the system's output.
A new hire trained only on this document would learn reactive discounting and call it the
method. System change: capture comp-set position at 60-120 days and an early-booking-share
measure per client, and add a far-out "sharpen" suggestion type – see Agents 1 and 7.]

## 7. Glossary (terms as this system uses them)

- **Lead time**: days between booking creation and stay date.
- **Behind the curve**: an empty night whose lead time has passed the point where 50%+ of
  this client's bookings have normally already arrived.
- **Revenue at risk**: the night's current listed rate (not a modelled loss).
- **Regret (held too high)**: currently, any unbooked available night in the next 7 days –
  see the section 2 caveat before using this word with owners.
- **Regret (held too low)**: a night that sold at/below minimum far earlier than the typical
  lead (1.5× median), i.e. probably underpriced.

---

*Version 0.1, written 2026-07-03 from production data by the observe-learn review (Agent 4).
This document is deliberately incomplete: each [GAP] names the system change that would let
the next version delete it. When the gaps are closed, this becomes the real training manual;
until then it is evidence of what the system does not yet teach.*
