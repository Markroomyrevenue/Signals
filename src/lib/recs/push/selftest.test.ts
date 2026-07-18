import assert from "node:assert/strict";
import test from "node:test";

import { runRecsPushSelfTest } from "./selftest";
import type { RecsPushLogRecord, RecsPushLogStore } from "./push-service";

const FAKE_KEY = "pl_live_secret_value_1234567890"; // not real
const noSleep = async (): Promise<void> => undefined;

function makePushLogStore(): { store: RecsPushLogStore; rows: RecsPushLogRecord[] } {
  const rows: RecsPushLogRecord[] = [];
  let nextId = 1;
  return {
    rows,
    store: {
      async record(row) {
        rows.push(row);
        return { id: `log-${nextId++}` };
      }
    }
  };
}

const BASE_ARGS = {
  engine: "pricelabs" as const,
  tenantId: "t1",
  tenantName: "Little Feather",
  engineListingId: "12345",
  confirmLive: true
};

test("refuses to run without confirm-live BEFORE touching keys or network", async () => {
  await assert.rejects(
    () => runRecsPushSelfTest({ ...BASE_ARGS, confirmLive: false }, { env: {} }),
    (err: unknown) => {
      assert.ok((err as Error).message.includes("--confirm-live"));
      return true;
    }
  );
});

test("refuses any test date under 180 days out", async () => {
  for (const daysOut of [0, 30, 179]) {
    await assert.rejects(
      () => runRecsPushSelfTest({ ...BASE_ARGS, daysOut }, { env: {} }),
      (err: unknown) => {
        assert.ok((err as Error).message.includes("180"));
        return true;
      }
    );
  }
});

test("refuses with a masked message when the key is missing — key value never involved", async () => {
  await assert.rejects(
    () => runRecsPushSelfTest(BASE_ARGS, { env: {}, log: () => undefined }),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.ok(message.includes("PRICELABS_KEY_LITTLE_FEATHER"));
      assert.ok(message.includes("(unset)"));
      return true;
    }
  );
});

test("happy path (mocked engine): push same value, verify, revert, verify-gone; PushLog rows are kind=selftest", async () => {
  // Stateful fake PriceLabs: overrides appear after POST, disappear after DELETE.
  let overrides: Array<{ date: string; price: string }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (method === "GET" && u.endsWith("/listings")) {
      return new Response(JSON.stringify({ listings: [{ id: 12345, pms: "hostaway" }] }), {
        status: 200
      });
    }
    if (method === "POST" && u.endsWith("/listing_prices")) {
      const body = JSON.parse(String(init?.body)) as Array<{ dateFrom: string }>;
      return new Response(
        JSON.stringify([{ id: "12345", data: [{ date: body[0].dateFrom, price: 150 }] }]),
        { status: 200 }
      );
    }
    if (method === "POST" && u.includes("/overrides")) {
      const body = JSON.parse(String(init?.body)) as {
        overrides: Array<{ date: string; price: number }>;
      };
      overrides = body.overrides.map((o) => ({ date: o.date, price: String(o.price) }));
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }
    if (method === "GET" && u.includes("/overrides?")) {
      return new Response(JSON.stringify({ overrides }), { status: 200 });
    }
    if (method === "DELETE" && u.includes("/overrides")) {
      overrides = [];
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected call ${method} ${u}`);
  }) as unknown as typeof fetch;

  const { store, rows } = makePushLogStore();
  const lines: string[] = [];
  const evidence = await runRecsPushSelfTest(BASE_ARGS, {
    env: { PRICELABS_KEY_LITTLE_FEATHER: FAKE_KEY },
    fetchImpl,
    sleepImpl: noSleep,
    pushLogStore: store,
    now: () => new Date("2026-07-18T08:00:00Z"),
    log: (line) => lines.push(line)
  });

  assert.equal(evidence.ok, true);
  assert.equal(evidence.currentPrice, 150);
  assert.equal(evidence.pushVerify.verified, true);
  assert.equal(evidence.pushVerify.observedPrice, 150);
  assert.equal(evidence.revertVerify.verified, true);
  assert.equal(evidence.date, "2027-04-04", "2026-07-18 + 260 days");

  assert.equal(rows.length, 2, "one push row + one revert row");
  for (const row of rows) {
    assert.equal(row.detail.kind, "selftest");
    assert.equal(row.result, "success");
  }
  assert.equal(rows[0].detail.phase, "push");
  assert.equal(rows[1].detail.phase, "revert");
  assert.equal(rows[0].newValue, 150);
  assert.equal(rows[1].newValue, null);

  const trail = lines.join("\n");
  assert.ok(!trail.includes(FAKE_KEY), "evidence trail leaked the key");
  assert.ok(trail.includes("PASS"));
});

test("revert still runs when verify fails, so the override is never left behind", async () => {
  // Engine accepts the POST but never shows the override (silent-accept style),
  // then the DELETE + verify-gone succeed.
  let deleteCalls = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (method === "GET" && u.endsWith("/listings")) {
      return new Response(JSON.stringify({ listings: [{ id: 12345, pms: "hostaway" }] }), {
        status: 200
      });
    }
    if (method === "POST" && u.endsWith("/listing_prices")) {
      const body = JSON.parse(String(init?.body)) as Array<{ dateFrom: string }>;
      return new Response(
        JSON.stringify([{ id: "12345", data: [{ date: body[0].dateFrom, price: 150 }] }]),
        { status: 200 }
      );
    }
    if (method === "POST" && u.includes("/overrides")) {
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }
    if (method === "GET" && u.includes("/overrides?")) {
      return new Response(JSON.stringify({ overrides: [] }), { status: 200 });
    }
    if (method === "DELETE" && u.includes("/overrides")) {
      deleteCalls += 1;
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected call ${method} ${u}`);
  }) as unknown as typeof fetch;

  const { store, rows } = makePushLogStore();
  const evidence = await runRecsPushSelfTest(BASE_ARGS, {
    env: { PRICELABS_KEY_LITTLE_FEATHER: FAKE_KEY },
    fetchImpl,
    sleepImpl: noSleep,
    pushLogStore: store,
    log: () => undefined
  });

  assert.equal(evidence.ok, false, "unverified push cannot be a PASS");
  assert.equal(evidence.pushVerify.verified, false);
  assert.equal(deleteCalls, 1, "cleanup DELETE must still run");
  assert.equal(evidence.revertVerify.verified, true);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].result, "failed");
  assert.equal(rows[1].result, "success");
});
