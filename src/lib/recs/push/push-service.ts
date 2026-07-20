/**
 * The recs push orchestrator — the single entry point through which an approved
 * suggestion becomes a live engine write. Highest safety bar in the codebase:
 *
 * 1. HARD GATES, each of which writes a PushLog row (result "skipped") and
 *    returns without touching the engine: status must be exactly "approved";
 *    pushRef must be empty (a suggestion pushes ONCE — re-push requires an
 *    explicit human status reset elsewhere); the price must be a finite
 *    number > 0; an engine-recommended price must not be below the
 *    generator's floor (operator-TYPED prices pass — detail.typedPrice,
 *    Mark 2026-07-20 — as do rows generated under allow-below-floor); the
 *    engine must be on the allowlist.
 * 2. Keys resolve per tenant via the env registry — a missing key is a
 *    "failed" PushLog row whose message masks the key state, never the value.
 * 3. adapter.preview (Wheelhouse owner-rate conflict lives here) — blocked →
 *    "skipped".
 * 4. adapter.execute → adapter.verify, then EXACTLY ONE PushLog row for the
 *    attempt (written in a finally-guaranteed path), then the suggestion
 *    update: status "applied" only when verified; pushRef always set after an
 *    attempted execute so a verify mismatch can never double-fire.
 *
 * No key material ever appears in any log, error, or detail — engine errors
 * are redacted at the HTTP layer before they reach this file.
 *
 * Mirrors the DI conventions of src/lib/hostaway/push-service.ts: typed dep
 * interfaces with DEFAULT_ Prisma-backed implementations at the bottom, so the
 * unit tests run as plain `node --test` with in-memory fakes.
 */

import { fromDateOnly, toDateOnly } from "@/lib/metrics/helpers";
import { lookupKeyForTenantName, type ResolveOptions } from "@/lib/observe/registry";
import { maskSecret } from "@/lib/observe/secrets";
import { prisma } from "@/lib/prisma";

import { createPriceLabsPushAdapter } from "./pricelabs";
import { createWheelhousePushAdapter } from "./wheelhouse";
import {
  isRecsPushEngine,
  type RecsEnginePushAdapter,
  type RecsPushEngine,
  type RecsPushOutcome,
  type RecsPushTarget,
  type RecsVerifyResult
} from "./types";

// ---------------------------------------------------------------------------
// Injectable dependency interfaces
// ---------------------------------------------------------------------------

/** The Suggestion fields the push path needs, with Decimals already numbers. */
export type RecsSuggestionRow = {
  id: string;
  tenantId: string;
  clientKey: string | null;
  listingId: string | null;
  engineListingId: string | null;
  /** YYYY-MM-DD (suggestions are single-night: dateFrom === dateTo). */
  date: string;
  status: string;
  oldValue: number | null;
  proposedValue: number | null;
  approvedPrice: number | null;
  pushRef: string | null;
  detail: Record<string, unknown> | null;
};

export type RecsSuggestionStore = {
  load(args: { tenantId: string; suggestionId: string }): Promise<RecsSuggestionRow | null>;
  update(args: {
    tenantId: string;
    suggestionId: string;
    status?: "applied";
    pushRef?: string;
    detail?: Record<string, unknown>;
  }): Promise<void>;
  /**
   * Atomically claim the push slot: set pushRef to the claim token ONLY where
   * status is still "approved" and pushRef is empty. Returns true when this
   * caller won. Serialises concurrent approvals so a suggestion can reach the
   * engine at most once (TOCTOU fix, push-safety review 2026-07-18).
   */
  claimForPush(args: { tenantId: string; suggestionId: string; claimRef: string }): Promise<boolean>;
};

export type RecsPushLogRecord = {
  tenantId: string;
  clientKey: string | null;
  listingId: string | null;
  engineListingId: string | null;
  engine: string;
  /** YYYY-MM-DD; PushLog dateFrom = dateTo = this. Null when unknown (bad load). */
  date: string | null;
  lever: "price";
  oldValue: number | null;
  newValue: number | null;
  reason: string;
  result: "success" | "failed" | "skipped";
  detail: Record<string, unknown>;
};

export type RecsPushLogStore = {
  record(row: RecsPushLogRecord): Promise<{ id: string }>;
};

export type RecsAdapterResolution =
  | { ok: true; adapter: RecsEnginePushAdapter }
  | { ok: false; reason: "key_missing"; message: string };

export type RecsAdapterFactory = (args: {
  engine: RecsPushEngine;
  tenantName: string;
}) => RecsAdapterResolution | Promise<RecsAdapterResolution>;

export type RecsPushDeps = {
  suggestionStore?: RecsSuggestionStore;
  pushLogStore?: RecsPushLogStore;
  adapterFactory?: RecsAdapterFactory;
  now?: () => Date;
};

export type ExecuteApprovedPushArgs = {
  tenantId: string;
  tenantName: string;
  suggestionId: string;
  /** Raw engine string from the caller; gate-checked against the allowlist. */
  engine: string;
  /** Who clicked approve — lands in PushLog.reason and detail.actor. */
  actorEmail: string;
  /** Wheelhouse custom_rates currency; defaults to GBP (the proven contract). */
  currency?: string;
};

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function executeApprovedPush(
  args: ExecuteApprovedPushArgs,
  deps: RecsPushDeps = {}
): Promise<RecsPushOutcome> {
  const suggestionStore = deps.suggestionStore ?? DEFAULT_SUGGESTION_STORE;
  const pushLogStore = deps.pushLogStore ?? DEFAULT_PUSH_LOG_STORE;
  const adapterFactory = deps.adapterFactory ?? DEFAULT_ADAPTER_FACTORY;
  const now = deps.now ?? (() => new Date());

  const suggestion = await suggestionStore.load({
    tenantId: args.tenantId,
    suggestionId: args.suggestionId
  });

  /** Write a gate/preflight PushLog row and build the matching outcome. */
  async function gate(
    result: "skipped" | "failed",
    reason: string,
    extraDetail: Record<string, unknown> = {}
  ): Promise<RecsPushOutcome> {
    const pushLogId = await safeRecord(pushLogStore, {
      tenantId: args.tenantId,
      clientKey: suggestion?.clientKey ?? null,
      listingId: suggestion?.listingId ?? null,
      engineListingId: suggestion?.engineListingId ?? null,
      engine: args.engine,
      date: suggestion?.date ?? null,
      lever: "price",
      oldValue: suggestion?.oldValue ?? null,
      newValue: priceToPush(suggestion),
      reason,
      result,
      detail: {
        kind: "push",
        suggestionId: args.suggestionId,
        gate: reason,
        actor: args.actorEmail,
        ...extraDetail
      }
    });
    return { ok: false, result, reason, pushLogId };
  }

  // --- Hard gates (never throw; each is an auditable skip) -----------------
  if (!suggestion) return gate("skipped", "suggestion_not_found");
  // pushRef gate FIRST: an applied (or approved-but-attempted) row skips as
  // "already_pushed" — the truthful audit reason — rather than "not_approved".
  if (typeof suggestion.pushRef === "string" && suggestion.pushRef.trim().length > 0) {
    return gate("skipped", "already_pushed", { pushRef: suggestion.pushRef });
  }
  if (suggestion.status !== "approved") {
    return gate("skipped", "not_approved", { status: suggestion.status });
  }
  const price = priceToPush(suggestion);
  if (price === null || !(price > 0)) {
    return gate("skipped", "invalid_price", { price });
  }
  const floor = detailFloor(suggestion.detail);
  const belowFloorAllowed = detailAllowBelowFloor(suggestion.detail);
  const typedPrice = detailTypedPrice(suggestion.detail);
  if (floor !== null && price < floor && !belowFloorAllowed && !typedPrice) {
    // Engine recommendations never push below the floor UNLESS the row was
    // generated under the client's allow-below-floor toggle (2026-07-19).
    // A price the operator TYPED is their call and passes regardless
    // (Mark, 2026-07-20) — approve stamps detail.typedPrice for those, and
    // the fat-finger bound (half the basis) was enforced at approve time.
    return gate("skipped", "below_floor", { price, floor });
  }
  if (!isRecsPushEngine(args.engine)) {
    return gate("skipped", "engine_not_allowed");
  }
  if (suggestion.engineListingId === null || suggestion.engineListingId.trim().length === 0) {
    return gate("skipped", "missing_engine_listing_id");
  }

  // --- Keys + adapter -------------------------------------------------------
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
    price,
    currency: args.currency ?? "GBP",
    floor,
    floorUnknown: detailFloorUnknown(suggestion.detail),
    oldValue: suggestion.oldValue
  };

  // --- Engine pre-flight ----------------------------------------------------
  try {
    const preview = await adapter.preview(target);
    if (!preview.ok) {
      return gate("skipped", preview.blockedReason ?? "preview_blocked");
    }
  } catch (error) {
    return gate("failed", "preview_error", { engineError: errorMessage(error) });
  }

  // --- Atomic push-slot claim (the serialisation point) ---------------------
  // Two concurrent approvals both pass the read-then-gate checks above; only
  // the caller that wins this conditional update may touch the engine. The
  // claim token is replaced by the real pushRef in the post-push update; if
  // the process dies in between, the row stays claimed — re-push blocked, the
  // safe direction.
  const claimRef = `claim:${now().toISOString()}:${Math.random().toString(36).slice(2, 10)}`;
  try {
    const won = await suggestionStore.claimForPush({
      tenantId: args.tenantId,
      suggestionId: suggestion.id,
      claimRef
    });
    if (!won) {
      return gate("skipped", "already_pushed", { race: true });
    }
  } catch (error) {
    return gate("failed", "claim_error", { message: errorMessage(error) });
  }

  // --- Execute + verify, one PushLog row, then the suggestion update -------
  let result: "success" | "failed" = "failed";
  let reason: string | undefined;
  let verify: RecsVerifyResult = { attempted: false, verified: false };
  let engineError: string | undefined;
  let pushLogId: string | null = null;

  try {
    try {
      const write = await adapter.execute(target);
      if (!write.ok) {
        reason = "engine_error";
        engineError =
          write.errorMessage ??
          `engine write failed${write.status !== undefined ? ` (HTTP ${write.status})` : ""}`;
      } else {
        try {
          verify = await adapter.verify(target);
        } catch (verifyThrow) {
          verify = { attempted: true, verified: false };
          reason = "verify_error";
          engineError = errorMessage(verifyThrow);
        }
        if (verify.verified) {
          result = "success";
          reason = undefined;
        } else if (reason === undefined) {
          reason = "verify_mismatch";
        }
      }
    } catch (error) {
      reason = "engine_error";
      engineError = errorMessage(error);
    }
  } finally {
    // EXACTLY ONE PushLog row per attempt — guaranteed even on an unexpected
    // throw above, and a PushLog write failure never masks the push result.
    pushLogId = await safeRecord(pushLogStore, {
      tenantId: args.tenantId,
      clientKey: suggestion.clientKey,
      listingId: suggestion.listingId,
      engineListingId: suggestion.engineListingId,
      engine: args.engine,
      date: suggestion.date,
      lever: "price",
      oldValue: suggestion.oldValue,
      newValue: price,
      reason: `recs-approve by ${args.actorEmail}`,
      result,
      detail: {
        kind: "push",
        suggestionId: suggestion.id,
        actor: args.actorEmail,
        verify,
        ...(reason !== undefined ? { reason } : {}),
        ...(engineError !== undefined ? { engineError } : {})
      }
    });
  }

  // pushRef is set after EVERY attempted execute — verified or not — so a
  // mismatch/failed attempt cannot double-fire; a human decides what's next.
  // If the PushLog write itself failed we still block re-push with a sentinel.
  const pushRef = pushLogId ?? `pushlog-write-failed:${now().toISOString()}`;
  const mergedDetail: Record<string, unknown> = {
    ...(suggestion.detail ?? {}),
    push: {
      pushedAt: now().toISOString(),
      verified: verify.verified,
      observedPrice: verify.observedPrice ?? null
    }
  };
  try {
    await suggestionStore.update({
      tenantId: args.tenantId,
      suggestionId: suggestion.id,
      ...(result === "success" ? { status: "applied" as const } : {}),
      pushRef,
      detail: mergedDetail
    });
  } catch (updateError) {
    // Never mask the push result with a bookkeeping failure — log loudly.
    console.error(
      "[recs-push] suggestion update failed after push",
      JSON.stringify({
        suggestionId: suggestion.id,
        tenantId: args.tenantId,
        result,
        pushLogId,
        message: errorMessage(updateError)
      })
    );
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

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** The price a push would write: the human-approved price, else the proposal. */
export function priceToPush(
  suggestion: Pick<RecsSuggestionRow, "approvedPrice" | "proposedValue"> | null
): number | null {
  if (!suggestion) return null;
  const candidate = suggestion.approvedPrice ?? suggestion.proposedValue;
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}

export function detailFloor(detail: Record<string, unknown> | null): number | null {
  const raw = detail?.floor;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

export function detailFloorUnknown(detail: Record<string, unknown> | null): boolean {
  return detail?.floorUnknown === true;
}

/** Row generated under the client's allow-below-floor toggle (2026-07-19). */
export function detailAllowBelowFloor(detail: Record<string, unknown> | null): boolean {
  return detail?.allowBelowFloor === true;
}

/** Approved price was typed by the operator (stamped at approve time, 2026-07-20). */
export function detailTypedPrice(detail: Record<string, unknown> | null): boolean {
  return detail?.typedPrice === true;
}

function errorMessage(error: unknown): string {
  // Engine/HTTP errors arrive pre-redacted (recsEngineFetch scrubs every auth
  // header value); this is only a safe stringify.
  return error instanceof Error ? error.message : String(error);
}

async function safeRecord(
  store: RecsPushLogStore,
  row: RecsPushLogRecord
): Promise<string | null> {
  try {
    return (await store.record(row)).id;
  } catch (logError) {
    console.error(
      "[recs-push] PushLog write failed (result preserved)",
      JSON.stringify({
        tenantId: row.tenantId,
        result: row.result,
        reason: row.reason,
        message: errorMessage(logError)
      })
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Default (Prisma / env-backed) dependency implementations
// ---------------------------------------------------------------------------

export const DEFAULT_SUGGESTION_STORE: RecsSuggestionStore = {
  async load({ tenantId, suggestionId }) {
    const row = await prisma.suggestion.findFirst({
      where: { id: suggestionId, tenantId }
    });
    if (!row) return null;
    return {
      id: row.id,
      tenantId: row.tenantId,
      clientKey: row.clientKey,
      listingId: row.listingId,
      engineListingId: row.engineListingId,
      date: toDateOnly(row.dateFrom),
      status: row.status,
      oldValue: row.oldValue === null ? null : Number(row.oldValue),
      proposedValue: row.proposedValue === null ? null : Number(row.proposedValue),
      approvedPrice: row.approvedPrice === null ? null : Number(row.approvedPrice),
      pushRef: row.pushRef,
      detail:
        row.detail !== null && typeof row.detail === "object" && !Array.isArray(row.detail)
          ? (row.detail as Record<string, unknown>)
          : null
    };
  },

  async update({ tenantId, suggestionId, status, pushRef, detail }) {
    await prisma.suggestion.updateMany({
      where: { id: suggestionId, tenantId },
      data: {
        ...(status !== undefined ? { status } : {}),
        ...(pushRef !== undefined ? { pushRef } : {}),
        ...(detail !== undefined ? { detail: JSON.parse(JSON.stringify(detail)) } : {})
      }
    });
  },

  async claimForPush({ tenantId, suggestionId, claimRef }) {
    const claimed = await prisma.suggestion.updateMany({
      where: { id: suggestionId, tenantId, status: "approved", pushRef: null },
      data: { pushRef: claimRef }
    });
    return claimed.count === 1;
  }
};

export const DEFAULT_PUSH_LOG_STORE: RecsPushLogStore = {
  async record(row) {
    const created = await prisma.pushLog.create({
      data: {
        tenantId: row.tenantId,
        clientKey: row.clientKey,
        listingId: row.listingId,
        engineListingId: row.engineListingId,
        engine: row.engine,
        dateFrom: row.date !== null ? fromDateOnly(row.date) : null,
        dateTo: row.date !== null ? fromDateOnly(row.date) : null,
        lever: row.lever,
        oldValue: row.oldValue,
        newValue: row.newValue,
        reason: row.reason,
        result: row.result,
        detail: JSON.parse(JSON.stringify(row.detail))
      }
    });
    return { id: created.id };
  }
};

/**
 * Build the env-backed adapter factory. Key resolution follows the observe
 * registry's longest-prefix slug rule: PriceLabs read+write = PRICELABS_KEY_*;
 * Wheelhouse = WHEELHOUSE_KEY_* (read) + WHEELHOUSE_WRITE_KEY_* (write), both
 * required. Messages carry masked key state only — never a key value.
 */
export function buildDefaultAdapterFactory(
  options: ResolveOptions & { sleepImpl?: (ms: number) => Promise<void> } = {}
): RecsAdapterFactory {
  return ({ engine, tenantName }) => {
    if (engine === "pricelabs") {
      const key = lookupKeyForTenantName("PRICELABS_KEY", tenantName, options);
      if (key.value === null) {
        return {
          ok: false,
          reason: "key_missing",
          message: `PriceLabs key missing for tenant "${tenantName}": ${key.envVar}=${maskSecret(key.value)}`
        };
      }
      return {
        ok: true,
        adapter: createPriceLabsPushAdapter({
          apiKey: key.value,
          fetchImpl: options.fetchImpl,
          sleepImpl: options.sleepImpl
        })
      };
    }
    const readKey = lookupKeyForTenantName("WHEELHOUSE_KEY", tenantName, options);
    const writeKey = lookupKeyForTenantName("WHEELHOUSE_WRITE_KEY", tenantName, options);
    if (readKey.value === null || writeKey.value === null) {
      return {
        ok: false,
        reason: "key_missing",
        message:
          `Wheelhouse keys incomplete for tenant "${tenantName}": ` +
          `${readKey.envVar}=${maskSecret(readKey.value)}, ` +
          `${writeKey.envVar}=${maskSecret(writeKey.value)} (writes need BOTH)`
      };
    }
    return {
      ok: true,
      adapter: createWheelhousePushAdapter({
        readKey: readKey.value,
        writeKey: writeKey.value,
        fetchImpl: options.fetchImpl,
        sleepImpl: options.sleepImpl
      })
    };
  };
}

export const DEFAULT_ADAPTER_FACTORY: RecsAdapterFactory = buildDefaultAdapterFactory();
