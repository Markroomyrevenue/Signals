import { NextResponse } from "next/server";
import { z } from "zod";

import { getAuthContext } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildReservationsReport } from "@/lib/reports/service";
import { reservationsReportRequestSchema } from "@/lib/reports/schemas";

export async function POST(request: Request) {
  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const parsed = reservationsReportRequestSchema.parse(await request.json());
    const tenant = await prisma.tenant.findUnique({
      where: { id: auth.tenantId },
      select: { defaultCurrency: true }
    });

    const displayCurrency = (parsed.displayCurrency ?? tenant?.defaultCurrency ?? "GBP").toUpperCase();
    const report = await buildReservationsReport({
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
        error: error instanceof Error ? error.message : "Failed to build reservations report"
      },
      { status: 500 }
    );
  }
}
