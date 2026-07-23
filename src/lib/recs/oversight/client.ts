/**
 * Raw-fetch Anthropic Messages API client for the recs overseer.
 *
 * Follows the hardening precedent in
 * `src/lib/agents/defensibility-audit/agent.ts` (x-api-key /
 * anthropic-version / content-type headers, non-2xx → non-fatal upstream) and
 * adds: bounded retries (2) on 429 / 5xx / overloaded_error with exponential
 * backoff, a 60s per-attempt timeout, and injectable fetchImpl / sleepImpl so
 * tests never touch the network.
 *
 * Model notes (verified against the claude-api skill, 2026-07-18):
 *   - Default model `claude-fable-5` is a real model id ($10/MTok in,
 *     $50/MTok out). Thinking is always on — the `thinking` param is OMITTED.
 *   - Sampling params (`temperature`/`top_p`/`top_k`) are REJECTED with a 400
 *     on claude-fable-5 (and Opus 4.7/4.8 / Sonnet 5), so despite the original
 *     "temperature 0.2" spec line, no temperature is sent — determinism is
 *     steered via the strict output contract in the prompt instead.
 *   - The stable system prompt is sent as a system array block carrying
 *     `cache_control: {type: "ephemeral"}` so the ~6 client calls per run
 *     share a cached prefix (minimum cacheable prefix on fable-5 is ~2048
 *     tokens; below that the marker is silently inert, which is harmless).
 *   - A `stop_reason` of "refusal" is surfaced as a typed OversightError.
 */

import * as fs from "node:fs";

import type { OversightUsage, OversightVerdict, OversightVerdictLabel } from "./types";

const ANTHROPIC_BASE = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Default output cap. claude-fable-5's always-on thinking is billed and
 * counted as OUTPUT tokens, so the cap must hold the thinking budget PLUS the
 * verdict JSON for ≤50 recs — 4000 hit stop_reason max_tokens on the very
 * first live call (2026-07-18) with zero text emitted. Env-overridable.
 */
export const OVERSIGHT_MAX_TOKENS = (() => {
  const raw = Number.parseInt(process.env.RECS_OVERSIGHT_MAX_TOKENS ?? "", 10);
  return Number.isFinite(raw) && raw >= 1000 ? raw : 16000;
})();
/** Retries AFTER the first attempt (so 3 attempts total). */
export const OVERSIGHT_MAX_RETRIES = 2;
/** Per-attempt abort timeout. */
/**
 * Per-attempt abort timeout. fable-5's always-on thinking plus a 50-verdict
 * JSON reply routinely takes 1-3 minutes — 60s aborted every live call on
 * night one (2026-07-19). Env-overridable.
 */
export const OVERSIGHT_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(process.env.RECS_OVERSIGHT_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 10_000 ? raw : 300_000;
})();
/** Base backoff, doubled per retry (2s → 4s). */
export const OVERSIGHT_BASE_BACKOFF_MS = 2_000;

/**
 * Approximate per-MTok USD rates used for the OversightRun cost column.
 * Defaults are claude-fable-5's published rates ($10 in / $50 out per MTok,
 * from the claude-api skill's model table). Env-overridable so a model swap
 * via RECS_OVERSIGHT_MODEL can carry matching rates without a deploy:
 *   RECS_OVERSIGHT_COST_IN_PER_MTOK / RECS_OVERSIGHT_COST_OUT_PER_MTOK.
 * The figure is an approximation: cache reads bill at ~0.1× and cache writes
 * at ~1.25×, but we fold all prompt tokens in at the input rate — a slight
 * overestimate, acceptable for a £1–2/day budget monitor.
 */
export const DEFAULT_COST_IN_PER_MTOK = 10;
export const DEFAULT_COST_OUT_PER_MTOK = 50;

export type OversightErrorKind =
  | "no_api_key"
  | "http"
  | "refusal"
  | "empty_response"
  | "parse"
  | "validation"
  | "network";

/** Typed failure. The message is always redacted of the API key. */
export class OversightError extends Error {
  readonly kind: OversightErrorKind;
  constructor(kind: OversightErrorKind, message: string) {
    super(message);
    this.name = "OversightError";
    this.kind = kind;
  }
}

/**
 * Read the Anthropic key the same way the defensibility-audit agent does
 * (`src/lib/agents/defensibility-audit/agent.ts` — not exported there, so
 * replicated): env first, then a direct `.env` read because the shell may
 * export ANTHROPIC_API_KEY="" which @next/env preserves.
 */
export function readAnthropicKey(): string | null {
  const fromEnv = process.env.ANTHROPIC_API_KEY;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  try {
    const content = fs.readFileSync(".env", "utf8");
    const m = content.match(/^ANTHROPIC_API_KEY=(.+)$/m);
    if (m && m[1].length > 0) return m[1].trim();
  } catch {
    // ignore — no .env file is a normal state (e.g. Railway env-only)
  }
  return null;
}

/** Strip an API key out of any message that might echo request context. */
export function redactKey(message: string, apiKey: string | null): string {
  if (!apiKey || apiKey.length === 0) return message;
  return message.split(apiKey).join("[redacted]");
}

/** Strip ```json fences (and bare ``` fences) from a model response. */
export function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  return fenced ? fenced[1].trim() : trimmed;
}

export type ValidatedOversightOutput = {
  verdicts: OversightVerdict[];
  clientRead: string[];
  /** Ids the model returned that were not in the known set (dropped). */
  droppedSuggestionIds: string[];
  /** Entries whose SHAPE was wrong (bad verdict label, missing id, …) and were
   * skipped. Non-fatal — see `validateOversightOutput`. */
  malformedVerdicts: number;
};

const VERDICT_LABELS: readonly OversightVerdictLabel[] = ["endorse", "flag"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Hand-rolled validator for the model's JSON.
 *
 * STRUCTURAL problems are fatal (not an object, `verdicts` not an array, a bad
 * `clientRead`) — the response is not the contract and nothing can be trusted.
 *
 * A single malformed ENTRY is not. It used to be: any bad verdict threw, and
 * the caller discards the whole run. On 2026-07-23 the model returned 51
 * verdicts for 50 suggestions and the 51st had an empty id, so Escape Ordinary
 * got zero verdicts across all 235 of its pending recommendations — 50 good,
 * paid-for reviews thrown away over one bad row. Bad entries are now skipped
 * and counted in `malformedVerdicts`.
 *
 * Unknown suggestionIds stay non-fatal too, reported in `droppedSuggestionIds`.
 *
 * The one exception: if EVERY entry in a non-empty array is malformed, the
 * response really is garbage, and returning "reviewed, no verdicts" would be a
 * far worse lie than failing — so that still throws.
 */
export function validateOversightOutput(value: unknown, knownSuggestionIds: readonly string[]): ValidatedOversightOutput {
  if (!isPlainObject(value)) {
    throw new OversightError("validation", "oversight output is not a JSON object");
  }
  const { verdicts, clientRead } = value;
  if (!Array.isArray(verdicts)) {
    throw new OversightError("validation", "oversight output: `verdicts` is not an array");
  }
  if (!Array.isArray(clientRead) || clientRead.length < 1 || clientRead.length > 8) {
    throw new OversightError("validation", "oversight output: `clientRead` must be an array of 1..8 strings");
  }
  const bullets: string[] = [];
  for (const bullet of clientRead) {
    if (typeof bullet !== "string" || bullet.trim().length === 0) {
      throw new OversightError("validation", "oversight output: `clientRead` entries must be non-empty strings");
    }
    bullets.push(bullet.trim());
  }

  const known = new Set(knownSuggestionIds);
  const kept: OversightVerdict[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  let malformed = 0;
  for (const raw of verdicts) {
    if (!isPlainObject(raw)) {
      malformed += 1;
      continue;
    }
    const { suggestionId, verdict, reason, narrative } = raw;
    const shapeOk =
      typeof suggestionId === "string" &&
      suggestionId.length > 0 &&
      typeof verdict === "string" &&
      VERDICT_LABELS.includes(verdict as OversightVerdictLabel) &&
      typeof narrative === "string" &&
      (reason === null || reason === undefined || typeof reason === "string");
    if (!shapeOk) {
      malformed += 1;
      continue;
    }
    if (!known.has(suggestionId as string)) {
      dropped.push(suggestionId as string);
      continue;
    }
    if (seen.has(suggestionId as string)) continue; // duplicate — keep first occurrence
    seen.add(suggestionId as string);
    kept.push({
      suggestionId: suggestionId as string,
      verdict: verdict as OversightVerdictLabel,
      reason: typeof reason === "string" && reason.trim().length > 0 ? reason.trim() : null,
      narrative: narrative as string
    });
  }
  // Every entry unusable = the response is not a review, whatever its shape.
  if (verdicts.length > 0 && kept.length === 0 && dropped.length === 0) {
    throw new OversightError(
      "validation",
      `oversight output: all ${verdicts.length} verdict entries were malformed`
    );
  }
  return { verdicts: kept, clientRead: bullets, droppedSuggestionIds: dropped, malformedVerdicts: malformed };
}

/** Compute the approximate USD cost of a call. Rates: see the constants above. */
export function computeCostUsd(
  usage: OversightUsage,
  rates?: { inPerMTok?: number; outPerMTok?: number }
): number {
  const envIn = Number.parseFloat(process.env.RECS_OVERSIGHT_COST_IN_PER_MTOK ?? "");
  const envOut = Number.parseFloat(process.env.RECS_OVERSIGHT_COST_OUT_PER_MTOK ?? "");
  const inRate = rates?.inPerMTok ?? (Number.isFinite(envIn) ? envIn : DEFAULT_COST_IN_PER_MTOK);
  const outRate = rates?.outPerMTok ?? (Number.isFinite(envOut) ? envOut : DEFAULT_COST_OUT_PER_MTOK);
  const cost = (usage.inputTokens * inRate + usage.outputTokens * outRate) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

type AnthropicMessagesResponse = {
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
};

export type CallOversightModelArgs = {
  system: string;
  user: string;
  model: string;
  /** Ids the verdicts must key into; unknown ids are dropped with a warning. */
  knownSuggestionIds: readonly string[];
  /** Explicit key; defaults to readAnthropicKey(). */
  apiKey?: string | null;
  maxTokens?: number;
  timeoutMs?: number;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to a real timer. */
  sleepImpl?: (ms: number) => Promise<void>;
};

export type CallOversightModelResult = ValidatedOversightOutput & {
  usage: OversightUsage;
  costUsd: number;
};

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 529 || (status >= 500 && status < 600);
}

/**
 * One reviewed-and-validated oversight call. Throws a typed OversightError
 * (key-redacted) on any failure after retries; the caller (`run.ts`) converts
 * that into a non-fatal `status: "error"` OversightRun row.
 */
export async function callOversightModel(args: CallOversightModelArgs): Promise<CallOversightModelResult> {
  const {
    system,
    user,
    model,
    knownSuggestionIds,
    maxTokens = OVERSIGHT_MAX_TOKENS,
    timeoutMs = OVERSIGHT_TIMEOUT_MS,
    fetchImpl = fetch,
    sleepImpl = defaultSleep
  } = args;
  const apiKey = args.apiKey !== undefined ? args.apiKey : readAnthropicKey();
  if (!apiKey) {
    throw new OversightError("no_api_key", "ANTHROPIC_API_KEY is not set");
  }

  const body = JSON.stringify({
    model,
    max_tokens: maxTokens,
    // Stable prefix carries the cache breakpoint; user content stays after it.
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }]
    // No `temperature`: rejected (400) on claude-fable-5 — see file header.
  });

  let lastError: OversightError | null = null;
  for (let attempt = 0; attempt <= OVERSIGHT_MAX_RETRIES; attempt += 1) {
    if (attempt > 0) {
      await sleepImpl(OVERSIGHT_BASE_BACKOFF_MS * Math.pow(2, attempt - 1));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${ANTHROPIC_BASE}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json"
        },
        body,
        signal: controller.signal
      });
    } catch (err) {
      clearTimeout(timer);
      // Network failure / timeout — retryable.
      lastError = new OversightError(
        "network",
        redactKey(`anthropic request failed: ${err instanceof Error ? err.message : String(err)}`, apiKey)
      );
      continue;
    }
    clearTimeout(timer);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const message = redactKey(`anthropic call failed ${response.status}: ${text.slice(0, 300)}`, apiKey);
      if (isRetryableStatus(response.status)) {
        lastError = new OversightError("http", message);
        continue;
      }
      throw new OversightError("http", message);
    }

    const data = (await response.json()) as AnthropicMessagesResponse;
    if (data.stop_reason === "refusal") {
      // claude-fable-5 safety classifiers can decline with HTTP 200. Not
      // retryable on the same body — surface as a typed error.
      throw new OversightError("refusal", "anthropic declined the request (stop_reason: refusal)");
    }
    const text = data.content?.find((c) => c.type === "text")?.text ?? "";
    if (text.trim().length === 0) {
      throw new OversightError("empty_response", `anthropic returned no text content (stop_reason: ${data.stop_reason ?? "?"})`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripMarkdownFences(text));
    } catch (err) {
      throw new OversightError(
        "parse",
        redactKey(`oversight response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`, apiKey)
      );
    }
    const validated = validateOversightOutput(parsed, knownSuggestionIds);
    const usage: OversightUsage = {
      inputTokens:
        (data.usage?.input_tokens ?? 0) +
        (data.usage?.cache_creation_input_tokens ?? 0) +
        (data.usage?.cache_read_input_tokens ?? 0),
      outputTokens: data.usage?.output_tokens ?? 0
    };
    return { ...validated, usage, costUsd: computeCostUsd(usage) };
  }

  throw lastError ?? new OversightError("http", "anthropic call failed after retries");
}
