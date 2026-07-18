/**
 * On-demand per-night "explain this night" action.
 *
 * Single-suggestion prompt variant of the nightly oversight call. Returns the
 * narrative text for the UI and refreshes `detail.oversight` for that one row
 * (with `runId: null` — no OversightRun row is written for explains; the
 * per-run audit trail is for batch runs only).
 *
 * Like the runner, it never throws: every outcome comes back as a result
 * object so an API route can render it directly.
 */

import { callOversightModel, redactKey } from "./client";
import { buildExplainUserPrompt, buildSystemPrompt } from "./prompt";
import { loadOversightInput, resolveOversightConfig, type OversightDeps, type OversightStores } from "./run";
import type { OversightDetailAnnotation, OversightVerdictLabel } from "./types";

const LOG_PREFIX = "[recs-oversight]";

export type ExplainNightResult =
  | { status: "ok"; narrative: string; verdict: OversightVerdictLabel; reason: string | null }
  | { status: "disabled" }
  | { status: "error"; error: string };

async function resolveStores(deps?: OversightDeps): Promise<OversightStores> {
  if (deps?.stores) return deps.stores;
  const mod = await import("./store");
  return mod.prismaOversightStores;
}

export async function explainNight(args: {
  tenantId: string;
  suggestionId: string;
  now?: () => Date;
  deps?: OversightDeps;
}): Promise<ExplainNightResult> {
  const { tenantId, suggestionId } = args;
  const nowFn = args.now ?? (() => new Date());
  const config = resolveOversightConfig(args.deps?.config);
  const callModel = args.deps?.callModel ?? callOversightModel;

  if (!config.enabled || !config.apiKey) return { status: "disabled" };

  let stores: OversightStores;
  try {
    stores = await resolveStores(args.deps);
  } catch (err) {
    console.warn(`${LOG_PREFIX} explain store init failed: ${err instanceof Error ? err.message : String(err)}`);
    return { status: "error", error: "store init failed" };
  }

  try {
    const row = await stores.loadSuggestionById(tenantId, suggestionId);
    if (!row) return { status: "error", error: "suggestion not found" };

    const clientKey = row.clientKey ?? "";
    const input = await loadOversightInput({ tenantId, clientKey, rows: [row], stores, now: nowFn() });
    const result = await callModel({
      system: buildSystemPrompt(),
      user: buildExplainUserPrompt(input),
      model: config.model,
      apiKey: config.apiKey,
      knownSuggestionIds: [suggestionId]
    });
    const verdict = result.verdicts.find((v) => v.suggestionId === suggestionId);
    if (!verdict) {
      return { status: "error", error: "model returned no verdict for this suggestion" };
    }

    const annotation: OversightDetailAnnotation = {
      verdict: verdict.verdict,
      reason: verdict.reason,
      narrative: verdict.narrative,
      model: config.model,
      runId: null,
      at: nowFn().toISOString()
    };
    try {
      await stores.mergeSuggestionOversight(tenantId, suggestionId, annotation);
    } catch (err) {
      // The narrative is still useful without the persisted refresh.
      console.warn(
        `${LOG_PREFIX} explain merge failed for suggestion ${suggestionId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    return { status: "ok", narrative: verdict.narrative, verdict: verdict.verdict, reason: verdict.reason };
  } catch (err) {
    const message = redactKey(err instanceof Error ? err.message : String(err), config.apiKey).slice(0, 1000);
    console.warn(`${LOG_PREFIX} explain failed for suggestion ${suggestionId}: ${message}`);
    return { status: "error", error: message };
  }
}
