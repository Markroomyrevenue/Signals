import { NextResponse } from "next/server";
import { z } from "zod";

import { getAuthContext } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const CUSTOM_GROUP_TAG_PREFIX = "group:";

const listingGroupMutationSchema = z.object({
  action: z.enum(["assign", "remove", "delete"]),
  name: z.string().trim().min(1).max(60),
  listingIds: z.array(z.string()).default([])
});

function normalizeGroupName(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function groupTagKey(value: string): string {
  return normalizeGroupName(value).toLowerCase();
}

function isCustomGroupTag(tag: string): boolean {
  return tag.trim().toLowerCase().startsWith(CUSTOM_GROUP_TAG_PREFIX);
}

function toGroupTag(name: string): string {
  return `${CUSTOM_GROUP_TAG_PREFIX}${normalizeGroupName(name)}`;
}

function stripMatchingGroup(tags: string[], name: string): string[] {
  const targetKey = groupTagKey(name);
  return tags.filter((tag) => {
    if (!isCustomGroupTag(tag)) return true;
    return groupTagKey(tag.slice(CUSTOM_GROUP_TAG_PREFIX.length)) !== targetKey;
  });
}

export async function POST(request: Request) {
  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Property groups mutate tags on listings (a tenant-owned write).
  // Reporting-only viewers shouldn't be able to reorganise the portfolio.
  if (auth.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const parsed = listingGroupMutationSchema.parse(await request.json());
    const normalizedName = normalizeGroupName(parsed.name);

    if (parsed.action !== "delete" && parsed.listingIds.length === 0) {
      return NextResponse.json({ error: "Select at least one property." }, { status: 400 });
    }

    const listings = await prisma.listing.findMany({
      where: {
        tenantId: auth.tenantId,
        ...(parsed.action === "delete" ? {} : { id: { in: parsed.listingIds } })
      },
      select: {
        id: true,
        tags: true
      }
    });

    await prisma.$transaction(async (tx) => {
      for (const listing of listings) {
        const currentTags = listing.tags ?? [];
        const nextTags =
          parsed.action === "assign"
            ? [...stripMatchingGroup(currentTags, normalizedName), toGroupTag(normalizedName)]
            : stripMatchingGroup(currentTags, normalizedName);

        await tx.listing.update({
          where: { id: listing.id },
          data: { tags: nextTags }
        });
      }
    });

    return NextResponse.json({
      success: true,
      updatedListings: listings.length
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.flatten() }, { status: 400 });
    }

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to update property group"
      },
      { status: 500 }
    );
  }
}
