# Pushing live rates to Hostaway

Last updated: 2026-04-27

This is the doc for "how Signals pushes a recommended nightly rate to a
real Hostaway listing's calendar". It covers the proven schema, the
safety guards we built around the live-write loop, and the chronological
discovery of three failure modes you'll want to know about before
extending the integration.

If you only read one section, read **The proven schema** and **Verify
after push** — those two pieces are non-negotiable.

---

## The proven schema

Verified 2026-04-27 against listing **513515** (Mark Test Listing,
Little Feather Management). Source of truth in code:
[`src/lib/hostaway/push.ts`](../src/lib/hostaway/push.ts).

### OAuth scope

Hostaway uses **a single OAuth scope** for both read and write:

```
scope = "general"
```

Token endpoint:

```
POST /v1/accessTokens
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id=...&client_secret=...&scope=general
```

The same token works for the pull-side `HostawayClient` and the
push-side `HostawayPushClient`.

### Calendar update

```http
PUT /v1/listings/{listingId}/calendar
Content-Type: application/json
Authorization: Bearer {access_token}

{
  "startDate": "YYYY-MM-DD",
  "endDate":   "YYYY-MM-DD",
  "price":     <number>
}
```

**One range, one price.** A single price applies to every night in the
inclusive `startDate..endDate` window. Hostaway accepts either `price`
or `dailyPrice` for the field name; we send `price` because that's
what the GET response uses to read the value back, so any consistency
check stays trivially correct.

To push N different prices for N dates, make N PUTs (one per date,
with `startDate === endDate`). At Hostaway's ~10 req/sec rate limit
that's ~250ms per call, so a 30-day push is ~7.5 seconds end to end —
acceptable.

### Curl example

Sending £210 for 2026-05-15 to listing 513515:

```bash
curl -X PUT "https://api.hostaway.com/v1/listings/513515/calendar" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"startDate":"2026-05-15","endDate":"2026-05-15","price":210}'
```

Successful response: `200 OK` with `{"status":"success", "result": ...}`
shape.

### Reading the calendar back

```http
GET /v1/listings/{listingId}/calendar?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
Authorization: Bearer {access_token}
```

Response is `{ "result": [{ "date": "...", "price": ... }, ...] }`.
Each item exposes `price` or `dailyPrice` — the reader in
`fetchCalendarRates` accepts either.

---

## Verify after push (and why it exists)

After every push, we **GET the calendar back** and compare each pushed
date against the expected price. If anything is missing or wrong, we
record the push event with status `verify-mismatch` and surface a
clear error to the user.

This step is non-negotiable. Here's why.

### The silent-accept failure mode

On 2026-04-27, while iterating on the push payload shape, we hit a
class of failure where:

1. Our PUT returned `200 OK` with `{"status": "success"}`.
2. The Hostaway dashboard showed the prices unchanged.
3. A subsequent GET on the calendar returned the OLD prices.

In other words, **Hostaway silently accepts wrong-shape payloads**.
Variants that exhibit this behaviour include:

- `{ "dailyPrices": [{...}, ...] }`
- `{ "data": [{...}, ...] }`
- `{ "calendarDays": [{...}, ...] }`
- `{ "rates": [{...}, ...] }`

None of those write anything to the calendar, but all of them get a
2xx success response. Without a verify step, a payload-shape regression
looks fine in CI and fails silently in production — guests would book
at the old (potentially out-of-date) rate.

### Implementation

Verify-after-push lives in `executePushRates` at
[`src/lib/hostaway/push-service.ts`](../src/lib/hostaway/push-service.ts):

1. Run the PUT(s) for every date in the window.
2. Issue a GET for the same window.
3. Build a `Map<date, observedPrice>`.
4. For each pushed date, compare expected vs observed (tolerance 0.5
   to absorb floating-point rounding).
5. If any mismatches, record the push event as
   `status: "verify-mismatch"` and return an error like:
   *"Push accepted (200) but Hostaway calendar didn't reflect 3 of 30
   dates. Sample: 2026-05-15: sent 210 → Hostaway shows 195; ..."*.

If the verify GET itself fails (network, 5xx, etc.), the push is
still treated as successful — the PUT returned 2xx and the verify
failure shouldn't poison the result. We log the verify error to
stdout for diagnostics.

---

## The allowlist (`HOSTAWAY_PUSH_ALLOWED_HOSTAWAY_IDS`)

A comma-separated env var of Hostaway listing IDs that pushes are
permitted to target. When set, any push to a listing whose
`hostawayId` is **not** on the list is refused **server-side, before
the HTTP call**, with a recorded `status: "blocked-allowlist"` event.

### Current state (production)

```
HOSTAWAY_PUSH_ALLOWED_HOSTAWAY_IDS=513515
```

That's **Mark Test Listing** under Little Feather Management — the
single listing the owner wants Signals to write to during go-live.

### Why it's required

The owner does not want any push to listings other than the test
listing until they explicitly broaden it. The allowlist is the last
safety net between a misconfiguration / bug / accidental UI click
and a real money-affecting write. Even if every other guard fails
(role check, per-listing toggle, dry-run preview), the allowlist
will still block the call.

### When the allowlist is unset

If `HOSTAWAY_PUSH_ALLOWED_HOSTAWAY_IDS` is not set or is an empty
string, **no allowlist is enforced** — the push proceeds against
whatever listing the request targets. This is intentional for local
development against fake credentials, but it means **never run a
production environment without setting this env var** to at least
the test listing.

### Implementation

[`src/lib/hostaway/push-service.ts`](../src/lib/hostaway/push-service.ts)
in `executePushRates` — search for `HOSTAWAY_PUSH_ALLOWED_HOSTAWAY_IDS`.

---

## The audit log: `hostaway_push_events`

Every push attempt — successful, failed, or refused — is written to
the `hostaway_push_events` table. Schema lives in
[`prisma/schema.prisma`](../prisma/schema.prisma) as
`HostawayPushEvent`.

| Column | Meaning |
| --- | --- |
| `tenant_id` | Owning tenant (always set; tenant isolation is enforced). |
| `listing_id` | Internal `Listing.id`. |
| `pushed_by` | The user id that triggered the push (audit trail). |
| `date_from`, `date_to` | The inclusive date range the push targeted. |
| `date_count` | Number of dates that landed (0 for blocked / failed / skipped pushes). |
| `status` | One of: `success`, `failed`, `skipped`, `blocked-allowlist`, `verify-mismatch`. |
| `error_message` | Human-readable error, or `null` on success. |
| `payload` | Full preview JSON (every date + recommended rate + current rate at the time of push). |
| `created_at` | When the event was recorded. |

### What each `status` value means

- **`success`** — Hostaway returned 2xx for every PUT, AND the
  verify-after-push GET confirmed every pushed date now has the
  expected price on Hostaway's side. This is the only "rates landed"
  signal you should trust.
- **`failed`** — At least one PUT returned a non-2xx status, or a
  network error blew up the call. `error_message` has the details
  (Hostaway's response body, sliced to a manageable length).
- **`skipped`** — The push was attempted but the recommendation
  pipeline produced zero recommendable dates in the window. No HTTP
  calls were made. Most common cause: the listing's pricing settings
  didn't surface any recommended rates (e.g. all dates fall back to
  the live rate, no signal to push).
- **`blocked-allowlist`** — `HOSTAWAY_PUSH_ALLOWED_HOSTAWAY_IDS` is
  set, and the listing's Hostaway id is not on the list. No HTTP
  calls were made. The push is refused with a 403 to the user.
- **`verify-mismatch`** — The PUT(s) returned 2xx, but the
  verify-after-push GET found one or more dates whose price on
  Hostaway didn't match what we sent. Almost always indicates a
  payload-shape regression (silent accept). Treat as failure: rates
  did NOT land. `error_message` includes a sample of mismatched
  dates.

### Querying it

The most useful indices are:

- `(tenantId, listingId, createdAt DESC)` — "what's the most recent
  push event for this listing?"
- `(tenantId, createdAt DESC)` — "what pushes happened in this
  tenant lately?"

`findLastPushEventForListing` in `push-service.ts` is the helper
the calendar UI uses to render the "last push: success — 30 dates"
hint next to each listing.

---

## How to extend the push to more listings

The owner has explicitly said: only listing 513515 until they
broaden it. When they do, here's the sequence.

### 1. Confirm the listing is ready

In the calendar inspector for the listing, open the property
pricing card and check the **"Push live rates to Hostaway" toggle**.
If it's OFF, switch it ON. The toggle is per-listing and resolved
through `pricing_settings` (scope: property → group → portfolio →
default = false). See `hostawayPushEnabled` in
[`src/lib/pricing/settings.ts`](../src/lib/pricing/settings.ts).

### 2. If the listing is multi-unit, set `unit_count`

If the Hostaway listing actually represents N rooms of one type
(e.g. "Double Studio × 20"), set `unit_count` from the property
pricing card's multi-unit settings section. This switches the
pricing branch to the lead-time × occupancy matrix instead of the
single-unit occupancy multiplier — calendar UI will show the
"Multi-unit · N rooms" pill once it's set. See
[multi-unit-anchor.ts](../src/lib/pricing/multi-unit-anchor.ts).

### 3. Add the listing's `hostawayId` to the allowlist env var

On Railway (production), update the env var to include the new
listing IDs, comma-separated:

```
HOSTAWAY_PUSH_ALLOWED_HOSTAWAY_IDS=513515,123456,789012
```

Restart the service so the new env value takes effect (Next.js
runtime reads `process.env` at boot).

### 4. Dry-run from the calendar inspector

Open the date inspector on any cell of the listing and use the
"Preview push" button. It runs `buildPushRatesPreview` (no HTTP
calls) and shows you exactly what would be pushed. Confirm the
list looks right.

### 5. Real push

Click "Push to Hostaway" — runs `executePushRates`. Watch the
audit log row appear with `status: "success"` (or one of the
failure statuses). On success, the calendar refreshes and the
"last push" hint updates immediately.

---

## Lessons learned (chronological)

This is what 2026-04-27 looked like during the discovery phase, so
you don't have to re-run the same diagnostic cycles.

### Stage 1 — `403 Forbidden` after a fresh OAuth token

Initial pushes returned 403. We force-refreshed the token (defends
against stale-token cases) and retried — still 403.

What it actually meant: the Hostaway API key didn't have write
access to listing 513515 from our account, OR another integration
(PriceLabs) was claiming the listing. Hostaway's response body had
the diagnostic — we now surface it verbatim so the owner can act.

Code: `HostawayPushError` 403 branch in `push.ts`. Commits:
`694158a`, `285f355` improved the diagnostic.

### Stage 2 — `404 Not Found` on the per-date URL

We tried the natural-looking endpoint
`PUT /v1/listings/{id}/calendar/{date}` with a single-date body.
Hostaway returned 404 — that endpoint doesn't exist on the public
API.

What it actually meant: the per-date URL is not part of the
public surface. The range endpoint is the only way in. Commit:
`bcb8fc7`.

### Stage 3 — `200 OK` but the calendar didn't update

Switched to the range endpoint with array-style payloads
(`dailyPrices: [...]`, `data: [...]`, `calendarDays: [...]`).
Every PUT returned 200 with `{"status":"success"}`. The Hostaway
dashboard showed the prices unchanged.

What it actually meant: **silent accept of unrecognised payload
shapes**. Hostaway's PUT endpoint accepts the request, returns 200,
but never applies the prices. There is no way to detect this from
the response alone — they're indistinguishable from real successes.

This is what motivated the verify-after-push step. Commits:
`daf1748` (multi-shape attempt), `65c04c7` (locked the proven
schema + added verify-after-push + introduced the allowlist).

### Stage 4 — The proven schema

After exhausting the array variants, we tested the simplest
possible body — a single date range with a single `price` field —
and confirmed via GET-back that prices actually landed. That's
the schema this doc documents.

---

## Where to look in code

| Concern | File |
| --- | --- |
| HTTP client + retry / OAuth | [`src/lib/hostaway/push.ts`](../src/lib/hostaway/push.ts) |
| Per-tenant client factory | `getHostawayPushClientForTenant` in `push.ts` |
| Push pipeline (preview, allowlist, verify, audit) | [`src/lib/hostaway/push-service.ts`](../src/lib/hostaway/push-service.ts) |
| Audit table model | `HostawayPushEvent` in [`prisma/schema.prisma`](../prisma/schema.prisma) |
| Per-listing toggle resolution | `hostawayPushEnabled` in [`src/lib/pricing/settings.ts`](../src/lib/pricing/settings.ts) |
| Test coverage (no DB / network) | [`src/lib/hostaway/push-service.test.ts`](../src/lib/hostaway/push-service.test.ts) |

---

## Companion docs

- [`docs/PEER-SHAPE-PRICING.md`](./PEER-SHAPE-PRICING.md) — the
  temporary go-live pricing branch that fires only when
  `hostawayPushEnabled === true`.
- [`docs/PRICING-WORKED-EXAMPLE.md`](./PRICING-WORKED-EXAMPLE.md) —
  the standard base-price formula (used for everything that
  doesn't go live to Hostaway).
