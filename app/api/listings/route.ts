import { NextResponse } from "next/server";

import { getAuthContext } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();

  const listings = await prisma.listing.findMany({
    where: {
      tenantId: auth.tenantId,
      ...(q
        ? {
            OR: [
              {
                name: {
                  contains: q,
                  mode: "insensitive"
                }
              },
              {
                hostawayId: {
                  contains: q,
                  mode: "insensitive"
                }
              }
            ]
          }
        : {})
    },
    orderBy: {
      name: "asc"
    },
    select: {
      id: true,
      hostawayId: true,
      name: true,
      status: true,
      timezone: true,
      tags: true
    },
    take: 5000
  });

  return NextResponse.json({
    listings
  });
}
