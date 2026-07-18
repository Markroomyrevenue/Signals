/**
 * Pure prompt builders for the recs oversight call.
 *
 * `buildSystemPrompt()` is deliberately STABLE — it contains no client data,
 * no dates, no ids — so it can carry a `cache_control: ephemeral` breakpoint
 * and be served from the prompt cache across the ~6 client calls in a run
 * (prompt caching is a byte-exact prefix match; any variation would defeat it).
 * All volatile, per-client content lives in `buildUserPrompt(input)`.
 *
 * Isolation invariants (tested):
 *   - a user prompt renders ONLY the one client's data handed to it;
 *   - `tenantId` is never rendered (DB scoping only);
 *   - no key material can appear (prompts are built purely from OversightInput).
 */

import type { OversightInput, OversightSuggestionInput } from "./types";

/**
 * The exact response contract. Kept in one exported constant so the client's
 * validator and the tests agree with what the model was asked for.
 */
export const OVERSIGHT_OUTPUT_CONTRACT = `{"verdicts":[{"suggestionId":"...","verdict":"endorse"|"flag","reason":"one line, only when flag","narrative":"1-2 plain-English sentences for this night"}],"clientRead":["3-5 bullets"]}`;

/**
 * Stable, cacheable system prompt. DO NOT interpolate anything volatile here
 * (timestamps, client names, counts) — that would invalidate the cache prefix.
 */
export function buildSystemPrompt(): string {
  return [
    "You are a revenue-management overseer reviewing machine-generated nightly price recommendations for a short-term-rental client. The recommendations were produced by a deterministic engine from the client's own booking history, observed engine behaviour, and safety gates (floors, cumulative-drop caps). Your job is to review each pending recommendation and give an honest second opinion for the human operator who will approve or reject it.",
    "",
    "Philosophy:",
    "- The operator's historical behaviour is the STARTING PRIOR, not the target. Divergence from what the operator would have done, when backed by evidence, is the product working — endorse it and say why.",
    "- Flag UNEXPLAINED divergence: a recommendation that moves away from both the operator's pattern and the evidence shown, with no stated reason that the data supports.",
    "- Flag evidence-free confidence: high confidence attached to a night whose supporting data is thin, missing, or contradictory.",
    "- Flag thin or contradictory warm-start data: recommendations built on warm-start priors that the client's own observed outcomes have since contradicted.",
    "- Be honest in BOTH directions: also call out where the operator's own historical pattern measurably did not land — nights held too high that expired empty, or sold too cheap too early. Deference to the operator is not the goal; evidence is.",
    "- You NEVER propose changing a price, a new number, or an alternative rate. Your verdicts are an overlay on the existing recommendations only. Endorse or flag; nothing else.",
    "- A flag never blocks a recommendation — it is context for the human. Do not tell the operator to reject anything; state what the evidence does or does not support.",
    "",
    "Per-night narrative: 1-2 plain-English sentences a non-technical host can read. No jargon, no internal field names, no hedging boilerplate.",
    "Client read: 3-5 bullets summarising the honest overall picture of this batch for this client — what the engine is doing well, where the data is thin, and anything the operator should watch.",
    "",
    "Output contract: respond with STRICT JSON only — no markdown fences, no prose before or after. Exact shape:",
    OVERSIGHT_OUTPUT_CONTRACT,
    `"reason" must be present (one line) when verdict is "flag" and null otherwise. Every suggestionId you return must be one of the ids given in the input. Cover every suggestion exactly once.`
  ].join("\n");
}

function money(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "?";
  return String(Math.round(value * 100) / 100);
}

function pct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "?";
  return `${Math.round(value * 1000) / 10}%`;
}

function suggestionLine(s: OversightSuggestionInput): string {
  const provenance = `${s.provenance ?? "unknown"}${s.provisional ? " (provisional)" : ""}`;
  const conf = s.confidence === null || !Number.isFinite(s.confidence) ? "?" : String(s.confidence);
  const parts = [
    `id=${s.id}`,
    `listing=${s.listingName}`,
    `night=${s.date} (${s.dow})`,
    `current=${money(s.currentPrice)}`,
    `proposed=${money(s.proposedPrice)}`,
    `drop=${pct(s.dropPct)}`,
    `floor=${money(s.floor)}`,
    `revenueAtRisk=${money(s.revenueAtRisk)}`,
    `confidence=${conf}`,
    `provenance=${provenance}`,
    `reason=${s.reason}`
  ];
  const line = `- ${parts.join(" | ")}`;
  const extras: string[] = [];
  if (s.suppressed) extras.push(`  suppressed: ${s.suppressed}`);
  if (s.marketContribution) extras.push(`  market: ${s.marketContribution}`);
  return extras.length > 0 ? `${line}\n${extras.join("\n")}` : line;
}

/**
 * Render the client's data compactly. Deterministic (stable key order comes
 * from JSON.stringify of the pre-built summary objects) but NOT cached — this
 * block changes every run and sits after the cache breakpoint.
 */
export function buildUserPrompt(input: OversightInput): string {
  const sections: string[] = [];

  sections.push(
    [
      `Client: ${input.clientName} (key: ${input.clientKey})`,
      `Pricing engine: ${input.engine}`,
      `Pending recommendations to review: ${input.suggestions.length}`
    ].join("\n")
  );

  sections.push(`Client profile summary (from observed behaviour):\n${JSON.stringify(input.profileSummary ?? null)}`);

  if (input.recentDecisions.length > 0) {
    const lines = input.recentDecisions.map(
      (d) =>
        `- ${d.date} | ${d.listingName} | ${d.action} | price=${money(d.price)}${d.outcomeSoFar ? ` | outcome so far: ${d.outcomeSoFar}` : ""}`
    );
    sections.push(`Human decisions on this client's recs, last 7 days:\n${lines.join("\n")}`);
  } else {
    sections.push("Human decisions on this client's recs, last 7 days: none.");
  }

  sections.push(`Pending recommendations:\n${input.suggestions.map(suggestionLine).join("\n")}`);

  if (input.globalMethodology !== undefined && input.globalMethodology !== null) {
    sections.push(`Global methodology (anonymised, cross-client market truth):\n${JSON.stringify(input.globalMethodology)}`);
  }

  sections.push(
    `Review every recommendation above. Respond with STRICT JSON only, matching the contract exactly:\n${OVERSIGHT_OUTPUT_CONTRACT}`
  );

  return sections.join("\n\n");
}

/**
 * Single-suggestion variant for the on-demand "explain this night" action.
 * Same output contract (a one-entry verdicts array) so the same validator
 * applies; the extra instruction asks for a fuller narrative for this night.
 */
export function buildExplainUserPrompt(input: OversightInput): string {
  const base = buildUserPrompt(input);
  return `${base}\n\nThis is an on-demand explain request for the single night above: write the narrative as 2-4 plain-English sentences a non-technical host can act on, still inside the same STRICT JSON contract.`;
}
