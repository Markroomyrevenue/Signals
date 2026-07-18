/**
 * Runtime Claude overseer for the recs page — shared types.
 *
 * The overseer runs after every suggestion generation: one Anthropic Messages
 * API call per client reviews that client's pending page recommendations and
 * overlays endorse/flag verdicts + plain-English narratives. It NEVER changes
 * a price and NEVER blocks a rec — when oversight is disabled, unfunded, or
 * failing, recommendations ship unannotated.
 *
 * Tenant isolation applies to prompts as well as queries: a single oversight
 * call contains ONLY that client's data (plus the anonymised global
 * methodology doc, which by design carries no client identity). No engine
 * keys, API keys, or tenant ids ever enter a prompt.
 */

export type OversightVerdictLabel = "endorse" | "flag";

/** One per-suggestion verdict returned by the model. */
export type OversightVerdict = {
  suggestionId: string;
  verdict: OversightVerdictLabel;
  /** One line, present only when the verdict is "flag" (null otherwise). */
  reason: string | null;
  /** 1–2 plain-English sentences about this night, always present. */
  narrative: string;
};

export type OversightUsage = {
  /** Total prompt tokens (incl. cache creation/read tokens — see client.ts). */
  inputTokens: number;
  outputTokens: number;
};

export type OversightStatus = "ok" | "error" | "disabled";

/** What `runOversightForClient` resolves with. It NEVER throws. */
export type OversightResult = {
  status: OversightStatus;
  /** Present on the ok path (empty when nothing was pending). */
  verdicts?: OversightVerdict[];
  /** 3–5 client-level bullets ("the client read"). */
  clientRead?: string[];
  usage?: OversightUsage;
  costUsd?: number;
  /** Redacted error message on the error path. */
  error?: string;
};

/** One pending recs-page suggestion, flattened for the prompt. */
export type OversightSuggestionInput = {
  id: string;
  listingName: string;
  /** ISO date (yyyy-mm-dd) of the night. */
  date: string;
  /** Day of week, e.g. "Fri". */
  dow: string;
  currentPrice: number | null;
  proposedPrice: number | null;
  /** Fractional drop, e.g. -0.12 for a 12% drop. Null when unknown. */
  dropPct: number | null;
  revenueAtRisk: number | null;
  reason: string;
  confidence: number | null;
  /** "warm-start" | "live-observed" (free string by design). */
  provenance: string | null;
  /** Generated before the client's 30-day observation window graduated. */
  provisional: boolean;
  /** Never-cross floor for the night. Null when the floor is unknown. */
  floor: number | null;
  /** Why a further drop was suppressed by a safety gate, when applicable. */
  suppressed?: string | null;
  /** Market-signal contribution line, when the engine recorded one. */
  marketContribution?: string | null;
};

/** A recent human decision on this client's recs (last 7 days). */
export type OversightRecentDecision = {
  date: string;
  listingName: string;
  /** "approved" | "rejected" | "applied" (free string by design). */
  action: string;
  price: number | null;
  outcomeSoFar?: string | null;
};

/** Everything one oversight call sees. ONE client only — never mix tenants. */
export type OversightInput = {
  /** For DB scoping only — MUST NOT be rendered into any prompt. */
  tenantId: string;
  clientKey: string;
  clientName: string;
  /** The client's pricing engine label, e.g. "pricelabs" | "wheelhouse". */
  engine: string;
  suggestions: OversightSuggestionInput[];
  /** ClientProfile JSON (+ evidence enrichment), pre-loaded by the caller. */
  profileSummary: unknown;
  recentDecisions: OversightRecentDecision[];
  /** The single anonymised global methodology doc — safe to include. */
  globalMethodology?: unknown;
};

/**
 * The `oversight` object merged into `Suggestion.detail`. The merge is always
 * read-spread-write: existing detail keys (floor / score / curveCohort / …)
 * are never dropped.
 */
export type OversightDetailAnnotation = {
  verdict: OversightVerdictLabel;
  reason: string | null;
  narrative: string;
  model: string;
  /** OversightRun row id, or null for the on-demand explain refresh. */
  runId: string | null;
  /** ISO timestamp of the annotation. */
  at: string;
};
