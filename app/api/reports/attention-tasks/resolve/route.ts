import { NextResponse } from "next/server";
import { z } from "zod";

import { getAuthContext } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const resolveAttentionTaskSchema = z.object({
  listingId: z.string().min(1).max(64),
  // Cap reason key payload to keep an attacker from forcing a huge upsert batch.
  // The allowed-list below shrinks this further to the 5 known keys.
  reasonKeys: z.array(z.string().min(1).max(64)).min(1).max(20),
  action: z.enum(["complete", "ignore"])
});

const ALLOWED_REASON_KEYS = new Set([
  "pace_month_revenue_20",
  "occ_7_under_60",
  "occ_14_under_50",
  "occ_30_under_30",
  "adr_month_diff_10"
]);

export async function POST(request: Request) {
  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const parsed = resolveAttentionTaskSchema.parse(await request.json());
    const reasonKeys = [...new Set(parsed.reasonKeys)].filter((key) => ALLOWED_REASON_KEYS.has(key));
    if (reasonKeys.length === 0) {
      return NextResponse.json({ error: "No valid attention reason keys supplied" }, { status: 400 });
    }

    const listing = await prisma.listing.findFirst({
      where: {
        id: parsed.listingId,
        tenantId: auth.tenantId
      },
      select: {
        id: true
      }
    });
    if (!listing) {
      return NextResponse.json({ error: "Listing not found" }, { status: 404 });
    }

    const suppressedUntil = new Date();
    suppressedUntil.setUTCDate(suppressedUntil.getUTCDate() + 7);

    await prisma.$transaction(
      reasonKeys.map((taskKey) =>
        prisma.attentionTaskSuppression.upsert({
          where: {
            tenantId_listingId_taskKey: {
              tenantId: auth.tenantId,
              listingId: parsed.listingId,
              taskKey
            }
          },
          update: {
            action: parsed.action,
            suppressedUntil
          },
          create: {
            tenantId: auth.tenantId,
            listingId: parsed.listingId,
            taskKey,
            action: parsed.action,
            suppressedUntil
          }
        })
      )
    );

    return NextResponse.json({
      success: true,
      listingId: parsed.listingId,
      reasonKeys,
      action: parsed.action,
      suppressedUntil: suppressedUntil.toISOString()
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.flatten() }, { status: 400 });
    }

    if (
      error instanceof Error &&
      error.message.toLowerCase().includes("attention_task_suppressions") &&
      error.message.toLowerCase().includes("does not exist")
    ) {
      return NextResponse.json(
        {
          error: "Database table attention_task_suppressions is missing. Run `npx prisma db push` then retry."
        },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to resolve attention task"
      },
      { status: 500 }
    );
  }
}
