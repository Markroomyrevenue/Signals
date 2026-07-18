import assert from "node:assert/strict";
import test from "node:test";

import {
  callOversightModel,
  computeCostUsd,
  DEFAULT_COST_IN_PER_MTOK,
  DEFAULT_COST_OUT_PER_MTOK,
  OversightError,
  stripMarkdownFences,
  validateOversightOutput
} from "./client";

const API_KEY = "sk-ant-test-key-do-not-log";
const KNOWN_IDS = ["sugg-1", "sugg-2"];

const GOOD_OUTPUT = {
  verdicts: [
    { suggestionId: "sugg-1", verdict: "endorse", reason: null, narrative: "The drop matches how this night has failed to fill before." },
    { suggestionId: "sugg-2", verdict: "flag", reason: "confidence exceeds the evidence", narrative: "Thin history behind this one." }
  ],
  clientRead: ["Bullet one.", "Bullet two.", "Bullet three."]
};

// ---------------------------------------------------------------------------
// stripMarkdownFences
// ---------------------------------------------------------------------------

test("stripMarkdownFences handles fenced, labelled-fenced, and plain text", () => {
  const json = `{"a":1}`;
  assert.equal(stripMarkdownFences(json), json);
  assert.equal(stripMarkdownFences("```json\n" + json + "\n```"), json);
  assert.equal(stripMarkdownFences("```\n" + json + "\n```"), json);
  assert.equal(stripMarkdownFences("  \n```json\n" + json + "\n```  \n"), json);
});

// ---------------------------------------------------------------------------
// validateOversightOutput
// ---------------------------------------------------------------------------

test("validator accepts good output", () => {
  const result = validateOversightOutput(GOOD_OUTPUT, KNOWN_IDS);
  assert.equal(result.verdicts.length, 2);
  assert.equal(result.verdicts[0].verdict, "endorse");
  assert.equal(result.verdicts[1].reason, "confidence exceeds the evidence");
  assert.deepEqual(result.clientRead, GOOD_OUTPUT.clientRead);
  assert.deepEqual(result.droppedSuggestionIds, []);
});

test("validator rejects a non-object payload", () => {
  assert.throws(() => validateOversightOutput([GOOD_OUTPUT], KNOWN_IDS), (err: unknown) => err instanceof OversightError && err.kind === "validation");
  assert.throws(() => validateOversightOutput("nope", KNOWN_IDS), OversightError);
});

test("validator rejects a wrong verdict enum", () => {
  const bad = {
    ...GOOD_OUTPUT,
    verdicts: [{ suggestionId: "sugg-1", verdict: "approve", reason: null, narrative: "x" }]
  };
  assert.throws(
    () => validateOversightOutput(bad, KNOWN_IDS),
    (err: unknown) => err instanceof OversightError && err.kind === "validation" && err.message.includes("verdict")
  );
});

test("validator rejects a missing narrative field", () => {
  const bad = { ...GOOD_OUTPUT, verdicts: [{ suggestionId: "sugg-1", verdict: "endorse", reason: null }] };
  assert.throws(
    () => validateOversightOutput(bad, KNOWN_IDS),
    (err: unknown) => err instanceof OversightError && err.message.includes("narrative")
  );
});

test("validator rejects empty suggestionId and bad clientRead shapes", () => {
  assert.throws(() =>
    validateOversightOutput({ ...GOOD_OUTPUT, verdicts: [{ suggestionId: "", verdict: "endorse", reason: null, narrative: "x" }] }, KNOWN_IDS)
  );
  assert.throws(() => validateOversightOutput({ ...GOOD_OUTPUT, clientRead: [] }, KNOWN_IDS));
  assert.throws(() => validateOversightOutput({ ...GOOD_OUTPUT, clientRead: new Array(9).fill("b") }, KNOWN_IDS));
  assert.throws(() => validateOversightOutput({ ...GOOD_OUTPUT, clientRead: ["ok", 42] }, KNOWN_IDS));
  assert.throws(() => validateOversightOutput({ verdicts: GOOD_OUTPUT.verdicts }, KNOWN_IDS));
});

test("validator drops unknown suggestionIds and reports them", () => {
  const withUnknown = {
    verdicts: [
      ...GOOD_OUTPUT.verdicts,
      { suggestionId: "sugg-hallucinated", verdict: "flag", reason: "??", narrative: "made up" }
    ],
    clientRead: GOOD_OUTPUT.clientRead
  };
  const result = validateOversightOutput(withUnknown, KNOWN_IDS);
  assert.equal(result.verdicts.length, 2);
  assert.deepEqual(result.droppedSuggestionIds, ["sugg-hallucinated"]);
});

test("validator keeps the first occurrence of a duplicated suggestionId and nulls empty reasons", () => {
  const dup = {
    verdicts: [
      { suggestionId: "sugg-1", verdict: "endorse", reason: "  ", narrative: "first" },
      { suggestionId: "sugg-1", verdict: "flag", reason: "later", narrative: "second" }
    ],
    clientRead: ["One bullet."]
  };
  const result = validateOversightOutput(dup, KNOWN_IDS);
  assert.equal(result.verdicts.length, 1);
  assert.equal(result.verdicts[0].narrative, "first");
  assert.equal(result.verdicts[0].reason, null);
});

// ---------------------------------------------------------------------------
// computeCostUsd
// ---------------------------------------------------------------------------

test("cost arithmetic uses claude-fable-5 default rates ($10 in / $50 out per MTok)", () => {
  assert.equal(DEFAULT_COST_IN_PER_MTOK, 10);
  assert.equal(DEFAULT_COST_OUT_PER_MTOK, 50);
  // 100k input + 2k output → 100000*10/1e6 + 2000*50/1e6 = 1.0 + 0.1
  assert.equal(computeCostUsd({ inputTokens: 100_000, outputTokens: 2_000 }), 1.1);
  assert.equal(computeCostUsd({ inputTokens: 0, outputTokens: 0 }), 0);
});

test("cost rates are env-overridable and explicit rates win over env", () => {
  const prevIn = process.env.RECS_OVERSIGHT_COST_IN_PER_MTOK;
  const prevOut = process.env.RECS_OVERSIGHT_COST_OUT_PER_MTOK;
  try {
    process.env.RECS_OVERSIGHT_COST_IN_PER_MTOK = "5";
    process.env.RECS_OVERSIGHT_COST_OUT_PER_MTOK = "25";
    assert.equal(computeCostUsd({ inputTokens: 100_000, outputTokens: 2_000 }), 0.55);
    // Explicit rates beat env.
    assert.equal(computeCostUsd({ inputTokens: 100_000, outputTokens: 2_000 }, { inPerMTok: 10, outPerMTok: 50 }), 1.1);
  } finally {
    if (prevIn === undefined) delete process.env.RECS_OVERSIGHT_COST_IN_PER_MTOK;
    else process.env.RECS_OVERSIGHT_COST_IN_PER_MTOK = prevIn;
    if (prevOut === undefined) delete process.env.RECS_OVERSIGHT_COST_OUT_PER_MTOK;
    else process.env.RECS_OVERSIGHT_COST_OUT_PER_MTOK = prevOut;
  }
});

// ---------------------------------------------------------------------------
// callOversightModel (mocked fetch — no live calls, ever)
// ---------------------------------------------------------------------------

type FetchCall = { url: string; init: RequestInit };

function okResponse(payload: unknown = GOOD_OUTPUT, extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(payload) }],
      stop_reason: "end_turn",
      usage: { input_tokens: 900, output_tokens: 150, cache_creation_input_tokens: 60, cache_read_input_tokens: 40 },
      ...extra
    }),
    { status: 200 }
  );
}

function makeFetchStub(responses: Array<Response | Error>): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: unknown, init?: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    const next = responses.shift();
    if (!next) throw new Error("fetch stub exhausted");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function makeSleepSpy(): { sleepImpl: (ms: number) => Promise<void>; slept: number[] } {
  const slept: number[] = [];
  return {
    sleepImpl: async (ms: number) => {
      slept.push(ms);
    },
    slept
  };
}

test("success path: parses, validates, sums usage (incl. cache tokens), computes cost", async () => {
  const { fetchImpl, calls } = makeFetchStub([okResponse()]);
  const { sleepImpl, slept } = makeSleepSpy();
  const result = await callOversightModel({
    system: "SYSTEM",
    user: "USER",
    model: "claude-fable-5",
    knownSuggestionIds: KNOWN_IDS,
    apiKey: API_KEY,
    fetchImpl,
    sleepImpl
  });
  assert.equal(result.verdicts.length, 2);
  assert.deepEqual(result.clientRead, GOOD_OUTPUT.clientRead);
  assert.deepEqual(result.usage, { inputTokens: 1000, outputTokens: 150 });
  // 1000*10/1e6 + 150*50/1e6 = 0.01 + 0.0075
  assert.equal(result.costUsd, 0.0175);
  assert.equal(calls.length, 1);
  assert.deepEqual(slept, []);

  // Request shape: cached system block, no sampling params, right headers.
  const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
  assert.equal(body.model, "claude-fable-5");
  assert.equal(body.max_tokens, 16000); // default cap: fable-5 thinking counts as output
  assert.deepEqual(body.system, [{ type: "text", text: "SYSTEM", cache_control: { type: "ephemeral" } }]);
  assert.deepEqual(body.messages, [{ role: "user", content: "USER" }]);
  assert.ok(!("temperature" in body), "temperature must not be sent (400 on claude-fable-5)");
  assert.ok(!("thinking" in body), "thinking config must be omitted on claude-fable-5");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], API_KEY);
  assert.equal(headers["anthropic-version"], "2023-06-01");
});

test("fenced JSON responses are stripped and parsed", async () => {
  const fenced = new Response(
    JSON.stringify({
      content: [{ type: "text", text: "```json\n" + JSON.stringify(GOOD_OUTPUT) + "\n```" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 }
    }),
    { status: 200 }
  );
  const { fetchImpl } = makeFetchStub([fenced]);
  const result = await callOversightModel({
    system: "s",
    user: "u",
    model: "claude-fable-5",
    knownSuggestionIds: KNOWN_IDS,
    apiKey: API_KEY,
    fetchImpl,
    sleepImpl: async () => {}
  });
  assert.equal(result.verdicts.length, 2);
});

test("retries on 429/529 with backoff, then succeeds", async () => {
  const { fetchImpl, calls } = makeFetchStub([
    new Response("rate limited", { status: 429 }),
    new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error" } }), { status: 529 }),
    okResponse()
  ]);
  const { sleepImpl, slept } = makeSleepSpy();
  const result = await callOversightModel({
    system: "s",
    user: "u",
    model: "claude-fable-5",
    knownSuggestionIds: KNOWN_IDS,
    apiKey: API_KEY,
    fetchImpl,
    sleepImpl
  });
  assert.equal(result.verdicts.length, 2);
  assert.equal(calls.length, 3);
  assert.deepEqual(slept, [2000, 4000]);
});

test("gives up after 2 retries on persistent 5xx", async () => {
  const { fetchImpl, calls } = makeFetchStub([
    new Response("boom", { status: 500 }),
    new Response("boom", { status: 502 }),
    new Response("boom", { status: 500 })
  ]);
  await assert.rejects(
    callOversightModel({
      system: "s",
      user: "u",
      model: "claude-fable-5",
      knownSuggestionIds: KNOWN_IDS,
      apiKey: API_KEY,
      fetchImpl,
      sleepImpl: async () => {}
    }),
    (err: unknown) => err instanceof OversightError && err.kind === "http"
  );
  assert.equal(calls.length, 3);
});

test("non-retryable 4xx fails immediately with the key redacted", async () => {
  // The error body echoes the key — the thrown message must not.
  const { fetchImpl, calls } = makeFetchStub([new Response(`invalid request for key ${API_KEY}`, { status: 400 })]);
  await assert.rejects(
    callOversightModel({
      system: "s",
      user: "u",
      model: "claude-fable-5",
      knownSuggestionIds: KNOWN_IDS,
      apiKey: API_KEY,
      fetchImpl,
      sleepImpl: async () => {}
    }),
    (err: unknown) =>
      err instanceof OversightError &&
      err.kind === "http" &&
      err.message.includes("400") &&
      !err.message.includes(API_KEY) &&
      err.message.includes("[redacted]")
  );
  assert.equal(calls.length, 1);
});

test("network errors are retried, then surfaced as a typed error", async () => {
  const { fetchImpl, calls } = makeFetchStub([
    new Error("socket hang up"),
    new Error("socket hang up"),
    new Error("socket hang up")
  ]);
  await assert.rejects(
    callOversightModel({
      system: "s",
      user: "u",
      model: "claude-fable-5",
      knownSuggestionIds: KNOWN_IDS,
      apiKey: API_KEY,
      fetchImpl,
      sleepImpl: async () => {}
    }),
    (err: unknown) => err instanceof OversightError && err.kind === "network"
  );
  assert.equal(calls.length, 3);
});

test("a refusal stop_reason is a typed, non-retried error", async () => {
  const refusal = new Response(JSON.stringify({ content: [], stop_reason: "refusal", usage: { input_tokens: 5, output_tokens: 0 } }), {
    status: 200
  });
  const { fetchImpl, calls } = makeFetchStub([refusal]);
  await assert.rejects(
    callOversightModel({
      system: "s",
      user: "u",
      model: "claude-fable-5",
      knownSuggestionIds: KNOWN_IDS,
      apiKey: API_KEY,
      fetchImpl,
      sleepImpl: async () => {}
    }),
    (err: unknown) => err instanceof OversightError && err.kind === "refusal"
  );
  assert.equal(calls.length, 1);
});

test("invalid JSON in the response is a parse error, not a crash", async () => {
  const garbage = new Response(
    JSON.stringify({ content: [{ type: "text", text: "I think these prices look reasonable overall." }], stop_reason: "end_turn" }),
    { status: 200 }
  );
  const { fetchImpl } = makeFetchStub([garbage]);
  await assert.rejects(
    callOversightModel({
      system: "s",
      user: "u",
      model: "claude-fable-5",
      knownSuggestionIds: KNOWN_IDS,
      apiKey: API_KEY,
      fetchImpl,
      sleepImpl: async () => {}
    }),
    (err: unknown) => err instanceof OversightError && err.kind === "parse"
  );
});

test("a null apiKey throws no_api_key without touching the network", async () => {
  const { fetchImpl, calls } = makeFetchStub([]);
  await assert.rejects(
    callOversightModel({
      system: "s",
      user: "u",
      model: "claude-fable-5",
      knownSuggestionIds: KNOWN_IDS,
      apiKey: null,
      fetchImpl,
      sleepImpl: async () => {}
    }),
    (err: unknown) => err instanceof OversightError && err.kind === "no_api_key"
  );
  assert.equal(calls.length, 0);
});
