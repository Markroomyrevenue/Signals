import { NextResponse } from "next/server";
import { z } from "zod";

import { getAuthContext } from "@/lib/auth";
import {
  createBulkOverrides,
  findActiveOverridesForListings,
  OVERRIDE_TYPE_VALUES,
  PERCENTAGE_OVERRIDE_MAX,
  PERCENTAGE_OVERRIDE_MIN
} from "@/lib/pricing/manual-override";
import { prisma } from "@/lib/prisma";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD");

const postSchema = z
  .object({
    listingIds: z.array(z.string().min(1)).min(1, "Pick at least one listing"),
    startDate: dateSchema,
    endDate: dateSchema,
    overrideType: z.enum(OVERRIDE_TYPE_VALUES),
    overrideValue: z.number().refine((v) => Number.isFinite(v), "Must be finite"),
    minStay: z.number().int().min(1).max(30).nullable().optional(),
    notes: z.string().max(500).nullable().optional()
  })
  .refine((v) => v.startDate <= v.endDate, {
    message: "startDate must be on or before endDate",
    path: ["endDate"]
  })
  .refine(
    (v) =>
      v.overrideType === "fixed"
        ? v.overrideValue > 0
        : v.overrideValue >= PERCENTAGE_OVERRIDE_MIN && v.overrideValue <= PERCENTAGE_OVERRIDE_MAX,
    { message: "overrideValue out of range for the chosen overrideType", path: ["overrideValue"] }
  );

/**
 * POST /api/pricing/overrides
 *
 * Body: { listingIds, startDate, endDate, overrideType, overrideValue, minStay?, notes? }
 * Creates one override per listing (auto-superseding any overlapping
 * existing overrides per-listing). Admin-only, tenant-scoped.
 *
 * Returns: array of per-listing results (created + supersede summary OR error).
 */
export async function POST(request: Request): Promise<NextResponse> {
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let parsed: z.infer<typeof postSchema>;
  try {
    parsed = postSchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.flatten() }, { status: 400 });
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  // Validate that every listingId belongs to the caller's tenant. If any
  // doesn't, refuse the entire request — fail-loud is safer than silent
  // partial creation.
  const listings = await prisma.listing.findMany({
    where: { id: { in: parsed.listingIds }, tenantId: auth.tenantId },
    select: { id: true }
  });
  const validIds = new Set(listings.map((l) => l.id));
  const invalid = parsed.listingIds.filter((id) => !validIds.has(id));
  if (invalid.length > 0) {
    return NextResponse.json(
      { error: `Listings not found in this tenant: ${invalid.join(", ")}` },
      { status: 400 }
    );
  }

  const results = await createBulkOverrides({
    tenantId: auth.tenantId,
    listingIds: parsed.listingIds,
    startDate: parsed.startDate,
    endDate: parsed.endDate,
    overrideType: parsed.overrideType,
    overrideValue: parsed.overrideValue,
    minStay: parsed.minStay ?? null,
    notes: parsed.notes ?? null,
    createdBy: auth.userId,
    prisma
  });

  return NextResponse.json({ results });
}

/**
 * GET /api/pricing/overrides?listingIds=a,b,c&from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Returns active overrides for the given listings in the date window.
 * Used by the bulk-override modal to show "currently overridden" hints.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(request.url);
  const listingIdsParam = url.searchParams.get("listingIds");
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");
  if (!listingIdsParam || !fromParam || !toParam) {
    return NextResponse.json({ error: "listingIds, from, to are required" }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromParam) || !/^\d{4}-\d{2}-\d{2}$/.test(toParam)) {
    return NextResponse.json({ error: "Date format must be YYYY-MM-DD" }, { status: 400 });
  }

  const listingIds = listingIdsParam.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  const overrides = await findActiveOverridesForListings({
    tenantId: auth.tenantId,
    listingIds,
    fromDate: fromParam,
    toDate: toParam,
    prisma
  });
  return NextResponse.json({ overrides });
}
