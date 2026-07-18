import assert from "node:assert/strict";
import test from "node:test";

import { buildExplainUserPrompt, buildSystemPrompt, buildUserPrompt, OVERSIGHT_OUTPUT_CONTRACT } from "./prompt";
import type { OversightInput } from "./types";

// A fake key is planted in the env BEFORE prompts are built: the isolation
// tests below assert prompt text can never carry key material even when the
// process holds a key. (node:test runs each file in its own process, so this
// does not leak into other test files.)
const FAKE_KEY = "sk-ant-test-oversight-fake-key-123";
process.env.ANTHROPIC_API_KEY = FAKE_KEY;

const TENANT_ID = "tenant-cuid-abc123";

function makeInput(overrides: Partial<OversightInput> = {}): OversightInput {
  return {
    tenantId: TENANT_ID,
    clientKey: "little-feather",
    clientName: "Little Feather Management",
    engine: "pricelabs",
    suggestions: [
      {
        id: "sugg-1",
        listingName: "Titanic View Apartment",
        date: "2026-08-07",
        dow: "Fri",
        currentPrice: 120,
        proposedPrice: 105,
        dropPct: -0.125,
        revenueAtRisk: 240,
        reason: "empty at 21 days out vs the expected curve",
        confidence: 0.7,
        provenance: "warm-start",
        provisional: true,
        floor: 84,
        suppressed: null,
        marketContribution: "market p50 for comparable 2-beds is 110"
      },
      {
        id: "sugg-2",
        listingName: "Cathedral Quarter Loft",
        date: "2026-08-08",
        dow: "Sat",
        currentPrice: 150,
        proposedPrice: 150,
        dropPct: 0,
        revenueAtRisk: null,
        reason: "hold — pacing ahead of curve",
        confidence: null,
        provenance: "live-observed",
        provisional: false,
        floor: null,
        suppressed: "cumulative drop cap reached in trailing 14d",
        marketContribution: null
      }
    ],
    profileSummary: { profile: { engine: "pricelabs", rules: [] }, evidence: { markPrior: null, dropOutcomes: null } },
    recentDecisions: [
      { date: "2026-07-16", listingName: "Titanic View Apartment", action: "approved", price: 99, outcomeSoFar: "booked within 2 days" }
    ],
    globalMethodology: { revision: 3, note: "weekend premium holds across markets" },
    ...overrides
  };
}

test("system prompt is stable, cacheable, and carries the contract", () => {
  const a = buildSystemPrompt();
  const b = buildSystemPrompt();
  // Byte-identical across calls — required for the cache_control prefix match.
  assert.equal(a, b);
  // No volatile content (dates, ids) may ever be interpolated in.
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(a), "system prompt must not contain dates");
  // Shape: role + philosophy + hard no-price rule + strict output contract.
  assert.ok(a.includes("revenue-management overseer"));
  assert.ok(a.includes("starting prior".toUpperCase()) || a.toLowerCase().includes("starting prior"));
  assert.ok(a.includes("NEVER propose changing a price"));
  assert.ok(a.includes("STRICT JSON"));
  assert.ok(a.includes(OVERSIGHT_OUTPUT_CONTRACT));
  assert.ok(a.includes('"endorse"|"flag"'));
  assert.ok(a.includes("clientRead"));
});

test("user prompt renders the client's data compactly", () => {
  const prompt = buildUserPrompt(makeInput());
  // Section shape, in order.
  const sections = ["Client:", "Client profile summary", "Human decisions", "Pending recommendations:", "Global methodology", "STRICT JSON"];
  let cursor = -1;
  for (const marker of sections) {
    const idx = prompt.indexOf(marker);
    assert.ok(idx > cursor, `expected "${marker}" after previous section (idx=${idx}, cursor=${cursor})`);
    cursor = idx;
  }
  // Per-suggestion facts, including provenance/provisional + market + suppressed.
  assert.ok(prompt.includes("id=sugg-1"));
  assert.ok(prompt.includes("Titanic View Apartment"));
  assert.ok(prompt.includes("2026-08-07 (Fri)"));
  assert.ok(prompt.includes("drop=-12.5%"));
  assert.ok(prompt.includes("floor=84"));
  assert.ok(prompt.includes("provenance=warm-start (provisional)"));
  assert.ok(prompt.includes("market: market p50 for comparable 2-beds is 110"));
  assert.ok(prompt.includes("suppressed: cumulative drop cap reached in trailing 14d"));
  // Client-level context.
  assert.ok(prompt.includes("Little Feather Management"));
  assert.ok(prompt.includes("Pricing engine: pricelabs"));
  assert.ok(prompt.includes("booked within 2 days"));
  assert.ok(prompt.includes("weekend premium holds across markets"));
});

test("user prompt contains only this client's data — no tenantId, no key material", () => {
  const prompt = buildUserPrompt(makeInput());
  assert.ok(!prompt.includes(TENANT_ID), "tenantId must never be rendered into a prompt");
  assert.ok(!prompt.includes(FAKE_KEY), "API key must never appear in a prompt");
  const system = buildSystemPrompt();
  assert.ok(!system.includes(FAKE_KEY));
  assert.ok(!system.includes(TENANT_ID));
});

test("user prompt omits the global methodology section when absent", () => {
  const input = makeInput();
  delete input.globalMethodology;
  const prompt = buildUserPrompt(input);
  assert.ok(!prompt.includes("Global methodology"));
});

test("user prompt notes when there are no recent human decisions", () => {
  const prompt = buildUserPrompt(makeInput({ recentDecisions: [] }));
  assert.ok(prompt.includes("last 7 days: none"));
});

test("explain prompt is the single-night variant with the fuller-narrative ask", () => {
  const input = makeInput();
  input.suggestions = [input.suggestions[0]];
  const prompt = buildExplainUserPrompt(input);
  assert.ok(prompt.includes("id=sugg-1"));
  assert.ok(prompt.includes("on-demand explain request"));
  assert.ok(prompt.includes("2-4 plain-English sentences"));
  // Still bound to the same strict contract.
  assert.ok(prompt.includes(OVERSIGHT_OUTPUT_CONTRACT));
});
