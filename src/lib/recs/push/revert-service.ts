/**
 * Revert a pushed night: delete our engine write so the date returns to the
 * engine's own recommended price (PriceLabs: DELETE the date override;
 * Wheelhouse: DELETE the single-day custom rate), verify it is gone, and record
 * one PushLog row with detail.kind "revert".
 *
 * Only suggestions with status "applied" + a pushRef are revertable. On a
 * verified revert the suggestion KEEPS status "applied" and pushRef — the
 * append-only truth is `detail.push.reverted = { at, by, verified: true }`,
 * which the UI reads. (Restoring "approved" would be a lie about state, and
 * pushRef staying set keeps the push-once idempotency intact either way.)
 */

import {
  buildDefaultAdapterFactory,
  priceToPush,
  detailFloor,
  detailFloorUnknown,
  DEFAULT_PUSH_LOG_STORE,
  DEFAULT_SUGGESTION_STORE,
  type RecsPushDeps
} from "./push-service";
import {
  isRecsPushEngine,
  type RecsPushOutcome,
  type RecsPushTarget,
  type RecsVerifyResult
} from "./types";

export type RevertPushedNightArgs = {
  tenantId: string;
  tenantName: string;
  suggestionId: string;
  engine: string;
  actorEmail: string;
  currency?: string;
};

export async function revertPushedNight(
  args: RevertPushedNightArgs,
  deps: RecsPushDeps = {}
): Promise<RecsPushOutcome> {
  const suggestionStore = deps.suggestionStore ?? DEFAULT_SUGGESTION_STORE;
  const pushLogStore = deps.pushLogStore ?? DEFAULT_PUSH_LOG_STORE;
  const adapterFactory = deps.adapterFactory ?? buildDefaultAdapterFactory();
  const now = deps.now ?? (() => new Date());

  const suggestion = await suggestionStore.load({
    tenantId: args.tenantId,
    suggestionId: args.suggestionId
  });
  const pushedPrice = priceToPush(suggestion);

  async function gate(
    result: "skipped" | "failed",
    reason: string,
    extraDetail: Record<string, unknown> = {}
  ): Promise<RecsPushOutcome> {
    let pushLogId: string | null = null;
    try {
      pushLogId = (
        await pushLogStore.record({
          tenantId: args.tenantId,
          clientKey: suggestion?.clientKey ?? null,
          listingId: suggestion?.listingId ?? null,
          engineListingId: suggestion?.engineListingId ?? null,
          engine: args.engine,
          date: suggestion?.date ?? null,
          lever: "price",
          oldValue: pushedPrice,
          newValue: null,
          reason,
          result,
          detail: {
            kind: "revert",
            suggestionId: args.suggestionId,
            gate: reason,
            actor: args.actorEmail,
            ...extraDetail
          }
        })
      ).id;
    } catch (logError) {
      console.error(
        "[recs-revert] PushLog write failed (result preserved)",
        JSON.stringify({ suggestionId: args.suggestionId, reason, message: errorMessage(logError) })
      );
    }
    return { ok: false, result, reason, pushLogId };
  }

  // --- Gates ----------------------------------------------------------------
  if (!suggestion) return gate("skipped", "suggestion_not_found");
  if (suggestion.status !== "applied") {
    return gate("skipped", "not_applied", { status: suggestion.status });
  }
  if (typeof suggestion.pushRef !== "string" || suggestion.pushRef.trim().length === 0) {
    return gate("skipped", "no_push_ref");
  }
  if (pushAlreadyReverted(suggestion.detail)) {
    return gate("skipped", "already_reverted");
  }
  if (!isRecsPushEngine(args.engine)) {
    return gate("skipped", "engine_not_allowed");
  }
  if (suggestion.engineListingId === null || suggestion.engineListingId.trim().length === 0) {
    return gate("skipped", "missing_engine_listing_id");
  }

  const resolution = await adapterFactory({ engine: args.engine, tenantName: args.tenantName });
  if (!resolution.ok) {
    return gate("failed", resolution.reason, { message: resolution.message });
  }
  const adapter = resolution.adapter;

  const target: RecsPushTarget = {
    tenantId: args.tenantId,
    tenantName: args.tenantName,
    clientKey: suggestion.clientKey ?? "",
    suggestionId: suggestion.id,
    listingId: suggestion.listingId ?? "",
    engineListingId: suggestion.engineListingId,
    date: suggestion.date,
    // The price we previously pushed — the value being removed.
    price: pushedPrice ?? 0,
    currency: args.currency ?? "GBP",
    floor: detailFloor(suggestion.detail),
    floorUnknown: detailFloorUnknown(suggestion.detail),
    oldValue: suggestion.oldValue
  };

  // --- Revert + verify-gone, one PushLog row -------------------------------
  let result: "success" | "failed" = "failed";
  let reason: string | undefined;
  let verify: RecsVerifyResult = { attempted: false, verified: false };
  let engineError: string | undefined;
  let pushLogId: string | null = null;

  try {
    try {
      const write = await adapter.revert(target);
      if (!write.ok) {
        reason = "engine_error";
        engineError =
          write.errorMessage ??
          `engine revert failed${write.status !== undefined ? ` (HTTP ${write.status})` : ""}`;
      } else {
        try {
          verify = await adapter.verifyReverted(target);
        } catch (verifyThrow) {
          verify = { attempted: true, verified: false };
          reason = "verify_error";
          engineError = errorMessage(verifyThrow);
        }
        if (verify.verified) {
          result = "success";
          reason = undefined;
        } else if (reason === undefined) {
          reason = "revert_verify_mismatch";
        }
      }
    } catch (error) {
      reason = "engine_error";
      engineError = errorMessage(error);
    }
  } finally {
    try {
      pushLogId = (
        await pushLogStore.record({
          tenantId: args.tenantId,
          clientKey: suggestion.clientKey,
          listingId: suggestion.listingId,
          engineListingId: suggestion.engineListingId,
          engine: args.engine,
          date: suggestion.date,
          lever: "price",
          oldValue: pushedPrice,
          newValue: null,
          reason: `recs-revert by ${args.actorEmail}`,
          result,
          detail: {
            kind: "revert",
            suggestionId: suggestion.id,
            actor: args.actorEmail,
            verify,
            ...(reason !== undefined ? { reason } : {}),
            ...(engineError !== undefined ? { engineError } : {})
          }
        })
      ).id;
    } catch (logError) {
      console.error(
        "[recs-revert] PushLog write failed (result preserved)",
        JSON.stringify({ suggestionId: suggestion.id, result, message: errorMessage(logError) })
      );
    }
  }

  // Only a VERIFIED revert flags the suggestion; a failed revert leaves the
  // suggestion untouched (the engine may still be carrying our price).
  if (result === "success") {
    const existingPush =
      suggestion.detail !== null && typeof suggestion.detail.push === "object" && suggestion.detail.push !== null
        ? (suggestion.detail.push as Record<string, unknown>)
        : {};
    const mergedDetail: Record<string, unknown> = {
      ...(suggestion.detail ?? {}),
      push: {
        ...existingPush,
        reverted: { at: now().toISOString(), by: args.actorEmail, verified: true }
      }
    };
    try {
      await suggestionStore.update({
        tenantId: args.tenantId,
        suggestionId: suggestion.id,
        detail: mergedDetail
      });
    } catch (updateError) {
      console.error(
        "[recs-revert] suggestion update failed after verified revert",
        JSON.stringify({ suggestionId: suggestion.id, message: errorMessage(updateError) })
      );
    }
  }

  return {
    ok: result === "success",
    result,
    ...(reason !== undefined ? { reason } : {}),
    verify,
    pushLogId,
    ...(engineError !== undefined ? { engineError } : {})
  };
}

function pushAlreadyReverted(detail: Record<string, unknown> | null): boolean {
  const push = detail?.push;
  if (push === null || typeof push !== "object") return false;
  const reverted = (push as Record<string, unknown>).reverted;
  return reverted !== undefined && reverted !== null && reverted !== false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
