/**
 * Per-client oversight runner.
 *
 * Called after every suggestion generation: reviews ONE client's pending
 * recs-page suggestions with a single Anthropic call and overlays
 * endorse/flag verdicts + narratives onto `Suggestion.detail.oversight`.
 *
 * Guarantees:
 *   - NEVER throws and NEVER blocks recs. Disabled / missing key / any error
 *     → an OversightRun audit row is written and the function resolves; the
 *     recommendations simply ship unannotated.
 *   - NEVER changes a price — the only Suggestion write is the detail merge,
 *     and the merge preserves every existing detail key.
 *   - Every store call is tenant-scoped (tenantId filter on every query and
 *     every update — see `store.ts`).
 *   - Bounded runtime: the model call is capped at 3 attempts × 60s + ~6s of
 *     backoff (see client.ts); all DB work is a handful of small queries.
 */

import { env } from "@/lib/env";

import {
  callOversightModel,
  readAnthropicKey,
  redactKey,
  type CallOversightModelArgs,
  type CallOversightModelResult
} from "./client";
import { buildSystemPrompt, buildUserPrompt } from "./prompt";
import type {
  OversightDetailAnnotation,
  OversightInput,
  OversightRecentDecision,
  OversightResult,
  OversightStatus,
  OversightSuggestionInput
} from "./types";

const LOG_PREFIX = "[recs-oversight]";
const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const RECENT_DECISION_WINDOW_DAYS = 7;

// ---------------------------------------------------------------------------
// Store contract (prisma-backed defaults live in ./store; tests inject fakes)
// ---------------------------------------------------------------------------

/** A pending Suggestion row, already flattened out of Prisma Decimal types. */
export type PendingSuggestionRow = {
  id: string;
  clientKey: string | null;
  listingId: string | null;
  /** dateFrom (the night). */
  dateFrom: Date;
  oldValue: number | null;
  proposedValue: number | null;
  revenueAtRisk: number | null;
  reason: string;
  confidence: number | null;
  provenance: string | null;
  provisional: boolean;
  detail: unknown;
};

export type OversightRunWrite = {
  tenantId: string;
  clientKey: string;
  runAt: Date;
  model: string;
  status: OversightStatus;
  suggestionCount: number | null;
  flagCount?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  clientRead?: string[] | null;
  error?: string | null;
};

export type OversightStores = {
  /** Cheap count for the disabled-path audit row (status filter only). */
  countPendingSuggestions(tenantId: string, clientKey: string): Promise<number>;
  loadPendingSuggestions(tenantId: string, clientKey: string): Promise<PendingSuggestionRow[]>;
  loadSuggestionById(tenantId: string, suggestionId: string): Promise<PendingSuggestionRow | null>;
  loadListingNames(tenantId: string, listingIds: string[]): Promise<Record<string, string>>;
  loadTenantName(tenantId: string): Promise<string | null>;
  /** ClientProfile.profile JSON, or null when the client has none yet. */
  loadClientProfile(tenantId: string, clientKey: string): Promise<unknown | null>;
  /** RecsEvidence rows of kind mark-prior / drop-outcomes. */
  loadEvidence(
    tenantId: string,
    clientKey: string
  ): Promise<Array<{ kind: string; provenance: string; payload: unknown }>>;
  loadRecentDecisions(tenantId: string, clientKey: string, since: Date): Promise<OversightRecentDecision[]>;
  loadGlobalMethodology(): Promise<unknown | null>;
  createOversightRun(write: OversightRunWrite): Promise<{ id: string }>;
  /** MUST filter by tenantId and MUST merge (never replace) detail. */
  mergeSuggestionOversight(tenantId: string, suggestionId: string, annotation: OversightDetailAnnotation): Promise<void>;
};

export type OversightConfig = {
  enabled: boolean;
  model: string;
  apiKey: string | null;
};

export type OversightDeps = {
  /** Override enabled/model/apiKey resolution (tests; ad-hoc scripts). */
  config?: Partial<OversightConfig>;
  stores?: OversightStores;
  callModel?: (args: CallOversightModelArgs) => Promise<CallOversightModelResult>;
};

export function resolveOversightConfig(overrides?: Partial<OversightConfig>): OversightConfig {
  return {
    enabled: overrides?.enabled ?? env.recsOversightEnabled,
    model: overrides?.model ?? env.recsOversightModel,
    apiKey: overrides?.apiKey !== undefined ? overrides.apiKey : readAnthropicKey()
  };
}

async function resolveStores(deps?: OversightDeps): Promise<OversightStores> {
  if (deps?.stores) return deps.stores;
  // Dynamic import keeps prisma out of the unit-test module graph.
  const mod = await import("./store");
  return mod.prismaOversightStores;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests and reused by store.ts / explain.ts)
// ---------------------------------------------------------------------------

function asPlainObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Is this suggestion a recs-page row? (`detail.recsPage` truthy.) */
export function detailIsRecsPage(detail: unknown): boolean {
  const obj = asPlainObject(detail);
  return Boolean(obj && obj.recsPage);
}

/**
 * Merge the oversight annotation into an existing detail JSON without
 * dropping any existing key (detail carries floor/score/curveCohort etc.).
 * Non-object detail (null / array / scalar) is treated as empty.
 */
export function mergeOversightIntoDetail(detail: unknown, annotation: OversightDetailAnnotation): Record<string, unknown> {
  const existing = asPlainObject(detail) ?? {};
  return { ...existing, oversight: { ...annotation } };
}

function readDetailNumber(detail: Record<string, unknown> | null, key: string): number | null {
  const value = detail?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readDetailString(detail: Record<string, unknown> | null, key: string): string | null {
  const value = detail?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Flatten a DB row into the prompt input shape. */
export function mapRowToSuggestionInput(row: PendingSuggestionRow, listingNames: Record<string, string>): OversightSuggestionInput {
  const detail = asPlainObject(row.detail);
  const date = row.dateFrom.toISOString().slice(0, 10);
  const dow = DOW_NAMES[row.dateFrom.getUTCDay()];
  const dropPct =
    row.oldValue !== null && row.proposedValue !== null && row.oldValue > 0
      ? Math.round(((row.proposedValue - row.oldValue) / row.oldValue) * 10_000) / 10_000
      : null;
  return {
    id: row.id,
    listingName: (row.listingId && listingNames[row.listingId]) || "unknown listing",
    date,
    dow,
    currentPrice: row.oldValue,
    proposedPrice: row.proposedValue,
    dropPct,
    revenueAtRisk: row.revenueAtRisk,
    reason: row.reason,
    confidence: row.confidence,
    provenance: row.provenance,
    provisional: row.provisional,
    floor: readDetailNumber(detail, "floor"),
    suppressed: readDetailString(detail, "suppressed"),
    marketContribution: readDetailString(detail, "marketContribution")
  };
}

/** Assemble profile + evidence into the single profileSummary blob. */
export function buildProfileSummary(
  profile: unknown | null,
  evidence: Array<{ kind: string; provenance: string; payload: unknown }>
): unknown {
  const markPrior = evidence.find((e) => e.kind === "mark-prior") ?? null;
  const dropOutcomes = evidence.find((e) => e.kind === "drop-outcomes") ?? null;
  return {
    profile: profile ?? null,
    evidence: {
      markPrior: markPrior ? { provenance: markPrior.provenance, payload: markPrior.payload } : null,
      dropOutcomes: dropOutcomes ? { provenance: dropOutcomes.provenance, payload: dropOutcomes.payload } : null
    }
  };
}

/** Read the engine label out of the ClientProfile doc, if present. */
export function engineFromProfile(profile: unknown | null): string {
  const obj = asPlainObject(profile);
  const engine = obj?.engine;
  return typeof engine === "string" && engine.length > 0 ? engine : "unknown";
}

/** Assemble the full OversightInput for a client (shared with explain.ts). */
export async function loadOversightInput(args: {
  tenantId: string;
  clientKey: string;
  rows: PendingSuggestionRow[];
  stores: OversightStores;
  now: Date;
}): Promise<OversightInput> {
  const { tenantId, clientKey, rows, stores, now } = args;
  const listingIds = [...new Set(rows.map((r) => r.listingId).filter((id): id is string => Boolean(id)))];
  const since = new Date(now.getTime() - RECENT_DECISION_WINDOW_DAYS * 86_400_000);
  const [listingNames, tenantName, profile, evidence, recentDecisions, globalMethodology] = await Promise.all([
    stores.loadListingNames(tenantId, listingIds),
    stores.loadTenantName(tenantId),
    stores.loadClientProfile(tenantId, clientKey),
    stores.loadEvidence(tenantId, clientKey),
    stores.loadRecentDecisions(tenantId, clientKey, since),
    stores.loadGlobalMethodology()
  ]);
  return {
    tenantId,
    clientKey,
    clientName: tenantName ?? clientKey,
    engine: engineFromProfile(profile),
    suggestions: rows.map((row) => mapRowToSuggestionInput(row, listingNames)),
    profileSummary: buildProfileSummary(profile, evidence),
    recentDecisions,
    ...(globalMethodology !== null && globalMethodology !== undefined ? { globalMethodology } : {})
  };
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

export async function runOversightForClient(args: {
  tenantId: string;
  clientKey: string;
  now?: () => Date;
  deps?: OversightDeps;
}): Promise<OversightResult> {
  const { tenantId, clientKey } = args;
  const nowFn = args.now ?? (() => new Date());
  const config = resolveOversightConfig(args.deps?.config);
  const callModel = args.deps?.callModel ?? callOversightModel;

  let stores: OversightStores;
  try {
    stores = await resolveStores(args.deps);
  } catch (err) {
    console.warn(`${LOG_PREFIX} store init failed for ${clientKey}: ${err instanceof Error ? err.message : String(err)}`);
    return { status: "error", error: "store init failed" };
  }

  // 1. Disabled / no key → audit row, never throw, recs ship unannotated.
  if (!config.enabled || !config.apiKey) {
    let suggestionCount: number | null = null;
    try {
      suggestionCount = await stores.countPendingSuggestions(tenantId, clientKey);
    } catch (err) {
      console.warn(`${LOG_PREFIX} pending count failed for ${clientKey}: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await stores.createOversightRun({
        tenantId,
        clientKey,
        runAt: nowFn(),
        model: config.model,
        status: "disabled",
        suggestionCount
      });
    } catch (err) {
      console.warn(`${LOG_PREFIX} disabled-row write failed for ${clientKey}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { status: "disabled" };
  }

  try {
    // 2. Load pending page suggestions (status query, recsPage filter in JS).
    const pending = await stores.loadPendingSuggestions(tenantId, clientKey);
    // Cap the model's input to the rows that matter most: full coverage on a
    // big client is hundreds of rows and would blow past the output-token cap
    // (every verdict must fit in one JSON reply). Drops rank above holds,
    // then by revenue at risk.
    const pageRows = pending
      .filter((row) => detailIsRecsPage(row.detail))
      .sort((a, b) => {
        const holdA = typeof a.detail === "object" && a.detail !== null && (a.detail as { hold?: unknown }).hold === true ? 1 : 0;
        const holdB = typeof b.detail === "object" && b.detail !== null && (b.detail as { hold?: unknown }).hold === true ? 1 : 0;
        if (holdA !== holdB) return holdA - holdB;
        return (Number(b.revenueAtRisk ?? 0) || 0) - (Number(a.revenueAtRisk ?? 0) || 0);
      })
      .slice(0, 50);

    // 3. Nothing to review → ok row with a zero count.
    if (pageRows.length === 0) {
      await stores.createOversightRun({
        tenantId,
        clientKey,
        runAt: nowFn(),
        model: config.model,
        status: "ok",
        suggestionCount: 0
      });
      return { status: "ok", verdicts: [], clientRead: [] };
    }

    // 4. Build prompts, call the model, persist run + per-suggestion overlay.
    const input = await loadOversightInput({ tenantId, clientKey, rows: pageRows, stores, now: nowFn() });
    const result = await callModel({
      system: buildSystemPrompt(),
      user: buildUserPrompt(input),
      model: config.model,
      apiKey: config.apiKey,
      knownSuggestionIds: input.suggestions.map((s) => s.id)
    });
    if (result.droppedSuggestionIds.length > 0) {
      console.warn(`${LOG_PREFIX} dropped unknown suggestionIds for ${clientKey}: ${result.droppedSuggestionIds.join(", ")}`);
    }

    const flagCount = result.verdicts.filter((v) => v.verdict === "flag").length;
    const run = await stores.createOversightRun({
      tenantId,
      clientKey,
      runAt: nowFn(),
      model: config.model,
      status: "ok",
      suggestionCount: pageRows.length,
      flagCount,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costUsd: result.costUsd,
      clientRead: result.clientRead
    });

    const at = nowFn().toISOString();
    for (const verdict of result.verdicts) {
      const annotation: OversightDetailAnnotation = {
        verdict: verdict.verdict,
        reason: verdict.reason,
        narrative: verdict.narrative,
        model: config.model,
        runId: run.id,
        at
      };
      try {
        await stores.mergeSuggestionOversight(tenantId, verdict.suggestionId, annotation);
      } catch (err) {
        console.warn(
          `${LOG_PREFIX} detail merge failed for suggestion ${verdict.suggestionId} (${clientKey}): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return {
      status: "ok",
      verdicts: result.verdicts,
      clientRead: result.clientRead,
      usage: result.usage,
      costUsd: result.costUsd
    };
  } catch (err) {
    // 5. ANY failure → error row + resolve. Never block the recs pipeline.
    const message = redactKey(err instanceof Error ? err.message : String(err), config.apiKey).slice(0, 1000);
    console.warn(`${LOG_PREFIX} run failed for ${clientKey}: ${message}`);
    try {
      await stores.createOversightRun({
        tenantId,
        clientKey,
        runAt: nowFn(),
        model: config.model,
        status: "error",
        suggestionCount: null,
        error: message
      });
    } catch (writeErr) {
      console.warn(
        `${LOG_PREFIX} error-row write failed for ${clientKey}: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`
      );
    }
    return { status: "error", error: message };
  }
}
