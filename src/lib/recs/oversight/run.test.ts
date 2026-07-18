import assert from "node:assert/strict";
import test from "node:test";

import type { CallOversightModelArgs, CallOversightModelResult } from "./client";
import { explainNight } from "./explain";
import {
  detailIsRecsPage,
  mapRowToSuggestionInput,
  mergeOversightIntoDetail,
  runOversightForClient,
  type OversightRunWrite,
  type OversightStores,
  type PendingSuggestionRow
} from "./run";
import type { OversightDetailAnnotation, OversightRecentDecision } from "./types";

const TENANT = "tenant-1";
const CLIENT = "client-a";
const API_KEY = "sk-ant-run-test-key";

const ENABLED_CONFIG = { enabled: true, model: "claude-fable-5", apiKey: API_KEY };

function pendingRow(overrides: Partial<PendingSuggestionRow> & { id: string }): PendingSuggestionRow {
  return {
    clientKey: CLIENT,
    listingId: "L1",
    dateFrom: new Date("2026-08-07T00:00:00Z"),
    oldValue: 120,
    proposedValue: 105,
    revenueAtRisk: 240,
    reason: "empty at 21 days out vs curve",
    confidence: 0.7,
    provenance: "warm-start",
    provisional: false,
    detail: { recsPage: true, floor: 84, score: 12, curveCohort: "tenant" },
    ...overrides
  };
}

type Fakes = {
  stores: OversightStores;
  runs: Array<OversightRunWrite & { id: string }>;
  suggestions: PendingSuggestionRow[];
};

function makeFakes(opts: {
  suggestions?: PendingSuggestionRow[];
  listingNames?: Record<string, string>;
  tenantName?: string;
  profile?: unknown;
  evidence?: Array<{ kind: string; provenance: string; payload: unknown }>;
  recentDecisions?: OversightRecentDecision[];
  globalMethodology?: unknown;
  failCreateRun?: boolean;
} = {}): Fakes {
  const suggestions = opts.suggestions ?? [];
  const runs: Array<OversightRunWrite & { id: string }> = [];
  const stores: OversightStores = {
    countPendingSuggestions: async (tenantId, clientKey) =>
      suggestions.filter((s) => s.clientKey === clientKey && tenantId === TENANT).length,
    loadPendingSuggestions: async (tenantId, clientKey) =>
      tenantId === TENANT ? suggestions.filter((s) => s.clientKey === clientKey) : [],
    loadSuggestionById: async (tenantId, id) => (tenantId === TENANT ? (suggestions.find((s) => s.id === id) ?? null) : null),
    loadListingNames: async () => opts.listingNames ?? { L1: "Titanic View Apartment" },
    loadTenantName: async () => opts.tenantName ?? "Little Feather Management",
    loadClientProfile: async () => opts.profile ?? { engine: "pricelabs" },
    loadEvidence: async () => opts.evidence ?? [],
    loadRecentDecisions: async () => opts.recentDecisions ?? [],
    loadGlobalMethodology: async () => opts.globalMethodology ?? null,
    createOversightRun: async (write) => {
      if (opts.failCreateRun) throw new Error("db down");
      const id = `run-${runs.length + 1}`;
      runs.push({ ...write, id });
      return { id };
    },
    mergeSuggestionOversight: async (tenantId, id, annotation) => {
      if (tenantId !== TENANT) throw new Error("wrong tenant");
      const row = suggestions.find((s) => s.id === id);
      if (!row) throw new Error(`suggestion ${id} not found`);
      row.detail = mergeOversightIntoDetail(row.detail, annotation);
    }
  };
  return { stores, runs, suggestions };
}

function makeCallModelSpy(result?: Partial<CallOversightModelResult>): {
  callModel: (args: CallOversightModelArgs) => Promise<CallOversightModelResult>;
  calls: CallOversightModelArgs[];
} {
  const calls: CallOversightModelArgs[] = [];
  const callModel = async (args: CallOversightModelArgs): Promise<CallOversightModelResult> => {
    calls.push(args);
    return {
      verdicts:
        result?.verdicts ??
        args.knownSuggestionIds.map((id, i) => ({
          suggestionId: id,
          verdict: i === 0 ? ("flag" as const) : ("endorse" as const),
          reason: i === 0 ? "confidence exceeds the evidence" : null,
          narrative: `Narrative for ${id}.`
        })),
      clientRead: result?.clientRead ?? ["Bullet one.", "Bullet two.", "Bullet three."],
      droppedSuggestionIds: result?.droppedSuggestionIds ?? [],
      usage: result?.usage ?? { inputTokens: 1000, outputTokens: 200 },
      costUsd: result?.costUsd ?? 0.02
    };
  };
  return { callModel, calls };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("mergeOversightIntoDetail preserves every existing detail key", () => {
  const annotation: OversightDetailAnnotation = {
    verdict: "endorse",
    reason: null,
    narrative: "n",
    model: "claude-fable-5",
    runId: "run-1",
    at: "2026-07-18T05:00:00.000Z"
  };
  const merged = mergeOversightIntoDetail({ recsPage: true, floor: 84, score: 12, curveCohort: "tenant" }, annotation);
  assert.deepEqual(merged, {
    recsPage: true,
    floor: 84,
    score: 12,
    curveCohort: "tenant",
    oversight: annotation
  });
  // Non-object / null detail becomes just the annotation.
  assert.deepEqual(mergeOversightIntoDetail(null, annotation), { oversight: annotation });
  assert.deepEqual(mergeOversightIntoDetail([1, 2], annotation), { oversight: annotation });
  // Re-running replaces the previous oversight block only.
  const rerun = mergeOversightIntoDetail(merged, { ...annotation, runId: "run-2" });
  assert.equal((rerun.oversight as OversightDetailAnnotation).runId, "run-2");
  assert.equal(rerun.floor, 84);
});

test("detailIsRecsPage requires a truthy detail.recsPage", () => {
  assert.equal(detailIsRecsPage({ recsPage: true }), true);
  assert.equal(detailIsRecsPage({ recsPage: false }), false);
  assert.equal(detailIsRecsPage({ floor: 84 }), false);
  assert.equal(detailIsRecsPage(null), false);
  assert.equal(detailIsRecsPage("recsPage"), false);
});

test("mapRowToSuggestionInput flattens the row (dow, dropPct, detail fields)", () => {
  const input = mapRowToSuggestionInput(
    pendingRow({ id: "s1", detail: { recsPage: true, floor: 84, suppressed: "cap reached", marketContribution: "p50 110" } }),
    { L1: "Titanic View Apartment" }
  );
  assert.equal(input.date, "2026-08-07");
  assert.equal(input.dow, "Fri");
  assert.equal(input.dropPct, -0.125);
  assert.equal(input.floor, 84);
  assert.equal(input.suppressed, "cap reached");
  assert.equal(input.marketContribution, "p50 110");
  assert.equal(input.listingName, "Titanic View Apartment");
  // Unknown listing / missing prices degrade gracefully.
  const sparse = mapRowToSuggestionInput(pendingRow({ id: "s2", listingId: null, oldValue: null, detail: null }), {});
  assert.equal(sparse.listingName, "unknown listing");
  assert.equal(sparse.dropPct, null);
  assert.equal(sparse.floor, null);
});

// ---------------------------------------------------------------------------
// runOversightForClient — disabled path
// ---------------------------------------------------------------------------

test("disabled: writes a disabled row, never calls the model, resolves", async () => {
  const fakes = makeFakes({ suggestions: [pendingRow({ id: "s1" })] });
  const { callModel, calls } = makeCallModelSpy();
  const result = await runOversightForClient({
    tenantId: TENANT,
    clientKey: CLIENT,
    deps: { config: { enabled: false, model: "claude-fable-5", apiKey: API_KEY }, stores: fakes.stores, callModel }
  });
  assert.deepEqual(result, { status: "disabled" });
  assert.equal(calls.length, 0);
  assert.equal(fakes.runs.length, 1);
  assert.equal(fakes.runs[0].status, "disabled");
  assert.equal(fakes.runs[0].suggestionCount, 1);
  // The suggestion ships unannotated.
  assert.equal(detailIsRecsPage(fakes.suggestions[0].detail), true);
  assert.ok(!(fakes.suggestions[0].detail as Record<string, unknown>).oversight);
});

test("missing API key behaves as disabled, even when enabled", async () => {
  const fakes = makeFakes();
  const { callModel, calls } = makeCallModelSpy();
  const result = await runOversightForClient({
    tenantId: TENANT,
    clientKey: CLIENT,
    deps: { config: { enabled: true, model: "claude-fable-5", apiKey: null }, stores: fakes.stores, callModel }
  });
  assert.deepEqual(result, { status: "disabled" });
  assert.equal(calls.length, 0);
  assert.equal(fakes.runs[0].status, "disabled");
});

test("disabled path never throws even when the audit write fails", async () => {
  const fakes = makeFakes({ failCreateRun: true });
  const { callModel } = makeCallModelSpy();
  const result = await runOversightForClient({
    tenantId: TENANT,
    clientKey: CLIENT,
    deps: { config: { enabled: false, model: "claude-fable-5", apiKey: null }, stores: fakes.stores, callModel }
  });
  assert.deepEqual(result, { status: "disabled" });
});

// ---------------------------------------------------------------------------
// runOversightForClient — nothing pending
// ---------------------------------------------------------------------------

test("nothing pending: ok row with suggestionCount 0, no model call", async () => {
  const fakes = makeFakes({
    // A pending row WITHOUT detail.recsPage must not count as a page rec.
    suggestions: [pendingRow({ id: "s-legacy", detail: { floor: 90 } })]
  });
  const { callModel, calls } = makeCallModelSpy();
  const result = await runOversightForClient({
    tenantId: TENANT,
    clientKey: CLIENT,
    deps: { config: ENABLED_CONFIG, stores: fakes.stores, callModel }
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.verdicts, []);
  assert.equal(calls.length, 0);
  assert.equal(fakes.runs.length, 1);
  assert.equal(fakes.runs[0].status, "ok");
  assert.equal(fakes.runs[0].suggestionCount, 0);
});

// ---------------------------------------------------------------------------
// runOversightForClient — error path
// ---------------------------------------------------------------------------

test("model failure: writes an error row with a redacted message and resolves", async () => {
  const fakes = makeFakes({ suggestions: [pendingRow({ id: "s1" })] });
  const callModel = async (): Promise<CallOversightModelResult> => {
    throw new Error(`anthropic exploded for ${API_KEY}`);
  };
  const result = await runOversightForClient({
    tenantId: TENANT,
    clientKey: CLIENT,
    deps: { config: ENABLED_CONFIG, stores: fakes.stores, callModel }
  });
  assert.equal(result.status, "error");
  assert.ok(result.error && !result.error.includes(API_KEY));
  assert.ok(result.error.includes("[redacted]"));
  assert.equal(fakes.runs.length, 1);
  assert.equal(fakes.runs[0].status, "error");
  assert.ok(fakes.runs[0].error && !fakes.runs[0].error.includes(API_KEY));
  // The suggestion is untouched — recs ship unannotated on failure.
  assert.ok(!(fakes.suggestions[0].detail as Record<string, unknown>).oversight);
});

test("store failure mid-run resolves as an error result, never throws", async () => {
  const fakes = makeFakes({ suggestions: [pendingRow({ id: "s1" })] });
  fakes.stores.loadClientProfile = async () => {
    throw new Error("profile query failed");
  };
  const { callModel } = makeCallModelSpy();
  const result = await runOversightForClient({
    tenantId: TENANT,
    clientKey: CLIENT,
    deps: { config: ENABLED_CONFIG, stores: fakes.stores, callModel }
  });
  assert.equal(result.status, "error");
  assert.equal(fakes.runs[0].status, "error");
});

// ---------------------------------------------------------------------------
// runOversightForClient — success path
// ---------------------------------------------------------------------------

test("success: verdict overlay merged into detail, run row persisted with tokens/cost/flags", async () => {
  const fakes = makeFakes({
    suggestions: [
      pendingRow({ id: "s1" }),
      pendingRow({ id: "s2", dateFrom: new Date("2026-08-08T00:00:00Z"), detail: { recsPage: true, floor: 95 } }),
      pendingRow({ id: "s-legacy", detail: { floor: 90 } }) // not a page rec — excluded
    ],
    globalMethodology: { revision: 2 }
  });
  const { callModel, calls } = makeCallModelSpy();
  const now = () => new Date("2026-07-18T05:30:00.000Z");
  const result = await runOversightForClient({
    tenantId: TENANT,
    clientKey: CLIENT,
    now,
    deps: { config: ENABLED_CONFIG, stores: fakes.stores, callModel }
  });

  // The model saw exactly the two page recs, and only this client's data.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].knownSuggestionIds, ["s1", "s2"]);
  assert.equal(calls[0].model, "claude-fable-5");
  assert.equal(calls[0].apiKey, API_KEY);
  assert.ok(calls[0].user.includes("id=s1"));
  assert.ok(!calls[0].user.includes("s-legacy"));
  assert.ok(!calls[0].user.includes(TENANT), "tenantId must not reach the prompt");
  assert.ok(!calls[0].user.includes(API_KEY), "key must not reach the prompt");

  // Result + audit row.
  assert.equal(result.status, "ok");
  assert.equal(result.verdicts?.length, 2);
  assert.equal(result.costUsd, 0.02);
  assert.equal(fakes.runs.length, 1);
  const run = fakes.runs[0];
  assert.equal(run.status, "ok");
  assert.equal(run.suggestionCount, 2);
  assert.equal(run.flagCount, 1);
  assert.equal(run.inputTokens, 1000);
  assert.equal(run.outputTokens, 200);
  assert.equal(run.costUsd, 0.02);
  assert.deepEqual(run.clientRead, ["Bullet one.", "Bullet two.", "Bullet three."]);
  assert.equal(run.runAt.toISOString(), "2026-07-18T05:30:00.000Z");

  // detail.oversight merged WITHOUT dropping existing keys.
  const s1 = fakes.suggestions.find((s) => s.id === "s1")?.detail as Record<string, unknown>;
  assert.equal(s1.floor, 84);
  assert.equal(s1.score, 12);
  assert.equal(s1.curveCohort, "tenant");
  const oversight = s1.oversight as OversightDetailAnnotation;
  assert.equal(oversight.verdict, "flag");
  assert.equal(oversight.reason, "confidence exceeds the evidence");
  assert.equal(oversight.narrative, "Narrative for s1.");
  assert.equal(oversight.model, "claude-fable-5");
  assert.equal(oversight.runId, run.id);
  assert.equal(oversight.at, "2026-07-18T05:30:00.000Z");
  // The excluded legacy row stays untouched.
  const legacy = fakes.suggestions.find((s) => s.id === "s-legacy")?.detail as Record<string, unknown>;
  assert.ok(!legacy.oversight);
});

test("a merge failure on one row does not fail the run", async () => {
  const fakes = makeFakes({ suggestions: [pendingRow({ id: "s1" }), pendingRow({ id: "s2" })] });
  const original = fakes.stores.mergeSuggestionOversight;
  fakes.stores.mergeSuggestionOversight = async (tenantId, id, annotation) => {
    if (id === "s1") throw new Error("row locked");
    return original(tenantId, id, annotation);
  };
  const { callModel } = makeCallModelSpy();
  const result = await runOversightForClient({
    tenantId: TENANT,
    clientKey: CLIENT,
    deps: { config: ENABLED_CONFIG, stores: fakes.stores, callModel }
  });
  assert.equal(result.status, "ok");
  const s2 = fakes.suggestions.find((s) => s.id === "s2")?.detail as Record<string, unknown>;
  assert.ok(s2.oversight);
});

// ---------------------------------------------------------------------------
// explainNight
// ---------------------------------------------------------------------------

test("explainNight: returns the narrative and refreshes detail.oversight with runId null", async () => {
  const fakes = makeFakes({ suggestions: [pendingRow({ id: "s1" })] });
  const { callModel, calls } = makeCallModelSpy({
    verdicts: [{ suggestionId: "s1", verdict: "endorse", reason: null, narrative: "This night has gone empty at this price twice before." }]
  });
  const result = await explainNight({
    tenantId: TENANT,
    suggestionId: "s1",
    now: () => new Date("2026-07-18T09:00:00.000Z"),
    deps: { config: ENABLED_CONFIG, stores: fakes.stores, callModel }
  });
  assert.equal(result.status, "ok");
  assert.equal(result.status === "ok" && result.narrative, "This night has gone empty at this price twice before.");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].knownSuggestionIds, ["s1"]);
  assert.ok(calls[0].user.includes("on-demand explain request"));
  // No OversightRun row for explains; the detail refresh has runId null.
  assert.equal(fakes.runs.length, 0);
  const detail = fakes.suggestions[0].detail as Record<string, unknown>;
  const oversight = detail.oversight as OversightDetailAnnotation;
  assert.equal(oversight.runId, null);
  assert.equal(oversight.at, "2026-07-18T09:00:00.000Z");
  assert.equal(detail.floor, 84);
});

test("explainNight: disabled config short-circuits; unknown suggestion is an error result", async () => {
  const fakes = makeFakes({ suggestions: [pendingRow({ id: "s1" })] });
  const { callModel, calls } = makeCallModelSpy();
  const disabled = await explainNight({
    tenantId: TENANT,
    suggestionId: "s1",
    deps: { config: { enabled: false, model: "claude-fable-5", apiKey: API_KEY }, stores: fakes.stores, callModel }
  });
  assert.deepEqual(disabled, { status: "disabled" });
  assert.equal(calls.length, 0);

  const missing = await explainNight({
    tenantId: TENANT,
    suggestionId: "nope",
    deps: { config: ENABLED_CONFIG, stores: fakes.stores, callModel }
  });
  assert.equal(missing.status, "error");
});

test("explainNight: model failure resolves as an error result with the key redacted", async () => {
  const fakes = makeFakes({ suggestions: [pendingRow({ id: "s1" })] });
  const callModel = async (): Promise<CallOversightModelResult> => {
    throw new Error(`boom ${API_KEY}`);
  };
  const result = await explainNight({
    tenantId: TENANT,
    suggestionId: "s1",
    deps: { config: ENABLED_CONFIG, stores: fakes.stores, callModel }
  });
  assert.equal(result.status, "error");
  assert.ok(result.status === "error" && !result.error.includes(API_KEY));
});
