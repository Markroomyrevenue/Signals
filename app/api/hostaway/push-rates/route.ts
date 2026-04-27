import { NextResponse } from "next/server";
import { z } from "zod";

import { getAuthContext } from "@/lib/auth";
import {
  buildPushRatesPreview,
  executePushRates,
  findLastPushEventForListing,
  PushRatesError
} from "@/lib/hostaway/push-service";

const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const requestSchema = z.object({
  listingId: z.string().trim().min(1),
  dateFrom: dateOnlySchema,
  dateTo: dateOnlySchema,
  dryRun: z.boolean().optional().default(true),
  displayCurrency: z.string().length(3).optional()
});

// POST /api/hostaway/push-rates
//
// Pushes the recommended nightly rates for a listing back into Hostaway's
// calendar for a date range. Owner-controlled per-listing toggle gates
// this — see PricingResolvedSettings.hostawayPushEnabled.
//
// dryRun:true (default) returns the proposed payload without calling the
// channel manager. dryRun:false performs the push AND writes a
// HostawayPushEvent row regardless of success/failure.
export async function POST(request: Request) {
  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (auth.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  let parsed: z.infer<typeof requestSchema>;
  try {
    parsed = requestSchema.parse(body);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.flatten() }, { status: 400 });
    }
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (parsed.dateFrom > parsed.dateTo) {
    return NextResponse.json({ error: "dateFrom must be on or before dateTo" }, { status: 400 });
  }

  try {
    if (parsed.dryRun) {
      const preview = await buildPushRatesPreview({
        tenantId: auth.tenantId,
        listingId: parsed.listingId,
        dateFrom: parsed.dateFrom,
        dateTo: parsed.dateTo,
        displayCurrency: parsed.displayCurrency
      });
      const lastEvent = await findLastPushEventForListing({
        tenantId: auth.tenantId,
        listingId: parsed.listingId
      });
      return NextResponse.json({
        ok: true,
        dryRun: true,
        preview,
        lastEvent: lastEvent
          ? {
              id: lastEvent.id,
              dateCount: lastEvent.dateCount,
              status: lastEvent.status,
              pushedBy: lastEvent.pushedBy,
              createdAt: lastEvent.createdAt.toISOString()
            }
          : null
      });
    }

    const result = await executePushRates({
      tenantId: auth.tenantId,
      listingId: parsed.listingId,
      pushedBy: auth.email,
      dateFrom: parsed.dateFrom,
      dateTo: parsed.dateTo,
      displayCurrency: parsed.displayCurrency
    });

    if (!result.ok) {
      return NextResponse.json(
        {
          ok: false,
          dryRun: false,
          eventId: result.eventId,
          errorMessage: result.errorMessage,
          preview: result.preview
        },
        { status: 502 }
      );
    }

    return NextResponse.json({
      ok: true,
      dryRun: false,
      pushedCount: result.pushedCount,
      eventId: result.eventId,
      preview: result.preview
    });
  } catch (error) {
    if (error instanceof PushRatesError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to process push request" },
      { status: 500 }
    );
  }
}
