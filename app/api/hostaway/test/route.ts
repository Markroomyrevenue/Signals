import { NextResponse } from "next/server";

import { getAuthContext } from "@/lib/auth";
import { env } from "@/lib/env";
import { getHostawayGatewayForTenant } from "@/lib/hostaway";

function normalizedMode(): string {
  return env.dataMode;
}

export async function GET() {
  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dataMode = normalizedMode();
  if (dataMode !== "live") {
    return NextResponse.json({ error: "Live mode is not enabled" }, { status: 400 });
  }

  try {
    const gateway = await getHostawayGatewayForTenant(auth.tenantId);
    const response = await gateway.fetchListings(1);

    return NextResponse.json({
      success: true,
      mode: dataMode,
      items: response.items.length,
      hasMore: response.hasMore
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Hostaway test failed" }, { status: 500 });
  }
}
