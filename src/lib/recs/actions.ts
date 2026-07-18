/**
 * Human actions on recs-page suggestions (2026-07-18): approve (→ push),
 * edit-then-approve, reject, revert. The ONLY code path that triggers an
 * external engine write is an explicit approval by an internal admin arriving
 * through /api/recs — there are no scheduled or automatic pushes anywhere.
 *
 * Decision flow per suggestion (all tenant-scoped):
 *   pending ── reject ──→ rejected (actionedAt/By; decision memory holds it 3d)
 *   pending ── approve ─→ approved (approvedPrice = edited ?? proposed)
 *                          ├─ hold at current price → no push, decision recorded
 *                          └─ price change → executeApprovedPush → applied
 *                             (verify-mismatch leaves it approved + pushRef set;
 *                              a human decides the next move on-page)
 *   applied ── revert ──→ engine write removed; row stays applied with
 *                          detail.push.reverted (append-only truth)
 */

import { resolveObserveSource } from "@/lib/observe/registry";
import { prisma } from "@/lib/prisma";

import { explainNight } from "./oversight/explain";
import { executeApprovedPush } from "./push/push-service";
import { revertPushedNight } from "./push/revert-service";

export type ActionResult = {
  ok: boolean;
  status: string;
  error?: string | null;
  push?: { result: string; verified: boolean | null; reason?: string | null } | null;
};

function detailOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

async function loadActionable(tenantId: string, suggestionId: string) {
  return prisma.suggestion.findFirst({
    where: { id: suggestionId, tenantId },
    select: {
      id: true,
      tenantId: true,
      status: true,
      type: true,
      oldValue: true,
      proposedValue: true,
      approvedPrice: true,
      pushRef: true,
      detail: true
    }
  });
}

async function tenantMeta(tenantId: string): Promise<{ name: string; engine: string; currency: string } | null> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true, defaultCurrency: true }
  });
  if (!tenant) return null;
  const source = resolveObserveSource({ id: tenant.id, name: tenant.name });
  return { name: tenant.name, engine: source.kind, currency: tenant.defaultCurrency };
}

export async function approveSuggestion(args: {
  tenantId: string;
  suggestionId: string;
  actorEmail: string;
  editedPrice?: number | null;
}): Promise<ActionResult> {
  const suggestion = await loadActionable(args.tenantId, args.suggestionId);
  if (!suggestion) return { ok: false, status: "unknown", error: "suggestion not found" };
  if (suggestion.status !== "pending") {
    return { ok: false, status: suggestion.status, error: `cannot approve a ${suggestion.status} suggestion` };
  }

  const detail = detailOf(suggestion.detail);
  const oldValue = suggestion.oldValue === null ? null : Number(suggestion.oldValue);
  const proposed = suggestion.proposedValue === null ? null : Number(suggestion.proposedValue);
  const floor = typeof detail.floor === "number" ? (detail.floor as number) : null;

  let price = proposed;
  if (args.editedPrice !== undefined && args.editedPrice !== null) {
    if (!Number.isFinite(args.editedPrice) || args.editedPrice <= 0) {
      return { ok: false, status: suggestion.status, error: "edited price must be a positive number" };
    }
    if (floor !== null && args.editedPrice < floor) {
      return { ok: false, status: suggestion.status, error: `edited price £${args.editedPrice} is below the floor £${floor}` };
    }
    price = args.editedPrice;
  }
  if (price === null || !Number.isFinite(price)) {
    return { ok: false, status: suggestion.status, error: "suggestion has no proposable price" };
  }

  await prisma.suggestion.updateMany({
    where: { id: suggestion.id, tenantId: args.tenantId, status: "pending" },
    data: { status: "approved", actionedAt: new Date(), actionedByEmail: args.actorEmail, approvedPrice: price }
  });

  // A hold approved at the current price is a recorded decision, not a push.
  const isNoOp = oldValue !== null && Math.abs(price - oldValue) < 0.005;
  if (isNoOp) return { ok: true, status: "approved", push: null };

  const meta = await tenantMeta(args.tenantId);
  if (!meta) return { ok: false, status: "approved", error: "tenant not found" };
  if (meta.engine !== "pricelabs" && meta.engine !== "wheelhouse") {
    return { ok: true, status: "approved", push: { result: "skipped", verified: null, reason: "no_push_engine" } };
  }

  const outcome = await executeApprovedPush({
    tenantId: args.tenantId,
    tenantName: meta.name,
    suggestionId: suggestion.id,
    engine: meta.engine,
    actorEmail: args.actorEmail,
    currency: meta.currency
  });
  const after = await prisma.suggestion.findFirst({
    where: { id: suggestion.id, tenantId: args.tenantId },
    select: { status: true }
  });
  return {
    ok: outcome.ok,
    status: after?.status ?? "approved",
    error: outcome.ok ? null : (outcome.engineError ?? outcome.reason ?? "push failed"),
    push: { result: outcome.result, verified: outcome.verify?.verified ?? null, reason: outcome.reason ?? null }
  };
}

export async function rejectSuggestion(args: {
  tenantId: string;
  suggestionId: string;
  actorEmail: string;
}): Promise<ActionResult> {
  const suggestion = await loadActionable(args.tenantId, args.suggestionId);
  if (!suggestion) return { ok: false, status: "unknown", error: "suggestion not found" };
  if (suggestion.status !== "pending") {
    return { ok: false, status: suggestion.status, error: `cannot reject a ${suggestion.status} suggestion` };
  }
  await prisma.suggestion.updateMany({
    where: { id: suggestion.id, tenantId: args.tenantId, status: "pending" },
    data: { status: "rejected", actionedAt: new Date(), actionedByEmail: args.actorEmail }
  });
  return { ok: true, status: "rejected" };
}

export async function revertSuggestionPush(args: {
  tenantId: string;
  suggestionId: string;
  actorEmail: string;
}): Promise<ActionResult> {
  const meta = await tenantMeta(args.tenantId);
  if (!meta) return { ok: false, status: "unknown", error: "tenant not found" };
  const outcome = await revertPushedNight({
    tenantId: args.tenantId,
    tenantName: meta.name,
    suggestionId: args.suggestionId,
    engine: meta.engine,
    actorEmail: args.actorEmail,
    currency: meta.currency
  });
  const after = await prisma.suggestion.findFirst({
    where: { id: args.suggestionId, tenantId: args.tenantId },
    select: { status: true }
  });
  return {
    ok: outcome.ok,
    status: after?.status ?? "unknown",
    error: outcome.ok ? null : (outcome.engineError ?? outcome.reason ?? "revert failed"),
    push: { result: outcome.result, verified: outcome.verify?.verified ?? null, reason: outcome.reason ?? null }
  };
}

export async function explainSuggestion(args: {
  tenantId: string;
  suggestionId: string;
}): Promise<{ ok: boolean; narrative?: string | null; error?: string | null }> {
  const result = await explainNight({ tenantId: args.tenantId, suggestionId: args.suggestionId });
  if (result.status === "ok") return { ok: true, narrative: result.narrative ?? null };
  return { ok: false, error: result.status === "disabled" ? "oversight unavailable" : (result.error ?? "explain failed") };
}
