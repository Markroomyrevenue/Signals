import { NextResponse } from "next/server";

import { observeResponse } from "@/lib/observe/http";
import { buildReadout } from "@/lib/observe/readout";
import { prisma } from "@/lib/prisma";

/**
 * Read-only Observe & Learn day-30 readout, key-gated like
 * `/api/signals/monthly-summary`.
 *
 * Access control is a single secret query key: `?key=` must equal
 * `process.env.OBSERVE_READOUT_KEY`. When the env var is unset or the key does
 * not match we return 404 (not 401) so the route's existence is not advertised.
 * `OBSERVE_READOUT_KEY` must not be read anywhere else. The output NEVER contains
 * an engine key.
 *
 * `?tenant=<tenantId>` returns that client's full readout; without it, a list of
 * every client's window state. SELECT-only and tenant-scoped.
 *
 * `?format=text` returns the same payload as `text/plain` (see
 * `observeResponse`) so automated fetchers that render JSON to an empty page
 * can still read it.
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
  const format = searchParams.get("format");

  try {
    if (tenantId) {
      const clientKey = searchParams.get("clientKey") ?? undefined;
      const readout = await buildReadout({ tenantId, clientKey });
      return observeResponse(readout, format);
    }

    const windows = await prisma.observationWindow.findMany({
      select: {
        tenantId: true,
        clientKey: true,
        status: true,
        daysObserved: true,
        startedAt: true,
        graduatedAt: true,
        tenant: { select: { name: true } }
      },
      orderBy: [{ status: "asc" }, { daysObserved: "desc" }]
    });
    return observeResponse(
      {
        clients: windows.map((w) => ({
          tenantId: w.tenantId,
          clientKey: w.clientKey,
          client: w.tenant.name,
          status: w.status,
          daysObserved: w.daysObserved,
          startedAt: w.startedAt.toISOString(),
          graduatedAt: w.graduatedAt?.toISOString() ?? null
        }))
      },
      format
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to build readout" },
      { status: 500 }
    );
  }
}
