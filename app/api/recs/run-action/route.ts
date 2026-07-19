import { NextResponse } from "next/server";

import { approveSuggestion, rejectSuggestion, type ActionResult } from "@/lib/recs/actions";
import { getInternalRecsAuth } from "@/lib/recs/auth";
import { distributeRunTotal } from "@/lib/recs/runs";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const MAX_RUN_NIGHTS = 31;

/**
 * POST /api/recs/run-action — act on a RUN of nights in one decision.
 * Body: { tenantId, suggestionIds: string[], action: "approve" | "reject",
 *         editedTotal?: number }.
 *
 * The run is presentation; execution stays per night: approve loops
 * `approveSuggestion` SEQUENTIALLY (engine rate limits; every floor /
 * idempotency / PushLog guarantee per night), reject loops `rejectSuggestion`
 * (each night lands in decision memory). An edited TOTAL is distributed
 * proportionally across the nights server-side (floors clamp unless the row
 * carries allow-below-floor), and each night is approved at its share.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const auth = await getInternalRecsAuth();
  if (!auth) return new NextResponse("Not found", { status: 404 });

  let body: { tenantId?: unknown; suggestionIds?: unknown; action?: unknown; editedTotal?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const tenantId = typeof body.tenantId === "string" ? body.tenantId : "";
  const action = body.action === "approve" || body.action === "reject" ? body.action : null;
  const ids = Array.isArray(body.suggestionIds)
    ? body.suggestionIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  if (!tenantId || !action || ids.length === 0) {
    return NextResponse.json({ error: "tenantId, action and suggestionIds are required" }, { status: 400 });
  }
  if (ids.length > MAX_RUN_NIGHTS) {
    return NextResponse.json({ error: `A run can carry at most ${MAX_RUN_NIGHTS} nights` }, { status: 400 });
  }
  const editedTotal =
    body.editedTotal === undefined || body.editedTotal === null
      ? null
      : typeof body.editedTotal === "number" && Number.isFinite(body.editedTotal) && body.editedTotal > 0
        ? body.editedTotal
        : NaN;
  if (Number.isNaN(editedTotal)) {
    return NextResponse.json({ error: "editedTotal must be a positive number" }, { status: 400 });
  }
  if (editedTotal !== null && action !== "approve") {
    return NextResponse.json({ error: "editedTotal only applies to approve" }, { status: 400 });
  }

  // Load the member rows tenant-scoped; every id must resolve to a pending row.
  const rows = await prisma.suggestion.findMany({
    where: { id: { in: ids }, tenantId, status: "pending" },
    select: { id: true, proposedValue: true, detail: true }
  });
  if (rows.length !== ids.length) {
    return NextResponse.json(
      { error: "One or more nights are no longer pending — reload and review the run again" },
      { status: 409 }
    );
  }

  // Distribution for an edited total (per-night floors honoured).
  let editedPriceById: Map<string, number> | null = null;
  let distributionNotes: string[] = [];
  if (editedTotal !== null) {
    const nights = rows.map((row) => {
      const detail =
        row.detail && typeof row.detail === "object" && !Array.isArray(row.detail)
          ? (row.detail as { floor?: unknown; allowBelowFloor?: unknown })
          : {};
      return {
        suggestionId: row.id,
        proposed: row.proposedValue === null ? 0 : Number(row.proposedValue),
        floor: typeof detail.floor === "number" ? detail.floor : null,
        allowBelowFloor: detail.allowBelowFloor === true
      };
    });
    const distribution = distributeRunTotal(nights, editedTotal);
    if (distribution.prices.size !== rows.length) {
      return NextResponse.json({ error: "Could not distribute the edited total" }, { status: 400 });
    }
    editedPriceById = distribution.prices;
    distributionNotes = distribution.notes;
  }

  const results: Array<{ suggestionId: string } & ActionResult> = [];
  for (const id of ids) {
    const result =
      action === "approve"
        ? await approveSuggestion({
            tenantId,
            suggestionId: id,
            actorEmail: auth.email,
            ...(editedPriceById ? { editedPrice: editedPriceById.get(id) } : {})
          })
        : await rejectSuggestion({ tenantId, suggestionId: id, actorEmail: auth.email });
    results.push({ suggestionId: id, ...result });
  }

  const okCount = results.filter((r) => r.ok).length;
  return NextResponse.json({
    ok: okCount === results.length,
    okCount,
    total: results.length,
    distributionNotes,
    results
  });
}
