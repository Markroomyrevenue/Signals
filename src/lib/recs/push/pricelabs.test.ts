import assert from "node:assert/strict";
import test from "node:test";

import { createPriceLabsPushAdapter } from "./pricelabs";
import type { RecsPushTarget } from "./types";

const FAKE_KEY = "pl_live_secret_value_1234567890"; // not real
const noSleep = async (): Promise<void> => undefined;

function target(overrides: Partial<RecsPushTarget> = {}): RecsPushTarget {
  return {
    tenantId: "t1",
    tenantName: "Cityscape",
    clientKey: "cityscape",
    suggestionId: "sug-42",
    listingId: "l1",
    engineListingId: "12345",
    date: "2027-04-01",
    price: 117.6,
    currency: "GBP",
    floor: null,
    floorUnknown: false,
    oldValue: 130,
    ...overrides
  };
}

type Recorded = { url: string; method: string; body: unknown };

/** Route-based fake PriceLabs API. Records every call. */
function makeFetch(routes: {
  listings?: unknown;
  overridesGet?: unknown;
  onWrite?: (rec: Recorded) => Response | undefined;
}): { fetchImpl: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const rec = { url: u, method, body };
    calls.push(rec);

    if (method === "GET" && u.endsWith("/listings")) {
      return new Response(JSON.stringify(routes.listings ?? { listings: [] }), { status: 200 });
    }
    if (method === "GET" && u.includes("/overrides?")) {
      return new Response(JSON.stringify(routes.overridesGet ?? { overrides: [] }), { status: 200 });
    }
    const custom = routes.onWrite?.(rec);
    if (custom) return custom;
    return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const LISTINGS = {
  listings: [
    { id: 12345, pms: "guesty" },
    { id: 67890, pms: "hostaway" }
  ]
};

test("execute POSTs an INTEGER price with price_type fixed, the suggestion reason, and the listing's pms", async () => {
  const { fetchImpl, calls } = makeFetch({ listings: LISTINGS });
  const adapter = createPriceLabsPushAdapter({ apiKey: FAKE_KEY, fetchImpl, sleepImpl: noSleep });

  const out = await adapter.execute(target({ price: 117.6 }));
  assert.equal(out.ok, true);

  const post = calls.find((c) => c.method === "POST");
  assert.ok(post, "no POST recorded");
  assert.ok(post!.url.endsWith("/listings/12345/overrides"));
  const body = post!.body as {
    overrides: Array<{ date: string; price: number; price_type: string; reason: string }>;
    pms: string;
  };
  assert.equal(body.pms, "guesty", "pms must come from the account's listing payload");
  assert.equal(body.overrides.length, 1);
  assert.equal(body.overrides[0].date, "2027-04-01");
  assert.equal(body.overrides[0].price, 118, "price must be rounded to an integer");
  assert.ok(Number.isInteger(body.overrides[0].price));
  assert.equal(body.overrides[0].price_type, "fixed");
  assert.equal(body.overrides[0].reason, "signals-rec sug-42");
});

test("pms resolution uses the memoised GET /listings — one listings call across execute + verify", async () => {
  const { fetchImpl, calls } = makeFetch({ listings: LISTINGS, overridesGet: { overrides: [] } });
  const adapter = createPriceLabsPushAdapter({ apiKey: FAKE_KEY, fetchImpl, sleepImpl: noSleep });

  await adapter.execute(target({ engineListingId: "67890" }));
  await adapter.verify(target({ engineListingId: "67890" }));

  const listingCalls = calls.filter((c) => c.method === "GET" && c.url.endsWith("/listings"));
  assert.equal(listingCalls.length, 1, "GET /listings must be memoised per adapter instance");
  const verifyGet = calls.find((c) => c.method === "GET" && c.url.includes("/overrides?"));
  assert.ok(verifyGet!.url.includes("pms=hostaway"), "verify GET must carry the listing's pms");
  assert.ok(verifyGet!.url.includes("start_date=2027-04-01"));
  assert.ok(verifyGet!.url.includes("end_date=2027-04-01"));
});

test("a listing id NOT in the account blocks preview and fails execute with a clear error", async () => {
  const { fetchImpl } = makeFetch({ listings: LISTINGS });
  const adapter = createPriceLabsPushAdapter({ apiKey: FAKE_KEY, fetchImpl, sleepImpl: noSleep });

  const preview = await adapter.preview(target({ engineListingId: "99999" }));
  assert.equal(preview.ok, false);
  assert.equal(preview.blockedReason, "listing_not_in_engine_account");

  await assert.rejects(
    () => adapter.execute(target({ engineListingId: "99999" })),
    (err: unknown) => {
      assert.ok((err as Error).message.includes("99999"));
      assert.ok((err as Error).message.includes("not in this account"));
      return true;
    }
  );
});

test("verify accepts the override row's STRING price within 0.5 of the pushed integer", async () => {
  const { fetchImpl } = makeFetch({
    listings: LISTINGS,
    overridesGet: {
      overrides: [
        { date: "2027-04-01", price: "118.0", price_type: "fixed", currency: "GBP", reason: "signals-rec sug-42" }
      ]
    }
  });
  const adapter = createPriceLabsPushAdapter({ apiKey: FAKE_KEY, fetchImpl, sleepImpl: noSleep });

  const verify = await adapter.verify(target({ price: 117.6 })); // pushed 118
  assert.equal(verify.attempted, true);
  assert.equal(verify.verified, true);
  assert.equal(verify.observedPrice, 118);
});

test("verify fails on a missing row and on a wrong price", async () => {
  const missing = makeFetch({ listings: LISTINGS, overridesGet: { overrides: [] } });
  const adapterMissing = createPriceLabsPushAdapter({
    apiKey: FAKE_KEY,
    fetchImpl: missing.fetchImpl,
    sleepImpl: noSleep
  });
  const noRow = await adapterMissing.verify(target());
  assert.equal(noRow.verified, false);
  assert.equal(noRow.observedPrice, null);

  const wrong = makeFetch({
    listings: LISTINGS,
    overridesGet: { overrides: [{ date: "2027-04-01", price: "150.0" }] }
  });
  const adapterWrong = createPriceLabsPushAdapter({
    apiKey: FAKE_KEY,
    fetchImpl: wrong.fetchImpl,
    sleepImpl: noSleep
  });
  const badPrice = await adapterWrong.verify(target({ price: 118 }));
  assert.equal(badPrice.verified, false);
  assert.equal(badPrice.observedPrice, 150);
});

test("revert DELETEs with date-only override rows + pms, and verifyReverted passes once gone", async () => {
  const { fetchImpl, calls } = makeFetch({ listings: LISTINGS, overridesGet: { overrides: [] } });
  const adapter = createPriceLabsPushAdapter({ apiKey: FAKE_KEY, fetchImpl, sleepImpl: noSleep });

  const out = await adapter.revert(target());
  assert.equal(out.ok, true);
  const del = calls.find((c) => c.method === "DELETE");
  assert.ok(del, "no DELETE recorded");
  assert.ok(del!.url.endsWith("/listings/12345/overrides"));
  const body = del!.body as { overrides: Array<Record<string, unknown>>; pms: string };
  assert.equal(body.pms, "guesty");
  assert.deepEqual(body.overrides, [{ date: "2027-04-01" }], "delete rows carry the date ONLY");

  const gone = await adapter.verifyReverted(target());
  assert.equal(gone.verified, true);
});

test("verifyReverted fails while the override row is still present", async () => {
  const { fetchImpl } = makeFetch({
    listings: LISTINGS,
    overridesGet: { overrides: [{ date: "2027-04-01", price: "118.0" }] }
  });
  const adapter = createPriceLabsPushAdapter({ apiKey: FAKE_KEY, fetchImpl, sleepImpl: noSleep });
  const still = await adapter.verifyReverted(target());
  assert.equal(still.verified, false);
  assert.equal(still.observedPrice, 118);
});

// ---------------------------------------------------------------------------
// Adversarial push-safety review additions (2026-07-18 overnight audit).
// ---------------------------------------------------------------------------

test("the production push path NEVER touches listing_prices — verify + verifyReverted read GET /overrides only", async () => {
  // listing_prices runs on a 24h refresh cycle and lies about just-pushed
  // overrides; verification must come from the overrides read.
  const { fetchImpl, calls } = makeFetch({
    listings: LISTINGS,
    overridesGet: { overrides: [{ date: "2027-04-01", price: "118.0" }] }
  });
  const adapter = createPriceLabsPushAdapter({ apiKey: FAKE_KEY, fetchImpl, sleepImpl: noSleep });

  await adapter.preview(target());
  await adapter.execute(target({ price: 117.6 }));
  await adapter.verify(target({ price: 117.6 }));
  await adapter.revert(target());
  await adapter.verifyReverted(target());

  const listingPriceCalls = calls.filter((c) => c.url.includes("listing_prices"));
  assert.equal(listingPriceCalls.length, 0, "listing_prices must never appear in the push flow");
  const verifyReads = calls.filter((c) => c.method === "GET" && c.url.includes("/overrides?"));
  assert.equal(verifyReads.length, 2, "verify and verifyReverted each read GET /overrides");
});

test("readCurrentPrice pulls the date's price from POST /listing_prices", async () => {
  const { fetchImpl, calls } = makeFetch({
    listings: LISTINGS,
    onWrite: (rec) => {
      if (rec.url.endsWith("/listing_prices")) {
        return new Response(
          JSON.stringify([
            { id: "12345", data: [{ date: "2027-04-01", price: 142, min_stay: 2 }] }
          ]),
          { status: 200 }
        );
      }
      return undefined;
    }
  });
  const adapter = createPriceLabsPushAdapter({ apiKey: FAKE_KEY, fetchImpl, sleepImpl: noSleep });

  const price = await adapter.readCurrentPrice("12345", "2027-04-01");
  assert.equal(price, 142);
  const post = calls.find((c) => c.url.endsWith("/listing_prices"));
  assert.deepEqual(post!.body, { listings: [{ id: "12345", pms: "guesty", dateFrom: "2027-04-01", days: 1 }] });
});
