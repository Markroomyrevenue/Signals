# BUILD-LOG.md

Running notes from Claude's autonomous overnight builds. Each entry is dated
and explains decisions made on the owner's behalf — especially any place where
the spec was ambiguous and Claude had to pick. The current entry threads
together the **Peer-Fluctuation Pricing** + **Manual Override** features as
described in `PEER-BASE-AND-MANUAL-OVERRIDES-PROMPT.md`.

---

## 2026-04-29 — Peer-Fluctuation Pricing + Manual Override

### Background context (read before each decision below)

The codebase already contains a TEMPORARY model called `peer_shape` in
`src/lib/pricing/peer-shape.ts`. It activates when the existing
`hostawayPushEnabled` flag is `true` and a manual base price has been saved.
Mathematically the existing peer-shape factor (`peer_rate / peer_yearly_adr`)
and the requested peer-fluctuation factor (`(peer_rate - peer_yearly_adr) /
peer_yearly_adr`) are interchangeable: factor = (1 + fluctuation). The
operational differences are about safety guards, fallback strategy, and which
toggle controls the daily push.

### Decisions

**1. Peer-fluctuation is added as a NEW first-class mode, not a rename of
peer-shape.**

Why: the trial spec (KEYDATA-TRIAL-PROMPT) already ships peer_shape with the
`hostawayPushEnabled` toggle in production. The new prompt explicitly asks for
*its own* `peerFluctuationPushEnabled` toggle so "the two systems can't
accidentally interfere." Renaming would break the trial and conflate the two
paths. Instead I added an explicit `pricingMode: 'standard' |
'peer_fluctuation'` setting and routed the new mode through a fresh module
(`src/lib/pricing/peer-fluctuation.ts`) that calls the existing peer-shape
aggregator with stricter parameters:

  - `minPeersPerDate = 2` (vs. peer-shape's 1) per spec A.2 step 3.
  - Sanity cap `±50%` clamp on the aggregate factor per spec A.2 step 4. The
    existing peer-shape has no cap.
  - LOS filter raised from `< 7` (peer-shape's short-stay cutoff) to `<= 14`
    on the historical 365d ADR, to match `deriveOwnHistoryBaseSignal` per
    spec A.2 step 2a.
  - Forward-date fallback prefers same-date-last-year booked rate (target
    date − 365d) per spec A.2 step 2c, NOT the peer-shape `booked-fallback`
    layer (which uses booked nights on the same forward date).

The two systems share the underlying primitive — `nightFact` reads, calendar
rate reads — but never trip each other's gates. A listing whose property-scope
`pricingMode = 'peer_fluctuation'` is excluded from peer-shape activation
even if `hostawayPushEnabled` is also on (settings UI prevents both, but
defensively the assembly checks pricingMode first).

**2. The peer-fluctuation listing is excluded from being a SOURCE for other
peer-fluctuation listings.**

Spec A.2 step 1 says source pool = "all listings in the same tenant where
pricingMode != 'peer_fluctuation'". Implemented exactly: when computing the
fluctuation for target listing T, the SQL `where listingId != T AND
pricingMode != 'peer_fluctuation'` is enforced via a tenant pre-filter. The
edge case where every listing is peer-fluctuation (target has no sources at
all) returns null factors for every date, and the assembly skips pricing
those dates per the spec.

**3. The new `peerFluctuationPushEnabled` toggle is per-property only.**

The existing `hostawayPushEnabled` resolves through the portfolio→group→
property hierarchy. For peer-fluctuation we keep the toggle property-scope
only — the spec's "Pending: push OFF" status is per-row and the UI is a flat
list of target listing IDs. This avoids confusing inheritance: a portfolio-
scope ON for peer-fluctuation push could accidentally fire on a freshly-added
listing before the user has set base/min.

**4. Manual override `'fixed'` skips minimum floor; `'percentage_delta'`
respects it.**

Per spec B.4. The fixed-price helper text in the modal makes this explicit:
"Minimum floor does NOT apply — set carefully." This is the owner's
explicit acceptance of floor risk for fixed prices.

**5. Auto-supersede on overlap runs in a Prisma transaction.**

Spec B.5 describes trim/split/soft-delete on overlap. Implemented as a single
`prisma.$transaction()` so two concurrent override creates can't race into
overlapping ranges. The transaction also writes the new row last so a failure
mid-supersede leaves no partial state.

**6. Override IDs are referenced from `HostawayPushEvent.overrideId` only when
the pushed value differs from the dynamic recommendation.**

Spec B.9 says "Pushed cells include the override ID." We attach the
override id to the audit event when the push actually contained an
override-adjusted rate, and leave it null when the cell wasn't touched by
the override (e.g. the override range didn't cover this push window).
This is implemented as a per-event single FK rather than per-cell because
HostawayPushEvent is one row per push; the payload JSON still contains the
full per-date breakdown for forensic purposes.

**7. `triggerSource` column on HostawayPushEvent: defaults to `'scheduled'`
to keep historical rows interpretable.**

Spec A.5 introduces `'scheduled' | 'manual'`. We default to `'scheduled'`
in the schema so the backfill of existing rows reads correctly (every prior
push was triggered by an admin clicking the manual button — but we don't
have that history, and treating them as scheduled is the safer "I didn't
explicitly act" default for an audit log).

**8. Defensibility audit `user_intent` verdict is purely text-driven.**

Spec B.10 says the audit shouldn't grade multiplier reasoning when an
override is present. The prompt template and renderer treat `user_intent`
as a fourth tier alongside defensible/borderline/questionable. The agent's
job for these cells is reduced to: "Does the override note + range make
sense?" The peer-fluctuation listings are likewise excluded from the
comparison agent and audit per spec A.7 — they have no PriceLabs
counterpart.

### Files created / modified in this build

See the PR diff. The summary lives at the end of `PEER-BASE-AND-MANUAL-
OVERRIDES-PROMPT.md` Part C.

### Open follow-ups (not blocking this build)

- Once the trial peer_shape is officially decommissioned, fold peer_shape
  into peer_fluctuation and drop the `hostawayPushEnabled`-as-mode-switch
  semantic. The `hostawayPushEnabled` flag would then mean "push is allowed
  to call Hostaway at all" — which is closer to what its name implies.
- Add a UI in the calendar that surfaces the "skip reason" for any dates
  the daily peer-fluctuation push elected not to push (e.g. "fewer than 2
  sources contributed"). Today this is only visible in the BullMQ job log.
