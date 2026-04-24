import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";

import { getAuthContext } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  DEFAULT_PRICING_SETTINGS,
  loadResolvedPricingSettings,
  parsePricingSettingsOverride,
  resolvePricingSettings
} from "@/lib/pricing/settings";

const scopeSchema = z.enum(["portfolio", "group", "property"]);
const requestSchema = z.object({
  scope: scopeSchema,
  scopeRef: z.string().trim().optional(),
  settings: z.record(z.any()).default({}),
  mergeExisting: z.boolean().optional().default(false),
  clearKeys: z.array(z.string().trim()).optional().default([])
});

function normalizeStoredSettings(value: unknown): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(parsePricingSettingsOverride(value as never))) as Prisma.InputJsonObject;
}

function hasMeaningfulSettings(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0;
}

export async function GET(request: Request) {
  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Pricing settings power the Calendar / dynamic-pricing workspace.
  // Reporting-only viewers should not be able to read them either — it keeps
  // the admin-only surface properly isolated for staff users.
  if (auth.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const scope = scopeSchema.parse(searchParams.get("scope") ?? "portfolio");
  const scopeRef = searchParams.get("scopeRef")?.trim() || null;

  if ((scope === "group" || scope === "property") && !scopeRef) {
    return NextResponse.json({ error: "scopeRef is required for group and property settings" }, { status: 400 });
  }

  const rows = await prisma.pricingSetting.findMany({
    where: {
      tenantId: auth.tenantId,
      OR: [
        { scope: "portfolio" },
        ...(scope !== "portfolio" && scopeRef ? [{ scope, scopeRef }] : [])
      ]
    },
    select: {
      scope: true,
      scopeRef: true,
      settings: true
    }
  });

  const portfolioOverride = parsePricingSettingsOverride(rows.find((row) => row.scope === "portfolio")?.settings);
  const currentOverride = parsePricingSettingsOverride(
    rows.find((row) => row.scope === scope && (scope === "portfolio" ? true : row.scopeRef === scopeRef))?.settings
  );

  let resolved = DEFAULT_PRICING_SETTINGS;
  if (scope === "portfolio") {
    resolved = resolvePricingSettings({
      portfolio: currentOverride,
      group: {},
      property: {}
    }).settings;
  } else if (scope === "group") {
    resolved = resolvePricingSettings({
      portfolio: portfolioOverride,
      group: currentOverride,
      property: {}
    }).settings;
  } else if (scopeRef) {
    const listing = await prisma.listing.findFirst({
      where: { id: scopeRef, tenantId: auth.tenantId },
      select: { id: true, tags: true }
    });

    if (!listing) {
      return NextResponse.json({ error: "Listing not found" }, { status: 404 });
    }

    resolved =
      (
        await loadResolvedPricingSettings({
          tenantId: auth.tenantId,
          listings: [{ listingId: listing.id, tags: listing.tags }]
        })
      ).get(listing.id)?.settings ?? DEFAULT_PRICING_SETTINGS;
  }

  return NextResponse.json({
    scope,
    scopeRef,
    override: normalizeStoredSettings(currentOverride),
    resolved
  });
}

export async function POST(request: Request) {
  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (auth.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const parsed = requestSchema.parse(await request.json());
    const scopeRef = parsed.scopeRef?.trim() || null;

    if ((parsed.scope === "group" || parsed.scope === "property") && !scopeRef) {
      return NextResponse.json({ error: "scopeRef is required for group and property settings" }, { status: 400 });
    }

    const existing = await prisma.pricingSetting.findFirst({
      where: {
        tenantId: auth.tenantId,
        scope: parsed.scope,
        scopeRef
      },
      select: { id: true, settings: true }
    });

    const mergedInput = (() => {
      const next: Record<string, unknown> =
        parsed.mergeExisting && existing?.settings
          ? {
              ...parsePricingSettingsOverride(existing.settings),
              ...parsed.settings
            }
          : { ...parsed.settings };

      for (const key of parsed.clearKeys) {
        delete next[key];
      }

      return next;
    })();

    const normalizedSettings = normalizeStoredSettings(mergedInput);

    if (!hasMeaningfulSettings(normalizedSettings)) {
      if (parsed.scope === "portfolio") {
        await prisma.pricingSetting.deleteMany({
          where: {
            tenantId: auth.tenantId,
            scope: parsed.scope
          }
        });
      } else {
        await prisma.pricingSetting.deleteMany({
          where: {
            tenantId: auth.tenantId,
            scope: parsed.scope,
            scopeRef
          }
        });
      }

      return NextResponse.json({ ok: true, deleted: true });
    }

    if (existing) {
      await prisma.pricingSetting.update({
        where: { id: existing.id },
        data: {
          settings: normalizedSettings
        }
      });
    } else {
      await prisma.pricingSetting.create({
        data: {
          tenantId: auth.tenantId,
          scope: parsed.scope,
          scopeRef,
          settings: normalizedSettings
        }
      });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.flatten() }, { status: 400 });
    }

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to save pricing settings"
      },
      { status: 500 }
    );
  }
}
