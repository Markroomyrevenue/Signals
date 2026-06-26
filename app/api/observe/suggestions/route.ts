import { NextResponse } from "next/server";

import { readSuggestions } from "@/lib/observe/suggestions";

/**
 * Read-only Observe & Learn suggestions, key-gated like
 * `/api/signals/monthly-summary`. `?key=` must equal
 * `process.env.OBSERVE_READOUT_KEY` (the same gate as the readout route); 404 on
 * any mismatch so the route is not advertised. Rows are ordered by revenue at
 * risk, all `pending` unless `?status=` overrides. SELECT-only, tenant-scoped,
 * and never contains an engine key.
 *
 * Required: `?tenant=<tenantId>`. Optional: `?status=`, `?limit=`.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const expectedKey = process.env.OBSERVE_READOUT_KEY;
  const { searchParams } = new URL(request.url);
  const providedKey = searchParams.get("key");

  if (!expectedKey || providedKey !== expectedKey) {
    return new NextResponse("Not found", { status: 404 });
  }

  const tenantId = searchParams.get("tenant");
  if (!tenantId) {
    return NextResponse.json({ error: "tenant query param required" }, { status: 400 });
  }

  const status = searchParams.get("status") ?? "pending";
  const limitRaw = Number.parseInt(searchParams.get("limit") ?? "100", 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 100;

  try {
    const clientKey = searchParams.get("clientKey") ?? undefined;
    const suggestions = await readSuggestions({ tenantId, clientKey, status, limit });
    return NextResponse.json({ tenantId, status, count: suggestions.length, suggestions });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to read suggestions" },
      { status: 500 }
    );
  }
}
