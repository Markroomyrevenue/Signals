import { NextResponse } from "next/server";
import { z } from "zod";

import { getAuthContext } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildPropertyDeepDiveReport } from "@/lib/reports/service";
import { propertyDeepDiveRequestSchema } from "@/lib/reports/schemas";

export async function POST(request: Request) {
  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const parsed = propertyDeepDiveRequestSchema.parse(await request.json());
    const tenant = await prisma.tenant.findUnique({
      where: { id: auth.tenantId },
      select: { defaultCurrency: true }
    });

    const displayCurrency = (parsed.displayCurrency ?? tenant?.defaultCurrency ?? "GBP").toUpperCase();
    const report = await buildPropertyDeepDiveReport({
      tenantId: auth.tenantId,
      request: parsed,
      displayCurrency
    });

    return NextResponse.json(report);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.flatten() }, { status: 400 });
    }

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to build property deep dive report"
      },
      { status: 500 }
    );
  }
}
