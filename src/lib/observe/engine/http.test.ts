import assert from "node:assert/strict";
import test from "node:test";

import { engineFetchJson, EngineHttpError } from "./http";

const FAKE_KEY = "pl_live_secret_value_1234567890"; // not real
const noSleep = async (): Promise<void> => undefined;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

test("engineFetchJson returns parsed JSON on 200 and sends the auth header", async () => {
  let seenHeader: string | null = null;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seenHeader = headers.get("X-API-Key");
    return jsonResponse({ listings: [{ id: "1" }] });
  }) as unknown as typeof fetch;

  const out = await engineFetchJson<{ listings: unknown[] }>({
    url: "https://example.test/listings",
    headerName: "X-API-Key",
    apiKey: FAKE_KEY,
    fetchImpl,
    sleepImpl: noSleep
  });
  assert.equal(seenHeader, FAKE_KEY);
  assert.equal(out.listings.length, 1);
});

test("a non-retryable 401 throws EngineHttpError WITHOUT leaking the key", async () => {
  // Simulate an upstream body that echoes the key back — it must be redacted.
  const fetchImpl = (async () =>
    new Response(`Unauthorized: key ${FAKE_KEY} rejected`, { status: 401 })) as unknown as typeof fetch;

  let calls = 0;
  const counting = (async (...args: Parameters<typeof fetch>) => {
    calls += 1;
    return (fetchImpl as unknown as typeof fetch)(...args);
  }) as unknown as typeof fetch;

  await assert.rejects(
    () =>
      engineFetchJson({
        url: "https://example.test/listings",
        headerName: "X-API-Key",
        apiKey: FAKE_KEY,
        fetchImpl: counting,
        sleepImpl: noSleep
      }),
    (err: unknown) => {
      assert.ok(err instanceof EngineHttpError);
      assert.equal((err as EngineHttpError).status, 401);
      assert.ok(!(err as Error).message.includes(FAKE_KEY), "401 error leaked the key");
      return true;
    }
  );
  assert.equal(calls, 1, "401 must fail fast — no retries");
});

test("retries on 429 then succeeds", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls < 3) return new Response("rate limited", { status: 429 });
    return jsonResponse({ ok: true });
  }) as unknown as typeof fetch;

  const out = await engineFetchJson<{ ok: boolean }>({
    url: "https://example.test/listings",
    headerName: "X-Integration-Api-Key",
    apiKey: FAKE_KEY,
    fetchImpl,
    sleepImpl: noSleep,
    maxAttempts: 4
  });
  assert.equal(out.ok, true);
  assert.equal(calls, 3);
});

test("gives up after maxAttempts on persistent 500, key still redacted", async () => {
  const fetchImpl = (async () =>
    new Response(`server error referencing ${FAKE_KEY}`, { status: 500 })) as unknown as typeof fetch;

  await assert.rejects(
    () =>
      engineFetchJson({
        url: "https://example.test/listings",
        headerName: "X-API-Key",
        apiKey: FAKE_KEY,
        fetchImpl,
        sleepImpl: noSleep,
        maxAttempts: 2
      }),
    (err: unknown) => {
      assert.ok(!(err as Error).message.includes(FAKE_KEY));
      return true;
    }
  );
});
