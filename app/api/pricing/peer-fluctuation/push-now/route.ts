import { NextResponse } from "next/server";
import { z } from "zod";

import { getAuthContext } from "@/lib/auth";
import {
  pushPeerFluctuationForListing,
  pushPeerFluctuationForTenant
} from "@/lib/pricing/peer-fluctuation-push-service";

const singleSchema = z.object({
  listingId: z.string().min(1),
  all: z.literal(false).optional(),
  tenantId: z.string().optional()
});
const allSchema = z.object({
  all: z.literal(true),
  tenantId: z.string().optional()
});
const bodySchema = z.union([singleSchema, allSchema]);

/**
 * POST /api/pricing/peer-fluctuation/push-now
 *
 * Body:
 *   { listingId } — push a single listing now.
 *   { all: true } — push every fully-configured peer-fluctuation listing in
 *     the authenticated tenant.
 *
 * Response:
 *   { pushed, skipped, failed, results, errors }
 *
 * The endpoint runs the same compute-and-push as the scheduled job, but
 * with `triggerSource = 'manual'` so the audit log distinguishes the two.
 */
export async function POST(request: Request) {
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const parse = bodySchema.safeParse(raw);
  if (!parse.success) {
    return NextResponse.json(
      { error: "Invalid request", issues: parse.error.issues },
      { status: 400 }
    );
  }
  const data = parse.data;

  // The optional `tenantId` field on the body is IGNORED; we always use the
  // authenticated tenant. This is defensive — the schema accepts it for
  // forward-compat but cross-tenant pushes are never permitted.
  const tenantId = auth.tenantId;

  if ("listingId" in data && data.listingId) {
    const result = await pushPeerFluctuationForListing({
      tenantId,
      listingId: data.listingId,
      triggeredBy: auth.userId,
      triggerSource: "manual"
    });
    return NextResponse.json({
      pushed: result.status === "pushed" ? 1 : 0,
      skipped: result.status === "skipped" ? 1 : 0,
      failed: result.status === "failed" ? 1 : 0,
      results: [result],
      errors: result.errorMessage ? [result.errorMessage] : []
    });
  }

  const summary = await pushPeerFluctuationForTenant({
    tenantId,
    triggeredBy: auth.userId,
    triggerSource: "manual"
  });
  return NextResponse.json(summary);
}
