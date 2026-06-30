/**
 * audit:occupancy — recompute released-stock occupancy and the resulting
 * rate-copy rates for the multi-unit / group-scoped listings, and reconcile
 * against the rates currently live on Hostaway. READ-ONLY: no DB writes, no
 * Hostaway pushes.
 *
 * Run against prod via the public DB URL, e.g.:
 *   DATABASE_URL="<public-proxy-url>" npx tsx scripts/audit-occupancy.ts
 *
 * Env knobs:
 *   AUDIT_DAYS=60          how many days forward to reconcile (default 60)
 *   AUDIT_GROUPING=split   'current' (one shared pool) | 'split' (Edge alone,
 *                          Alma's two pooled) | 'individual' (each alone).
 *                          Default 'split'.
 *   AUDIT_TENANT=<name>    substring match on tenant name (default all with
 *                          rate_copy multi-unit/group listings).
 */
import { PrismaClient } from "@prisma/client";

import { computeMultiUnitOccupancyByDate } from "@/lib/pricing/multi-unit-occupancy";
import { computeRateCopyByDate } from "@/lib/pricing/rate-copy";
import {
  resolvePricingSettings,
  parsePricingSettingsOverride,
  customGroupNamesFromTags,
  customGroupKey
} from "@/lib/pricing/settings";
import { toDateOnly, fromDateOnly, addUtcDays } from "@/lib/metrics/helpers";

const prisma = new PrismaClient();

const DAYS = Number(process.env.AUDIT_DAYS ?? 60);
const GROUPING = (process.env.AUDIT_GROUPING ?? "split") as "current" | "split" | "individual";
const TENANT_FILTER = process.env.AUDIT_TENANT ?? "";

type Num = number;
function stats(xs: Num[]) {
  if (xs.length === 0) return { n: 0, min: null, median: null, mean: null, max: null };
  const s = [...xs].sort((a, b) => a - b);
  const sum = xs.reduce((a, b) => a + b, 0);
  return { n: xs.length, min: s[0], median: s[Math.floor(s.length / 2)], mean: Math.round((sum / xs.length) * 100) / 100, max: s[s.length - 1] };
}

// Real Little Feather student-accom listings by Hostaway id (excludes test rows).
const EDGE = new Set(["515526"]);
const ALMA = new Set(["514009", "554857"]);
const STUDENT = new Set([...EDGE, ...ALMA]);

/** Hypothetical group tag for a listing, keyed on its Hostaway id. Returns null
 *  for listings that are not part of any student-accom pool (excluded). */
function overrideTagByHid(hid: string, grouping: typeof GROUPING): string[] | null {
  if (!STUDENT.has(hid)) return null; // exclude test + unrelated listings
  if (grouping === "individual") return [`group:__only_${hid}`];
  if (grouping === "split") {
    if (EDGE.has(hid)) return ["group:The Edge"];
    if (ALMA.has(hid)) return ["group:Alma Place"];
  }
  return ["group:Student Accomodation"]; // current shared pool
}

async function main() {
  const today = toDateOnly(new Date());
  const dateTo = toDateOnly(addUtcDays(fromDateOnly(today), DAYS));

  // Find rate_copy + push-enabled property settings that are multi-unit or group-scoped.
  const settingsRows = await prisma.pricingSetting.findMany({ where: { scope: "property", scopeRef: { not: null } } });
  const out: any = { grouping: GROUPING, window: { from: today, to: dateTo }, listings: [] };

  for (const row of settingsRows) {
    const cfg = parsePricingSettingsOverride(row.settings);
    if (cfg.pricingMode !== "rate_copy" || cfg.rateCopyPushEnabled !== true) continue;
    const listing = await prisma.listing.findFirst({ where: { id: row.scopeRef!, tenantId: row.tenantId }, select: { id: true, tenantId: true, hostawayId: true, name: true, tags: true, unitCount: true } });
    if (!listing) continue;
    const tenant = await prisma.tenant.findUnique({ where: { id: listing.tenantId }, select: { name: true } });
    if (TENANT_FILTER && !(tenant?.name ?? "").toLowerCase().includes(TENANT_FILTER.toLowerCase())) continue;

    // Resolve settings (portfolio -> group -> property) the way the push service does.
    const portfolioRow = await prisma.pricingSetting.findFirst({ where: { tenantId: listing.tenantId, scope: "portfolio", scopeRef: null } });
    const groupKeysRaw = listing.tags.filter((t) => t.toLowerCase().startsWith("group:")).map((t) => t.slice(6).trim().toLowerCase()).filter((k) => k.length > 0);
    const groupRow = groupKeysRaw.length > 0 ? await prisma.pricingSetting.findFirst({ where: { tenantId: listing.tenantId, scope: "group", scopeRef: { in: groupKeysRaw } } }) : null;
    const { settings } = resolvePricingSettings({
      portfolio: parsePricingSettingsOverride(portfolioRow?.settings),
      group: parsePricingSettingsOverride(groupRow?.settings),
      property: cfg
    });
    if (!settings.rateCopySourceListingId) continue;
    const targetUserMin = settings.minimumPriceOverride && settings.minimumPriceOverride > 0 ? settings.minimumPriceOverride : (settings.basePriceOverride ?? 0) * 0.7;

    // Build the hypothetical pool: all rate_copy multi-unit/group listings in
    // the tenant, with tags overridden per the chosen grouping.
    const tenantListings = await prisma.listing.findMany({ where: { tenantId: listing.tenantId, removedAt: null }, select: { id: true, name: true, hostawayId: true, tags: true, unitCount: true } });
    const targetTag = overrideTagByHid(listing.hostawayId, GROUPING);
    if (!targetTag) continue; // not a student-accom listing in scope
    const targetKey = customGroupKey(customGroupNamesFromTags(targetTag)[0]!);
    const memberInputs = tenantListings
      .map((m) => ({ listingId: m.id, hostawayId: m.hostawayId, tags: overrideTagByHid(m.hostawayId, GROUPING), unitCount: m.unitCount, name: m.name }))
      .filter((m): m is typeof m & { tags: string[] } => {
        if (!m.tags) return false;
        const mNames = customGroupNamesFromTags(m.tags);
        return mNames.length > 0 && customGroupKey(mNames[0]!) === targetKey;
      });

    const occByListing = await computeMultiUnitOccupancyByDate({
      tenantId: listing.tenantId,
      listingInputs: memberInputs.map((m) => ({ listingId: m.listingId, tags: m.tags, unitCount: m.unitCount })),
      fromDate: today,
      toDate: dateTo,
      prisma,
      poolSingleUnitMembers: true,
      useReleasedStockDenominator: true
    });
    const occForTarget = occByListing.get(listing.id) ?? null;

    const rateMap = await computeRateCopyByDate({
      prisma,
      tenantId: listing.tenantId,
      sourceListingId: settings.rateCopySourceListingId,
      targetListingId: listing.id,
      fromDate: today,
      toDate: dateTo,
      multiUnitMatrix: settings.multiUnitOccupancyLeadTimeMatrix,
      targetDefaultMinStay: settings.minimumNightStay,
      targetUserMin,
      occupancyByDate: occForTarget,
      roundingIncrement: settings.roundingIncrement,
      todayDateOnly: today
    });

    // Currently-pushed baseline = latest success push event payload.
    const ev = await prisma.hostawayPushEvent.findFirst({ where: { tenantId: listing.tenantId, listingId: listing.id, status: "success" }, orderBy: { createdAt: "desc" }, select: { payload: true } });
    const lastPushed = new Map<string, number>();
    const payload = (ev?.payload as any)?.rates as Array<{ date: string; dailyPrice: number }> | undefined;
    if (payload) for (const r of payload) if (typeof r.dailyPrice === "number") lastPushed.set(r.date, r.dailyPrice);

    // Reconcile.
    const basisCounts = { released: 0, static: 0, mixed: 0 };
    const occVals: number[] = [];
    const deltas: number[] = [];
    const samples: any[] = [];
    let belowFloor = 0;
    for (const [date, entry] of rateMap) {
      if ("skipReason" in entry) continue;
      const occCell = occForTarget?.get(date);
      if (occCell) { basisCounts[occCell.denominatorBasis]++; occVals.push(occCell.occupancyPct); }
      if (entry.rate < targetUserMin - 0.001 && !entry.overrideApplied) belowFloor++;
      const old = lastPushed.get(date);
      if (old != null) {
        const d = entry.rate - old;
        deltas.push(d);
        if (samples.length < 8 && Math.abs(d) >= 1) samples.push({ date, old, new: entry.rate, occPct: occCell?.occupancyPct, denom: occCell?.unitsDenominator, basis: occCell?.denominatorBasis, mult: entry.occupancyMultiplier, floored: entry.flooredAtMin });
      }
    }
    out.listings.push({
      tenant: tenant?.name, name: listing.name, hostawayId: listing.hostawayId, unitCount: listing.unitCount,
      poolMembers: memberInputs.map((m) => m.name), targetUserMin: Math.round(targetUserMin * 100) / 100,
      occupancyBasis: basisCounts, occupancyPct: stats(occVals), rateDelta: stats(deltas), belowFloor,
      changedDates: deltas.filter((d) => Math.abs(d) >= 1).length, totalReconciled: deltas.length, sampleChanges: samples
    });
  }

  console.log(JSON.stringify(out, null, 2));
}

main().then(() => prisma.$disconnect()).catch((e) => { console.error("AUDIT ERROR", e); return prisma.$disconnect().then(() => process.exit(1)); });
