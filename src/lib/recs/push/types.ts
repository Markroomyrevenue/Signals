/**
 * Shared shapes for the recs push module — the only code in the product that
 * writes to external pricing engines (PriceLabs date overrides, Wheelhouse
 * custom rates). Every write goes: hard gates → adapter.preview →
 * adapter.execute → adapter.verify, with exactly one PushLog row per attempt.
 */

export type RecsPushEngine = "pricelabs" | "wheelhouse";

export const RECS_PUSH_ENGINES: readonly RecsPushEngine[] = ["pricelabs", "wheelhouse"];

export function isRecsPushEngine(value: string): value is RecsPushEngine {
  return (RECS_PUSH_ENGINES as readonly string[]).includes(value);
}

/** Everything an adapter needs to push (and later verify/revert) one night. */
export type RecsPushTarget = {
  tenantId: string;
  tenantName: string;
  clientKey: string;
  suggestionId: string;
  listingId: string;
  engineListingId: string;
  /** YYYY-MM-DD — a push is always a single night. */
  date: string;
  /** The price to write (approvedPrice ?? proposedValue, gate-checked upstream). */
  price: number;
  currency: string;
  /** Generator-computed floor for this night; null when no floor applies. */
  floor: number | null;
  /** True when the generator could not determine a floor for this night. */
  floorUnknown: boolean;
  /** The engine price this suggestion proposed to replace (audit only). */
  oldValue: number | null;
};

export type RecsVerifyResult = {
  /** False when the verify read itself was never made (e.g. execute failed). */
  attempted: boolean;
  verified: boolean;
  observedPrice?: number | null;
};

/** Outcome of one engine write call (execute or revert). Errors are pre-redacted. */
export type EngineWriteResult = {
  ok: boolean;
  /** HTTP status when the failure carried one. */
  status?: number;
  /** Redacted, human-readable failure detail. NEVER contains key material. */
  errorMessage?: string;
};

export type RecsPushOutcome = {
  ok: boolean;
  result: "success" | "failed" | "skipped";
  /** Gate/failure reason, e.g. "not_approved", "below_floor", "verify_mismatch". */
  reason?: string;
  verify?: RecsVerifyResult;
  /** Id of the PushLog row written for this attempt (null only if the audit write itself failed). */
  pushLogId: string | null;
  /** Redacted engine-side error detail, when the engine call failed. */
  engineError?: string;
};

/**
 * One engine's write surface. `preview` is the engine-specific pre-flight
 * (Wheelhouse: owner custom-rate conflict check; PriceLabs: listing-in-account
 * check) and must not mutate anything. `verify`/`verifyReverted` read the
 * engine back — a 2xx on execute is NEVER trusted on its own (Hostaway taught
 * us the silent-accept failure mode; PriceLabs/Wheelhouse get the same
 * treatment).
 */
export interface RecsEnginePushAdapter {
  readonly engine: RecsPushEngine;
  preview(target: RecsPushTarget): Promise<{ ok: boolean; blockedReason?: string }>;
  execute(target: RecsPushTarget): Promise<EngineWriteResult>;
  verify(target: RecsPushTarget): Promise<RecsVerifyResult>;
  revert(target: RecsPushTarget): Promise<EngineWriteResult>;
  verifyReverted(target: RecsPushTarget): Promise<RecsVerifyResult>;
}

/**
 * Extra read used only by the guarded self-test CLI: the engine's CURRENT
 * price for a date, so the self-test can push that same value (a no-op).
 * Kept off `RecsEnginePushAdapter` so production push code cannot depend on it.
 */
export interface RecsSelfTestReads {
  readCurrentPrice(engineListingId: string, date: string): Promise<number | null>;
}
