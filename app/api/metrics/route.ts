import { NextResponse } from "next/server";
import { z } from "zod";

import { getAuthContext } from "@/lib/auth";
import { listMetricDefinitions } from "@/lib/metrics/registry";
import { queryMetrics } from "@/lib/metrics/service";
import { metricsRequestSchema } from "@/lib/metrics/schemas";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const definitions = listMetricDefinitions().map((definition) => ({
    id: definition.id,
    name: definition.name,
    description: definition.description,
    domain: definition.domain,
    grains: definition.grains,
    formatter: definition.formatter,
    chartKind: definition.chartKind
  }));

  return NextResponse.json({ definitions });
}

export async function POST(request: Request) {
  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const parsed = metricsRequestSchema.parse(await request.json());
    const tenant = await prisma.tenant.findUnique({
      where: { id: auth.tenantId },
      select: { defaultCurrency: true }
    });

    const displayCurrency = (parsed.displayCurrency ?? tenant?.defaultCurrency ?? "GBP").toUpperCase();
    const result = await queryMetrics({
      tenantId: auth.tenantId,
      metricIds: parsed.metricIds,
      filters: parsed.filters,
      displayCurrency
    });

    return NextResponse.json({
      ...result,
      displayCurrency
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.flatten() }, { status: 400 });
    }

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to query metrics"
      },
      { status: 500 }
    );
  }
}
