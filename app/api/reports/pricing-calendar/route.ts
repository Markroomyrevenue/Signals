import { NextResponse } from "next/server";
import { z } from "zod";

import { getAuthContext } from "@/lib/auth";
import { liveMarketRefreshEnabled } from "@/lib/features";
import { prisma } from "@/lib/prisma";
import { buildPricingCalendarReport } from "@/lib/reports/service";
import { pricingCalendarRequestSchema } from "@/lib/reports/schemas";

const PRICING_CALENDAR_REPORT_TTL_MS = 15 * 60 * 1000;
const PRICING_CALENDAR_REPORT_CACHE_MAX_ENTRIES = 48;
const pricingCalendarReportCache = new Map<string, { expiresAt: number; value: unknown }>();

function evictExpiredPricingCalendarReports(now: number) {
  for (const [key, entry] of pricingCalendarReportCache.entries()) {
    if (entry.expiresAt <= now) {
      pricingCalendarReportCache.delete(key);
    }
  }
}

function trimPricingCalendarReportCache() {
  while (pricingCalendarReportCache.size > PRICING_CALENDAR_REPORT_CACHE_MAX_ENTRIES) {
    const oldestKey = pricingCalendarReportCache.keys().next().value;
    if (!oldestKey) break;
    pricingCalendarReportCache.delete(oldestKey);
  }
}

export async function POST(request: Request) {
  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // The pricing calendar IS the dynamic-pricing workspace. Reporting-only
  // viewers shouldn't be able to read it (it surfaces base/min prices,
  // suggested rates, and per-night settings). The UI hides the tab; this
  // matches the gate server-side so a hand-crafted request still gets 403.
  if (auth.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const parsed = pricingCalendarRequestSchema.parse(await request.json());
    const allowLiveMarketRefresh = liveMarketRefreshEnabled();
    const normalizedRequest = {
      ...parsed,
      forceMarketRefresh: allowLiveMarketRefresh && parsed.forceMarketRefresh
    };
    const [tenant, latestPricingSetting, hostawayConnection] = await Promise.all([
      prisma.tenant.findUnique({
        where: { id: auth.tenantId },
        select: { defaultCurrency: true }
      }),
      prisma.pricingSetting.aggregate({
        where: { tenantId: auth.tenantId },
        _max: { updatedAt: true }
      }),
      prisma.hostawayConnection.findUnique({
        where: { tenantId: auth.tenantId },
        select: { lastSyncAt: true, updatedAt: true }
      })
    ]);

    const displayCurrency = (parsed.displayCurrency ?? tenant?.defaultCurrency ?? "GBP").toUpperCase();
    const cacheableRequest = {
      ...normalizedRequest,
      forceMarketRefresh: false
    };
    const cacheVersion = JSON.stringify({
      lastSyncAt: hostawayConnection?.lastSyncAt?.toISOString() ?? null,
      connectionUpdatedAt: hostawayConnection?.updatedAt?.toISOString() ?? null,
      pricingSettingsUpdatedAt: latestPricingSetting._max.updatedAt?.toISOString() ?? null
    });
    const cacheKey = JSON.stringify({
      tenantId: auth.tenantId,
      request: cacheableRequest,
      displayCurrency,
      cacheVersion
    });

    const now = Date.now();
    evictExpiredPricingCalendarReports(now);

    if (!normalizedRequest.forceMarketRefresh) {
      const cached = pricingCalendarReportCache.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        pricingCalendarReportCache.delete(cacheKey);
        pricingCalendarReportCache.set(cacheKey, cached);
        return NextResponse.json(cached.value);
      }
    }

    const report = await buildPricingCalendarReport({
      tenantId: auth.tenantId,
      request: normalizedRequest,
      displayCurrency
    });

    pricingCalendarReportCache.set(cacheKey, {
      expiresAt: now + PRICING_CALENDAR_REPORT_TTL_MS,
      value: report
    });
    trimPricingCalendarReportCache();

    return NextResponse.json(report);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.flatten() }, { status: 400 });
    }

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to build pricing calendar report"
      },
      { status: 500 }
    );
  }
}
