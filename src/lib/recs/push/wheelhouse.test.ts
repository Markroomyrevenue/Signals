import assert from "node:assert/strict";
import test from "node:test";

import { EngineHttpError } from "@/lib/observe/engine/http";

import { createWheelhousePushAdapter } from "./wheelhouse";
import type { RecsPushTarget } from "./types";

const FAKE_READ_KEY = "wh_read_secret_value_1234567890"; // not real
const FAKE_WRITE_KEY = "wh_write_secret_value_0987654321"; // not real
const noSleep = async (): Promise<void> => undefined;

function target(overrides: Partial<RecsPushTarget> = {}): RecsPushTarget {
  return {
    tenantId: "t1",
    tenantName: "Coorie Doon",
    clientKey: "coorie-doon",
    suggestionId: "sug-7",
    listingId: "l1",
    engineListingId: "407381",
    date: "2026-12-22",
    price: 95,
    currency: "GBP",
    floor: null,
    floorUnknown: false,
    oldValue: 105,
    ...overrides
  };
}

type Recorded = { url: string; method: string; body: unknown };

function makeFetch(handler: (rec: Recorded) => Response): {
  fetchImpl: typeof fetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const rec: Recorded = {
      url: String(url),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    };
    calls.push(rec);
    return handler(rec);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function adapterWith(handler: (rec: Recorded) => Response) {
  const { fetchImpl, calls } = makeFetch(handler);
  const adapter = createWheelhousePushAdapter({
    readKey: FAKE_READ_KEY,
    writeKey: FAKE_WRITE_KEY,
    fetchImpl,
    sleepImpl: noSleep
  });
  return { adapter, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

test("preview BLOCKS when the date sits inside an owner range we did not create", async () => {
  const { adapter } = adapterWith((rec) => {
    if (rec.method === "GET") {
      // The December owner-adjustment style row: multi-day, not ours.
      return json([{ start_date: "2026-12-20", end_date: "2026-12-27", rate_type: "fixed" }]);
    }
    return json({});
  });
  const preview = await adapter.preview(target({ date: "2026-12-22" }));
  assert.equal(preview.ok, false);
  assert.equal(preview.blockedReason, "owner_custom_rate_conflict");
});

test("preview allows an exact single-day row on the target date (our own previous push)", async () => {
  const { adapter } = adapterWith((rec) => {
    if (rec.method === "GET") {
      return json([{ start_date: "2026-12-22", end_date: "2026-12-22", rate_type: "fixed" }]);
    }
    return json({});
  });
  const preview = await adapter.preview(target({ date: "2026-12-22" }));
  assert.equal(preview.ok, true);
});

test("preview allows when no custom-rate rows exist or none touch the date", async () => {
  const { adapter } = adapterWith((rec) => {
    if (rec.method === "GET") {
      return json([{ start_date: "2027-01-10", end_date: "2027-01-15" }]);
    }
    return json({});
  });
  const preview = await adapter.preview(target({ date: "2026-12-22" }));
  assert.equal(preview.ok, true);
});

test("execute PUTs a single-day fixed range with the price in ALL seven DOW fields + both auth headers", async () => {
  let seenHeaders: Headers | null = null;
  const calls: Recorded[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seenHeaders = new Headers(init?.headers);
    const rec: Recorded = {
      url: String(url),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    };
    calls.push(rec);
    return json({ ok: true });
  }) as unknown as typeof fetch;
  const adapter = createWheelhousePushAdapter({
    readKey: FAKE_READ_KEY,
    writeKey: FAKE_WRITE_KEY,
    fetchImpl,
    sleepImpl: noSleep
  });

  const out = await adapter.execute(target({ price: 95 }));
  assert.equal(out.ok, true);

  const put = calls.find((c) => c.method === "PUT");
  assert.ok(put, "no PUT recorded");
  assert.ok(put!.url.includes("/listings/407381/custom_rates"));
  assert.ok(put!.url.includes("channel=hostaway"));
  const body = put!.body as Record<string, unknown>;
  assert.equal(body.start_date, "2026-12-22");
  assert.equal(body.end_date, "2026-12-22");
  assert.equal(body.rate_type, "fixed");
  assert.equal(body.currency, "GBP");
  for (const dow of ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]) {
    assert.equal(body[dow], 95, `${dow} must carry the approved price`);
  }
  assert.equal(seenHeaders!.get("X-Integration-Api-Key"), FAKE_READ_KEY);
  assert.equal(seenHeaders!.get("X-User-Api-Key"), FAKE_WRITE_KEY);
});

test("409 on PUT retries (bounded) then succeeds", async () => {
  let puts = 0;
  const { adapter, calls } = adapterWith((rec) => {
    if (rec.method === "PUT") {
      puts += 1;
      if (puts < 3) return new Response("concurrent request", { status: 409 });
      return json({ ok: true });
    }
    return json([]);
  });
  const out = await adapter.execute(target());
  assert.equal(out.ok, true);
  assert.equal(calls.filter((c) => c.method === "PUT").length, 3);
});

test("409 exhausted after 3 attempts throws (orchestrator records it as failed)", async () => {
  const { adapter, calls } = adapterWith((rec) => {
    if (rec.method === "PUT") return new Response("concurrent request", { status: 409 });
    return json([]);
  });
  await assert.rejects(
    () => adapter.execute(target()),
    (err: unknown) => {
      assert.ok(err instanceof EngineHttpError);
      assert.equal((err as EngineHttpError).status, 409);
      return true;
    }
  );
  assert.equal(calls.filter((c) => c.method === "PUT").length, 3, "409 retry must be bounded at 3");
});

test("verify passes only on an exact single-day row carrying our price", async () => {
  const { adapter } = adapterWith((rec) => {
    if (rec.method === "GET") {
      return json({
        custom_rates: [
          { start_date: "2026-12-20", end_date: "2026-12-27", monday: 250 },
          {
            start_date: "2026-12-22",
            end_date: "2026-12-22",
            rate_type: "fixed",
            sunday: 95,
            monday: 95,
            tuesday: 95,
            wednesday: 95,
            thursday: 95,
            friday: 95,
            saturday: 95
          }
        ]
      });
    }
    return json({});
  });
  const verify = await adapter.verify(target({ price: 95 }));
  assert.equal(verify.verified, true);
  assert.equal(verify.observedPrice, 95);

  const mismatch = await adapter.verify(target({ price: 120 }));
  assert.equal(mismatch.verified, false);
  assert.equal(mismatch.observedPrice, 95);
});

test("revert DELETEs the single-day range, handles the 204 no-body reply, then verifyReverted passes", async () => {
  let deleted = false;
  const { adapter, calls } = adapterWith((rec) => {
    if (rec.method === "DELETE") {
      deleted = true;
      return new Response(null, { status: 204 });
    }
    if (rec.method === "GET") {
      return json(
        deleted ? [] : [{ start_date: "2026-12-22", end_date: "2026-12-22", monday: 95 }]
      );
    }
    return json({});
  });

  const out = await adapter.revert(target());
  assert.equal(out.ok, true);
  const del = calls.find((c) => c.method === "DELETE");
  assert.ok(del!.url.includes("channel=hostaway"));
  assert.ok(del!.url.includes("start_date=2026-12-22"));
  assert.ok(del!.url.includes("end_date=2026-12-22"));
  assert.equal(del!.body, undefined, "DELETE sends no body");

  const gone = await adapter.verifyReverted(target());
  assert.equal(gone.verified, true);
});

test("verifyReverted fails while our single-day row is still present", async () => {
  const { adapter } = adapterWith((rec) => {
    if (rec.method === "GET") {
      return json([{ start_date: "2026-12-22", end_date: "2026-12-22", tuesday: 95 }]);
    }
    return json({});
  });
  const still = await adapter.verifyReverted(target());
  assert.equal(still.verified, false);
  assert.equal(still.observedPrice, 95);
});

test("readCurrentPrice reads price_calendar for the single date", async () => {
  const { adapter, calls } = adapterWith((rec) => {
    if (rec.method === "GET" && rec.url.includes("price_calendar")) {
      return json([{ date: "2027-04-01", price: 101, min_stay: 2 }]);
    }
    return json([]);
  });
  const price = await adapter.readCurrentPrice("407381", "2027-04-01");
  assert.equal(price, 101);
  const call = calls.find((c) => c.url.includes("price_calendar"));
  assert.ok(call!.url.includes("channel=hostaway"));
  assert.ok(call!.url.includes("start_date=2027-04-01"));
  assert.ok(call!.url.includes("days=1"));
});
