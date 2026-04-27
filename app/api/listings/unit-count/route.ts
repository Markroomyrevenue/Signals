import { NextResponse } from "next/server";
import { z } from "zod";

import { getAuthContext } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const updateUnitCountSchema = z.object({
  listingId: z.string().min(1),
  // null = single-unit listing (matches the schema convention).
  // 0 / 1 are coerced to null so the backend never has to deal with the
  // ambiguous "is 1 unit a multi-unit listing?" case.
  unitCount: z.number().int().min(0).max(500).nullable()
});

export const dynamic = "force-dynamic";

/**
 * PATCH /api/listings/unit-count
 *
 * Body: { listingId, unitCount }
 *
 * Sets the listing's `unit_count` column. Caller MUST be authenticated;
 * the listing MUST belong to the caller's tenant — we filter by
 * `tenantId` on every operation so a user from tenant A can never edit a
 * listing in tenant B.
 *
 * Returns 200 with the saved value. Returns 404 if the listing isn't
 * found inside the caller's tenant.
 */
export async function PATCH(request: Request) {
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Multi-unit toggle changes the pricing path for an entire listing, which
  // can swing live recommendations significantly. Restrict to admins so a
  // viewer-role user can never silently flip a listing into multi-unit mode.
  if (auth.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let payload: z.infer<typeof updateUnitCountSchema>;
  try {
    payload = updateUnitCountSchema.parse(await request.json());
  } catch (error) {
    return NextResponse.json({ error: "Invalid payload", detail: String(error) }, { status: 400 });
  }

  // Owner spec (2026-04-25): a "multi-unit listing" needs >= 2 units. We
  // coerce 0 and 1 down to null so the calendar branches consistently on
  // the same null/>=2 contract everywhere downstream.
  const persistedValue =
    payload.unitCount === null || payload.unitCount === 0 || payload.unitCount === 1 ? null : payload.unitCount;

  const result = await prisma.listing.updateMany({
    where: {
      tenantId: auth.tenantId,
      id: payload.listingId
    },
    data: {
      unitCount: persistedValue
    }
  });

  if (result.count === 0) {
    return NextResponse.json({ error: "Listing not found" }, { status: 404 });
  }

  return NextResponse.json({
    listingId: payload.listingId,
    unitCount: persistedValue
  });
}
