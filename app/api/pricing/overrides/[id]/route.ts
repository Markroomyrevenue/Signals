import { NextResponse } from "next/server";
import { z } from "zod";

import { getAuthContext } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  editOverrideWithSupersede,
  OVERRIDE_TYPE_VALUES,
  PERCENTAGE_OVERRIDE_MAX,
  PERCENTAGE_OVERRIDE_MIN,
  softDeleteOverride
} from "@/lib/pricing/manual-override";

const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

const editSchema = z
  .object({
    startDate: dateOnlySchema.optional(),
    endDate: dateOnlySchema.optional(),
    overrideType: z.enum(OVERRIDE_TYPE_VALUES).optional(),
    overrideValue: z.number().finite().optional(),
    notes: z.string().max(2_000).optional().nullable()
  })
  .refine(
    (data) => data.startDate === undefined || data.endDate === undefined || data.startDate <= data.endDate,
    { message: "startDate must be on or before endDate", path: ["endDate"] }
  )
  .refine(
    (data) => {
      if (data.overrideType !== "percentage_delta") return true;
      if (data.overrideValue === undefined) return true;
      return data.overrideValue >= PERCENTAGE_OVERRIDE_MIN && data.overrideValue <= PERCENTAGE_OVERRIDE_MAX;
    },
    {
      message: `Percentage delta must be between ${PERCENTAGE_OVERRIDE_MIN} and ${PERCENTAGE_OVERRIDE_MAX}`,
      path: ["overrideValue"]
    }
  );

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await context.params;
  if (!id) return NextResponse.json({ error: "Override id required" }, { status: 400 });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const parse = editSchema.safeParse(raw);
  if (!parse.success) {
    return NextResponse.json(
      { error: "Invalid request", issues: parse.error.issues },
      { status: 400 }
    );
  }
  const data = parse.data;

  try {
    const result = await editOverrideWithSupersede({
      tenantId: auth.tenantId,
      id,
      startDate: data.startDate,
      endDate: data.endDate,
      overrideType: data.overrideType,
      overrideValue: data.overrideValue,
      notes: data.notes,
      editedBy: auth.userId,
      prisma
    });
    if (!result) return NextResponse.json({ error: "Override not found" }, { status: 404 });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to edit override";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await context.params;
  if (!id) return NextResponse.json({ error: "Override id required" }, { status: 400 });

  const removed = await softDeleteOverride({
    tenantId: auth.tenantId,
    id,
    removedBy: auth.userId,
    prisma
  });
  if (!removed) return NextResponse.json({ error: "Override not found" }, { status: 404 });
  return NextResponse.json({ removed });
}
