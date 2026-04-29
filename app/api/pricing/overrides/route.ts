import { NextResponse } from "next/server";
import { z } from "zod";

import { getAuthContext } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  createOverrideWithSupersede,
  findActiveOverridesInRange,
  OVERRIDE_TYPE_VALUES,
  PERCENTAGE_OVERRIDE_MAX,
  PERCENTAGE_OVERRIDE_MIN
} from "@/lib/pricing/manual-override";

const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

const createSchema = z
  .object({
    listingId: z.string().min(1),
    startDate: dateOnlySchema,
    endDate: dateOnlySchema,
    overrideType: z.enum(OVERRIDE_TYPE_VALUES),
    overrideValue: z.number().finite(),
    notes: z.string().max(2_000).optional().nullable()
  })
  .refine((data) => data.startDate <= data.endDate, {
    message: "startDate must be on or before endDate",
    path: ["endDate"]
  })
  .refine(
    (data) => {
      if (data.overrideType !== "percentage_delta") return true;
      return data.overrideValue >= PERCENTAGE_OVERRIDE_MIN && data.overrideValue <= PERCENTAGE_OVERRIDE_MAX;
    },
    { message: `Percentage delta must be between ${PERCENTAGE_OVERRIDE_MIN} and ${PERCENTAGE_OVERRIDE_MAX}`, path: ["overrideValue"] }
  )
  .refine((data) => data.overrideType !== "fixed" || data.overrideValue > 0, {
    message: "Fixed-price override must be > 0",
    path: ["overrideValue"]
  });

/**
 * GET /api/pricing/overrides?listingId=...&from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Returns active (non-soft-deleted) overrides for the listing in the
 * window. Tenant-scoped + admin-only.
 */
export async function GET(request: Request) {
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const listingId = searchParams.get("listingId");
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  if (!listingId || !from || !to) {
    return NextResponse.json(
      { error: "listingId, from and to are required (YYYY-MM-DD)" },
      { status: 400 }
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return NextResponse.json({ error: "from and to must be YYYY-MM-DD" }, { status: 400 });
  }

  // Defence-in-depth: verify the listing belongs to the tenant.
  const listing = await prisma.listing.findFirst({
    where: { id: listingId, tenantId: auth.tenantId },
    select: { id: true }
  });
  if (!listing) return NextResponse.json({ error: "Listing not found" }, { status: 404 });

  const overrides = await findActiveOverridesInRange({
    tenantId: auth.tenantId,
    listingId,
    fromDate: from,
    toDate: to,
    prisma
  });

  return NextResponse.json({ overrides });
}

/**
 * POST /api/pricing/overrides
 *
 * Body: { listingId, startDate, endDate, overrideType, overrideValue, notes? }
 *
 * Auto-supersedes any overlapping active overrides per spec B.5; the
 * superseded summary is returned alongside the new override so the UI can
 * surface "this replaced 2 existing overrides on overlapping dates: …".
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

  const parse = createSchema.safeParse(raw);
  if (!parse.success) {
    return NextResponse.json(
      { error: "Invalid request", issues: parse.error.issues },
      { status: 400 }
    );
  }
  const data = parse.data;

  const listing = await prisma.listing.findFirst({
    where: { id: data.listingId, tenantId: auth.tenantId },
    select: { id: true }
  });
  if (!listing) return NextResponse.json({ error: "Listing not found" }, { status: 404 });

  try {
    const result = await createOverrideWithSupersede({
      tenantId: auth.tenantId,
      listingId: data.listingId,
      startDate: data.startDate,
      endDate: data.endDate,
      overrideType: data.overrideType,
      overrideValue: data.overrideValue,
      notes: data.notes ?? null,
      createdBy: auth.userId,
      prisma
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create override";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
