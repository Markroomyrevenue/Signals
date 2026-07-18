import assert from "node:assert/strict";
import test from "node:test";

import { EngineHttpError } from "@/lib/observe/engine/http";

import { recsEngineFetch } from "./http";

const FAKE_READ_KEY = "wh_read_secret_value_1234567890"; // not real
const FAKE_WRITE_KEY = "wh_write_secret_value_0987654321"; // not real
const noSleep = async (): Promise<void> => undefined;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

test("sends every auth header + browser UA + JSON content type, returns parsed JSON", async () => {
  let seen: { read: string | null; write: string | null; ua: string | null; method?: string } = {
    read: null,
    write: null,
    ua: null
  };
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen = {
      read: headers.get("X-Integration-Api-Key"),
      write: headers.get("X-User-Api-Key"),
      ua: headers.get("User-Agent"),
      method: init?.method
    };
    return jsonResponse({ ok: true });
  }) as unknown as typeof fetch;

  const out = await recsEngineFetch<{ ok: boolean }>({
    url: "https://example.test/custom_rates",
    method: "PUT",
    authHeaders: { "X-Integration-Api-Key": FAKE_READ_KEY, "X-User-Api-Key": FAKE_WRITE_KEY },
    body: { start_date: "2027-04-01" },
    fetchImpl,
    sleepImpl: noSleep
  });
  assert.equal(out?.ok, true);
  assert.equal(seen.read, FAKE_READ_KEY);
  assert.equal(seen.write, FAKE_WRITE_KEY);
  assert.equal(seen.method, "PUT");
  assert.ok(seen.ua && seen.ua.includes("Mozilla/5.0"), "browser UA must be on every call");
});

test("DELETE returning 204 no-body resolves to null", async () => {
  const fetchImpl = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
  const out = await recsEngineFetch({
    url: "https://example.test/custom_rates",
    method: "DELETE",
    authHeaders: { "X-API-Key": FAKE_READ_KEY },
    fetchImpl,
    sleepImpl: noSleep
  });
  assert.equal(out, null);
});

test("2xx with an empty body resolves to null instead of a JSON parse crash", async () => {
  const fetchImpl = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;
  const out = await recsEngineFetch({
    url: "https://example.test/overrides",
    method: "POST",
    authHeaders: { "X-API-Key": FAKE_READ_KEY },
    body: {},
    fetchImpl,
    sleepImpl: noSleep
  });
  assert.equal(out, null);
});

test("409 WITHOUT retryOn409 fails fast — exactly one call", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response("conflict", { status: 409 });
  }) as unknown as typeof fetch;

  await assert.rejects(
    () =>
      recsEngineFetch({
        url: "https://example.test/custom_rates",
        method: "PUT",
        authHeaders: { "X-API-Key": FAKE_READ_KEY },
        body: {},
        fetchImpl,
        sleepImpl: noSleep
      }),
    (err: unknown) => {
      assert.ok(err instanceof EngineHttpError);
      assert.equal((err as EngineHttpError).status, 409);
      return true;
    }
  );
  assert.equal(calls, 1);
});

test("409 WITH retryOn409 retries with backoff then succeeds", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls < 3) return new Response("conflict", { status: 409 });
    return jsonResponse({ ok: true });
  }) as unknown as typeof fetch;

  const out = await recsEngineFetch<{ ok: boolean }>({
    url: "https://example.test/custom_rates",
    method: "PUT",
    authHeaders: { "X-API-Key": FAKE_READ_KEY },
    body: {},
    retryOn409: true,
    maxAttempts: 3,
    fetchImpl,
    sleepImpl: noSleep
  });
  assert.equal(out?.ok, true);
  assert.equal(calls, 3);
});

test("409 WITH retryOn409 is bounded — throws after maxAttempts", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response("still conflicted", { status: 409 });
  }) as unknown as typeof fetch;

  await assert.rejects(
    () =>
      recsEngineFetch({
        url: "https://example.test/custom_rates",
        method: "PUT",
        authHeaders: { "X-API-Key": FAKE_READ_KEY },
        body: {},
        retryOn409: true,
        maxAttempts: 3,
        fetchImpl,
        sleepImpl: noSleep
      }),
    (err: unknown) => {
      assert.ok(err instanceof EngineHttpError);
      assert.equal((err as EngineHttpError).status, 409);
      return true;
    }
  );
  assert.equal(calls, 3);
});

test("error bodies echoing ANY auth-header value are redacted", async () => {
  const fetchImpl = (async () =>
    new Response(`boom: ${FAKE_READ_KEY} and also ${FAKE_WRITE_KEY}`, {
      status: 500
    })) as unknown as typeof fetch;

  await assert.rejects(
    () =>
      recsEngineFetch({
        url: "https://example.test/custom_rates",
        method: "PUT",
        authHeaders: { "X-Integration-Api-Key": FAKE_READ_KEY, "X-User-Api-Key": FAKE_WRITE_KEY },
        body: {},
        maxAttempts: 2,
        fetchImpl,
        sleepImpl: noSleep
      }),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.ok(!message.includes(FAKE_READ_KEY), "read key leaked");
      assert.ok(!message.includes(FAKE_WRITE_KEY), "write key leaked");
      assert.ok(message.includes("***REDACTED***"));
      return true;
    }
  );
});

test("still retries 429 and 5xx like the read-only helper", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls === 1) return new Response("rate limited", { status: 429 });
    if (calls === 2) return new Response("bad gateway", { status: 502 });
    return jsonResponse({ ok: true });
  }) as unknown as typeof fetch;

  const out = await recsEngineFetch<{ ok: boolean }>({
    url: "https://example.test/overrides",
    method: "POST",
    authHeaders: { "X-API-Key": FAKE_READ_KEY },
    body: {},
    fetchImpl,
    sleepImpl: noSleep
  });
  assert.equal(out?.ok, true);
  assert.equal(calls, 3);
});
