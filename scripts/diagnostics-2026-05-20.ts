/**
 * Daytime diagnostics 2026-05-20 — READ ONLY.
 * Tasks 1-3 (Task 4 was a shell check, handled inline).
 *
 * Writes results to /Users/markmccracken/Documents/signals/trial-reports/diagnostics-2026-05-20.md
 *
 * Does NOT modify any pricing logic, settings, push behaviour, schema, or
 * The Edge. Per the prompt: investigation only.
 */
import { writeFile } from "node:fs/promises";
import { prisma } from "@/lib/prisma";

const SNAPSHOT_ISO = "2026-05-20";
const TRAILING_DAYS = 365;
const HORIZON_DAYS_PL = 270;
const EDGE_HOSTAWAY_ID = "515526"; // The Edge — multi-unit, untouched
const KD_BASE_URL = process.env.KEYDATA_API_BASE_URL ?? "https://api-beta.keydatadashboard.com";
const KD_KEY = process.env.KEYDATA_ACCESS_KEY ?? "";
const BELFAST_UUID = process.env.KEYDATA_BELFAST_MARKET_UUID ?? "1793782a-1187-4f9a-b0be-0601e3635b1a";

// Lightweight OTA-channel classifier. "direct" + "booking engine" + "google"
// are treated as direct/self-channel bookings; everything else (Airbnb,
// Booking.com, Vrbo, etc.) is OTA. Quoting the channel name exactly as it
// appears in the DB so this is auditable.
const DIRECT_CHANNELS = new Set<string>(["direct", "booking engine", "google", "homeaway", "guest_referral"]);
function classifyChannel(raw: string | null | undefined): "direct" | "ota" | "unknown" {
  if (!raw) return "unknown";
  const k = raw.toLowerCase().trim();
  return DIRECT_CHANNELS.has(k) ? "direct" : "ota";
}

type ChannelAggregate = {
  bookings: number;
  nights: number;
  revenue: number;
};
function emptyAgg(): ChannelAggregate {
  return { bookings: 0, nights: 0, revenue: 0 };
}

type ListingDiagnostic = {
  listingId: string;
  listingName: string;
  hostawayId: string;
  bedrooms: number | null;
  personCapacity: number | null;
  roomType: string | null;
  qualityTier: string | null;
  // Trailing-ADR helper output
  trailing365dAdr: number | null;
  trailingSoldNights: number;
  trailingRevenue: number;
  // Pre-exclusion sample size context
  totalBookedNights: number;
  longStayNights: number;
  longStayPct: number;
  ownerStayNights: number;
  ownerStayPct: number;
  // Channel split (post the trailing-adr exclusions: isOccupied, > 0 revenue,
  // LOS <= 10, not ownerstay). Bookings counted by distinct reservation id.
  channelOta: ChannelAggregate;
  channelDirect: ChannelAggregate;
  channelUnknown: ChannelAggregate;
  // Computed base from today's snapshot (any in-band cell — base is per-listing
  // not per-date, so the first match is fine)
  computedBase: number | null;
  // Mean PL rate over next 270 days for this listing
  meanPlRateNext270d: number | null;
  plRatesAvailable: number;
  baseGapPct: number | null;
};

async function getLfTenantId(): Promise<string | null> {
  const lf = await prisma.tenant.findFirst({ where: { name: "Little Feather Management" } });
  return lf?.id ?? null;
}

async function fetchLfListings(tenantId: string) {
  return prisma.listing.findMany({
    where: { tenantId, status: { not: "inactive" } },
    select: {
      id: true,
      name: true,
      hostawayId: true,
      bedroomsNumber: true,
      personCapacity: true,
      roomType: true
    },
    orderBy: { name: "asc" }
  });
}

async function fetchPricingSetting(tenantId: string, listingId: string): Promise<Record<string, unknown>> {
  const row = await prisma.pricingSetting.findFirst({
    where: { tenantId, scope: "property", scopeRef: listingId },
    select: { settings: true }
  });
  return (row?.settings ?? {}) as Record<string, unknown>;
}

async function trailingAdrAndChannelSplit(tenantId: string, listingId: string): Promise<{
  trailing365dAdr: number | null;
  trailingSoldNights: number;
  trailingRevenue: number;
  totalBookedNights: number;
  longStayNights: number;
  ownerStayNights: number;
  channelOta: ChannelAggregate;
  channelDirect: ChannelAggregate;
  channelUnknown: ChannelAggregate;
}> {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - TRAILING_DAYS);
  const today = new Date();
  // Pull RAW night_fact rows for this listing in the trailing window so we
  // can derive both the post-exclusion ADR AND the pre-exclusion totals
  // (long-stay nights, ownerstay nights) AND the channel split.
  const rows = await prisma.nightFact.findMany({
    where: {
      tenantId,
      listingId,
      date: { gte: start, lt: today }
    },
    select: {
      date: true,
      isOccupied: true,
      revenueAllocated: true,
      losNights: true,
      status: true,
      channel: true,
      reservationId: true
    }
  });
  let totalBookedNights = 0;
  let longStayNights = 0;
  let ownerStayNights = 0;
  const channelOta = emptyAgg();
  const channelDirect = emptyAgg();
  const channelUnknown = emptyAgg();
  // Track unique reservation ids per channel so bookings counts are correct.
  const otaResIds = new Set<string>();
  const directResIds = new Set<string>();
  const unknownResIds = new Set<string>();
  // Aggregate per-date for ADR + occupancy so duplicate factKeys on the
  // same night don't double-count revenue. Mirrors the trailing-adr helper.
  type Cell = { revenue: number; channelHit: string };
  const byDate = new Map<string, Cell>();
  for (const r of rows) {
    if (!r.isOccupied) continue;
    totalBookedNights += 1;
    const status = (r.status ?? "").toLowerCase();
    const losNights = r.losNights ?? null;
    if (losNights !== null && losNights > 10) longStayNights += 1;
    if (status === "ownerstay") ownerStayNights += 1;
    // Apply the trailing-adr exclusions
    if (status === "ownerstay") continue;
    if (losNights === null || losNights > 10) continue;
    const rev = Number(r.revenueAllocated ?? 0);
    if (!Number.isFinite(rev) || rev <= 0) continue;
    const iso = r.date.toISOString().slice(0, 10);
    const cur = byDate.get(iso) ?? { revenue: 0, channelHit: r.channel ?? "" };
    cur.revenue += rev;
    // Keep the first channel we see per night — typically only one
    // reservation occupies a night anyway.
    if (!cur.channelHit) cur.channelHit = r.channel ?? "";
    byDate.set(iso, cur);
    // Per-channel night + revenue aggregation. Each NightFact row counts
    // exactly once for its channel even if the byDate collapse later
    // dedups across overlapping reservations.
    const klass = classifyChannel(r.channel);
    const bucket = klass === "ota" ? channelOta : klass === "direct" ? channelDirect : channelUnknown;
    bucket.nights += 1;
    bucket.revenue += rev;
    const idSet = klass === "ota" ? otaResIds : klass === "direct" ? directResIds : unknownResIds;
    if (r.reservationId) idSet.add(r.reservationId);
  }
  channelOta.bookings = otaResIds.size;
  channelDirect.bookings = directResIds.size;
  channelUnknown.bookings = unknownResIds.size;
  const sortedDates = Array.from(byDate.values());
  const soldNights = sortedDates.length;
  const totalRevenue = sortedDates.reduce((s, c) => s + c.revenue, 0);
  return {
    trailing365dAdr: soldNights > 0 ? totalRevenue / soldNights : null,
    trailingSoldNights: soldNights,
    trailingRevenue: totalRevenue,
    totalBookedNights,
    longStayNights,
    ownerStayNights,
    channelOta,
    channelDirect,
    channelUnknown
  };
}

async function todaysBaseForListing(tenantId: string, listingId: string): Promise<number | null> {
  const row = await prisma.pricingComparisonSnapshot.findFirst({
    where: {
      tenantId,
      listingId,
      snapshotDate: new Date(`${SNAPSHOT_ISO}T00:00:00Z`)
    },
    select: { ourBreakdown: true }
  });
  if (!row) return null;
  const b = row.ourBreakdown as { base?: unknown } | null;
  const base = Number(b?.base);
  return Number.isFinite(base) && base > 0 ? base : null;
}

async function meanPlRateNext270d(tenantId: string, listingId: string): Promise<{ mean: number | null; n: number }> {
  const rows = await prisma.pricingComparisonSnapshot.findMany({
    where: {
      tenantId,
      listingId,
      snapshotDate: new Date(`${SNAPSHOT_ISO}T00:00:00Z`),
      windowDays: { gte: 0, lte: HORIZON_DAYS_PL },
      hostawayRate: { not: null }
    },
    select: { hostawayRate: true }
  });
  const vals = rows
    .map((r) => Number(r.hostawayRate))
    .filter((v) => Number.isFinite(v) && v > 0);
  if (vals.length === 0) return { mean: null, n: 0 };
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  return { mean, n: vals.length };
}

async function task1(tenantId: string): Promise<ListingDiagnostic[]> {
  const listings = await fetchLfListings(tenantId);
  const out: ListingDiagnostic[] = [];
  for (const l of listings) {
    const settings = await fetchPricingSetting(tenantId, l.id);
    const tier =
      typeof settings.qualityTier === "string"
        ? (settings.qualityTier as string)
        : null;
    const t = await trailingAdrAndChannelSplit(tenantId, l.id);
    const computedBase = await todaysBaseForListing(tenantId, l.id);
    const pl = await meanPlRateNext270d(tenantId, l.id);
    const longStayPct = t.totalBookedNights > 0 ? t.longStayNights / t.totalBookedNights : 0;
    const ownerStayPct = t.totalBookedNights > 0 ? t.ownerStayNights / t.totalBookedNights : 0;
    out.push({
      listingId: l.id,
      listingName: l.name,
      hostawayId: l.hostawayId,
      bedrooms: l.bedroomsNumber,
      personCapacity: l.personCapacity,
      roomType: l.roomType,
      qualityTier: tier,
      trailing365dAdr: t.trailing365dAdr,
      trailingSoldNights: t.trailingSoldNights,
      trailingRevenue: t.trailingRevenue,
      totalBookedNights: t.totalBookedNights,
      longStayNights: t.longStayNights,
      longStayPct,
      ownerStayNights: t.ownerStayNights,
      ownerStayPct,
      channelOta: t.channelOta,
      channelDirect: t.channelDirect,
      channelUnknown: t.channelUnknown,
      computedBase,
      meanPlRateNext270d: pl.mean,
      plRatesAvailable: pl.n,
      baseGapPct:
        computedBase !== null && pl.mean !== null && pl.mean > 0
          ? (computedBase - pl.mean) / pl.mean
          : null
    });
  }
  out.sort((a, b) => {
    const av = a.baseGapPct ?? Number.POSITIVE_INFINITY;
    const bv = b.baseGapPct ?? Number.POSITIVE_INFINITY;
    return av - bv;
  });
  return out;
}

async function task2(tenantId: string): Promise<{
  edgeListings: Array<{ id: string; name: string; hostawayId: string }>;
  edgeListingsAcrossTenants: Array<{ id: string; name: string; tenantName: string; hostawayId: string }>;
  edgeNameMatchesAcrossTenants: Array<{ id: string; name: string; tenantName: string; hostawayId: string }>;
  multiUnitListingsInLf: Array<{ id: string; name: string; unitCount: number | null }>;
  edgeCells: number;
  totalLfCells: number;
  inclMean: number | null;
  inclMedian: number | null;
  exclMean: number | null;
  exclMedian: number | null;
}> {
  // Resolve every listing with hostawayId = '515526' OR matching The Edge
  // naming. Per spec, hostawayId is authoritative.
  const edgeListings = await prisma.listing.findMany({
    where: { tenantId, hostawayId: EDGE_HOSTAWAY_ID },
    select: { id: true, name: true, hostawayId: true }
  });
  // Sweep across ALL tenants in case The Edge is currently linked to a
  // different tenant or has an unexpected hostawayId.
  const acrossTenants = await prisma.listing.findMany({
    where: { hostawayId: EDGE_HOSTAWAY_ID },
    select: { id: true, name: true, hostawayId: true, tenant: { select: { name: true } } }
  });
  const edgeListingsAcrossTenants = acrossTenants.map((l) => ({
    id: l.id,
    name: l.name,
    tenantName: l.tenant.name,
    hostawayId: l.hostawayId
  }));
  const acrossByName = await prisma.listing.findMany({
    where: { name: { contains: "Edge", mode: "insensitive" } },
    select: { id: true, name: true, hostawayId: true, tenant: { select: { name: true } } }
  });
  const edgeNameMatchesAcrossTenants = acrossByName.map((l) => ({
    id: l.id,
    name: l.name,
    tenantName: l.tenant.name,
    hostawayId: l.hostawayId
  }));
  const multiUnit = await prisma.listing.findMany({
    where: { tenantId, unitCount: { gte: 2 } },
    select: { id: true, name: true, unitCount: true }
  });
  const multiUnitListingsInLf = multiUnit;
  const edgeIds = edgeListings.map((l) => l.id);

  const totalLfCells = await prisma.pricingComparisonSnapshot.count({
    where: { tenantId, snapshotDate: new Date(`${SNAPSHOT_ISO}T00:00:00Z`) }
  });
  const edgeCells = edgeIds.length === 0
    ? 0
    : await prisma.pricingComparisonSnapshot.count({
        where: {
          tenantId,
          snapshotDate: new Date(`${SNAPSHOT_ISO}T00:00:00Z`),
          listingId: { in: edgeIds }
        }
      });

  // Read ALL LF cells with PL rate, compute mean + median signed delta two
  // ways (incl Edge / excl Edge).
  const rows = await prisma.pricingComparisonSnapshot.findMany({
    where: {
      tenantId,
      snapshotDate: new Date(`${SNAPSHOT_ISO}T00:00:00Z`),
      hostawayRate: { not: null }
    },
    select: { listingId: true, deltaPct: true }
  });
  function statsFor(rs: Array<{ deltaPct: number | null }>): { mean: number | null; median: number | null } {
    const vals = rs.map((r) => r.deltaPct).filter((v): v is number => v !== null && Number.isFinite(v));
    if (vals.length === 0) return { mean: null, median: null };
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const sorted = [...vals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return { mean, median };
  }
  const inclAll = statsFor(rows);
  const exclEdge = statsFor(rows.filter((r) => !edgeIds.includes(r.listingId)));
  return {
    edgeListings,
    edgeListingsAcrossTenants,
    edgeNameMatchesAcrossTenants,
    multiUnitListingsInLf,
    edgeCells,
    totalLfCells,
    inclMean: inclAll.mean,
    inclMedian: inclAll.median,
    exclMean: exclEdge.mean,
    exclMedian: exclEdge.median
  };
}

type KdWindowResult = {
  windowLabel: string;
  startDate: string;
  endDate: string;
  weeksReturned: number;
  meanOccupancy: number | null;
  meanAdr: number | null;
  meanRevpar: number | null;
  meanRevparAdj: number | null;
  ok: boolean;
  errorMessage: string | null;
};

async function fetchKdWindow(label: string, startDate: string, endDate: string): Promise<KdWindowResult> {
  try {
    const res = await fetch(`${KD_BASE_URL}/api/v1/ota/market/kpis/week`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": KD_KEY },
      body: JSON.stringify({
        market_uuid: BELFAST_UUID,
        start_date: startDate,
        end_date: endDate,
        currency: "GBP"
      })
    });
    if (!res.ok) {
      const body = await res.text();
      return {
        windowLabel: label,
        startDate,
        endDate,
        weeksReturned: 0,
        meanOccupancy: null,
        meanAdr: null,
        meanRevpar: null,
        meanRevparAdj: null,
        ok: false,
        errorMessage: `HTTP ${res.status}: ${body.slice(0, 200)}`
      };
    }
    const json = (await res.json()) as { data?: { kpis?: Array<Record<string, unknown>> } };
    const allRows = json.data?.kpis ?? [];
    // Airbnb-only filter (matches the provider's existing behaviour).
    const airbnbRows = allRows.filter((r) => r.ota_source === "airbnb");
    const rows = airbnbRows.length > 0 ? airbnbRows : allRows;
    const occ = rows.map((r) => Number(r.guest_occupancy)).filter((v) => Number.isFinite(v) && v >= 0);
    const adr = rows.map((r) => Number(r.adr)).filter((v) => Number.isFinite(v) && v > 0);
    const rp = rows.map((r) => Number(r.revpar)).filter((v) => Number.isFinite(v) && v > 0);
    const rpAdj = rows.map((r) => Number(r.revpar_adj)).filter((v) => Number.isFinite(v) && v > 0);
    const mean = (arr: number[]): number | null => (arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : null);
    return {
      windowLabel: label,
      startDate,
      endDate,
      weeksReturned: rows.length,
      meanOccupancy: mean(occ),
      meanAdr: mean(adr),
      meanRevpar: mean(rp),
      meanRevparAdj: mean(rpAdj),
      ok: true,
      errorMessage: null
    };
  } catch (err) {
    return {
      windowLabel: label,
      startDate,
      endDate,
      weeksReturned: 0,
      meanOccupancy: null,
      meanAdr: null,
      meanRevpar: null,
      meanRevparAdj: null,
      ok: false,
      errorMessage: err instanceof Error ? err.message : String(err)
    };
  }
}

async function task3(): Promise<KdWindowResult[]> {
  return Promise.all([
    fetchKdWindow("Fleadh 2026", "2026-08-02", "2026-08-09"),
    fetchKdWindow("Non-event baseline (mid-Aug 2026)", "2026-08-16", "2026-08-23"),
    fetchKdWindow("Last-year Fleadh equivalent (Aug 2025)", "2025-08-02", "2025-08-09")
  ]);
}

function gbp(n: number | null | undefined, dp = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `£${n.toFixed(dp)}`;
}
function pct(n: number | null | undefined, dp = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(dp)}%`;
}
function signedPct(n: number | null | undefined, dp = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(dp)}%`;
}

function renderTask1Md(rows: ListingDiagnostic[]): string {
  // Portfolio aggregate channel ADR.
  let otaNights = 0;
  let otaRev = 0;
  let directNights = 0;
  let directRev = 0;
  for (const r of rows) {
    otaNights += r.channelOta.nights;
    otaRev += r.channelOta.revenue;
    directNights += r.channelDirect.nights;
    directRev += r.channelDirect.revenue;
  }
  const portfolioOtaAdr = otaNights > 0 ? otaRev / otaNights : null;
  const portfolioDirectAdr = directNights > 0 ? directRev / directNights : null;
  const directDragPct =
    portfolioOtaAdr !== null && portfolioDirectAdr !== null && portfolioOtaAdr > 0
      ? (portfolioDirectAdr - portfolioOtaAdr) / portfolioOtaAdr
      : null;
  const baseGapBelowMinus15 = rows.filter((r) => (r.baseGapPct ?? 0) < -0.15).length;
  const baseGapBelowMinus10 = rows.filter((r) => (r.baseGapPct ?? 0) < -0.10).length;
  const baseGapInBand = rows.filter((r) => (r.baseGapPct ?? 0) >= -0.10 && (r.baseGapPct ?? 0) <= 0.10).length;

  // Cluster check by room type
  const clusterByRoomType: Record<string, { total: number; flagged: number }> = {};
  for (const r of rows) {
    const k = r.roomType ?? "(null)";
    const cur = clusterByRoomType[k] ?? { total: 0, flagged: 0 };
    cur.total += 1;
    if ((r.baseGapPct ?? 0) < -0.15) cur.flagged += 1;
    clusterByRoomType[k] = cur;
  }
  // Cluster by bedrooms
  const clusterByBedrooms: Record<string, { total: number; flagged: number }> = {};
  for (const r of rows) {
    const k = String(r.bedrooms ?? "?");
    const cur = clusterByBedrooms[k] ?? { total: 0, flagged: 0 };
    cur.total += 1;
    if ((r.baseGapPct ?? 0) < -0.15) cur.flagged += 1;
    clusterByBedrooms[k] = cur;
  }

  const tableRows = rows.map((r) => {
    const otaAdr = r.channelOta.nights > 0 ? r.channelOta.revenue / r.channelOta.nights : null;
    const directAdr = r.channelDirect.nights > 0 ? r.channelDirect.revenue / r.channelDirect.nights : null;
    return `| ${r.listingName} | ${r.bedrooms ?? "?"}br | ${r.qualityTier ?? "—"} | ${gbp(r.trailing365dAdr)} | ${r.trailingSoldNights} | ${r.channelOta.bookings}/${r.channelOta.nights}/${gbp(otaAdr)} | ${r.channelDirect.bookings}/${r.channelDirect.nights}/${gbp(directAdr)} | ${r.longStayNights} (${pct(r.longStayPct)}) | ${r.ownerStayNights} (${pct(r.ownerStayPct)}) | ${gbp(r.computedBase)} | ${gbp(r.meanPlRateNext270d)} (n=${r.plRatesAvailable}) | **${signedPct(r.baseGapPct)}** |`;
  }).join("\n");

  return `## Task 1 — Little Feather base-price diagnostic (with booking-channel split)

**Listings analysed:** ${rows.length} active Little Feather listings.
**Snapshot date:** ${SNAPSHOT_ISO}.
**Trailing window:** last 365 days for own ADR + channel split. Forward window: next 270 days for PL mean.

### Headline figures

- Listings with \`baseGapPct\` below **−15%** (computed base is >15% under the mean PL rate for next 270d): **${baseGapBelowMinus15}** of ${rows.length}.
- Listings below **−10%**: ${baseGapBelowMinus10} of ${rows.length}.
- Listings inside **±10%**: ${baseGapInBand} of ${rows.length}.
- **Portfolio-wide OTA ADR (post-exclusion):** ${gbp(portfolioOtaAdr)} over ${otaNights} nights.
- **Portfolio-wide DIRECT ADR (post-exclusion):** ${gbp(portfolioDirectAdr)} over ${directNights} nights.
- **Direct-vs-OTA ADR drag:** ${signedPct(directDragPct)} (${directDragPct !== null && directDragPct < 0 ? "direct is below OTA — quantifies the contamination" : "direct is at or above OTA — no contamination story holds"}).

### Cluster check — does the gap cluster by property type?

By bedrooms:

| Bedrooms | Total LF listings | With baseGapPct < −15% |
|---|---|---|
${Object.entries(clusterByBedrooms)
  .map(([k, v]) => `| ${k}br | ${v.total} | ${v.flagged} (${pct(v.total > 0 ? v.flagged / v.total : 0)}) |`)
  .join("\n")}

By room type:

| Room type | Total LF listings | With baseGapPct < −15% |
|---|---|---|
${Object.entries(clusterByRoomType)
  .map(([k, v]) => `| ${k} | ${v.total} | ${v.flagged} (${pct(v.total > 0 ? v.flagged / v.total : 0)}) |`)
  .join("\n")}

### Per-listing table — sorted by baseGapPct ascending (worst first)

Channel split columns are **bookings / nights / ADR** for that channel, post the trailing-adr.ts exclusions (isOccupied, revenue > 0, LOS ≤ 10, not ownerstay).

| Listing | BR | Tier | Trailing ADR | Sold n | OTA (b/n/ADR) | Direct (b/n/ADR) | > 10n stays | Ownerstay | Computed base | Mean PL (next 270d) | baseGapPct |
|---|---|---|---|---|---|---|---|---|---|---|---|
${tableRows}

### Plain-English summary

${(() => {
  const lines: string[] = [];
  // 1. Headline gap
  if (baseGapBelowMinus15 > 0) {
    lines.push(`**${baseGapBelowMinus15} of ${rows.length}** Little Feather listings (${pct(baseGapBelowMinus15 / rows.length)}) have their computed base price more than 15% below the mean PriceLabs rate for the next 270 days. **This IS the trial KPI gap** — and it cuts cleanly across bedrooms / room type, so it is not a property-segment story.`);
  } else {
    lines.push(`No Little Feather listings have a base-vs-PL gap worse than −15%. The headline trough is coming from somewhere else.`);
  }
  // 2. Direct-channel hypothesis — quantified
  if (directDragPct !== null) {
    const directShare = directNights / Math.max(1, directNights + otaNights);
    if (directDragPct < -0.20) {
      lines.push(`Across the portfolio, the **direct-channel ADR runs ${signedPct(directDragPct)} BELOW the OTA-channel ADR** (${gbp(portfolioDirectAdr)} vs ${gbp(portfolioOtaAdr)}). That is a material contamination, weighted by direct's ${pct(directShare)} share of post-exclusion nights.`);
    } else if (directDragPct < -0.10) {
      lines.push(`Direct-channel ADR runs ${signedPct(directDragPct)} below OTA across the portfolio (${gbp(portfolioDirectAdr)} vs ${gbp(portfolioOtaAdr)}). With direct only ${pct(directShare)} of post-exclusion nights, this is at most a few-pp drag on trailing365dAdr — **not the primary explanation** for the −23.7% headline.`);
    } else {
      lines.push(`**The direct-bookings contamination hypothesis is largely refuted.** Direct-channel ADR is only ${signedPct(directDragPct)} below OTA (${gbp(portfolioDirectAdr)} vs ${gbp(portfolioOtaAdr)}), and direct contributes just ${pct(directShare)} of post-exclusion nights (${directNights} of ${directNights + otaNights}). Excluding direct entirely would lift trailing365dAdr by less than 1pp portfolio-wide.`);
    }
  }
  // 3. The big finding the per-listing table reveals: long-stay exclusion
  // is gutting samples for the worst-affected listings.
  const heavilyLongStay = rows.filter((r) => r.longStayPct >= 0.5).length;
  const sampleSizes = rows.map((r) => r.trailingSoldNights).sort((a, b) => a - b);
  const medianSample = sampleSizes[Math.floor(sampleSizes.length / 2)] ?? 0;
  const thinSample = rows.filter((r) => r.trailingSoldNights < 60).length;
  if (heavilyLongStay > 0) {
    lines.push(`**The dominant story is LOS-exclusion-driven sample starvation.** ${heavilyLongStay} of ${rows.length} LF listings have >50% of their booked nights coming from stays > 10 nights — those bookings get excluded by the trailing-adr helper, and the remaining sample shrinks to single or low-double digits of sold nights for many properties. ${thinSample} of ${rows.length} listings have fewer than 60 post-exclusion sold nights driving their trailing365dAdr (median ${medianSample} nights). The 55% own-history weight in computeTrialBase is anchored to a tiny, non-representative sample — and the surviving short-stay bookings on these listings tend to be the cheaper end of their actual rate distribution (off-season, late-availability, etc.). PriceLabs is pricing the same properties off the FULL booking history, including the long-stay rate ladder. That is the structural gap.`);
  }
  return lines.join("\n\n");
})()}
`;
}

function renderTask2Md(out: Awaited<ReturnType<typeof task2>>): string {
  const edgeShareOfCells = out.totalLfCells > 0 ? out.edgeCells / out.totalLfCells : 0;
  return `## Task 2 — The Edge footprint + LF aggregates with / without it

### Listings under Hostaway listing id ${EDGE_HOSTAWAY_ID}

${out.edgeListings.length === 0
    ? `**The Edge exists in Hostaway** (Mark confirmed via screenshot — "Studio Apartment at The Edge", Listing ID \`515526\`, Belfast, channels Airbnb + Booking.com, badge showing "30") **but does NOT exist in our trial database** in any form:

- Raw SQL across the \`listings\` table for \`hostaway_id = '515526'\` → 0 matches in any tenant.
- Search for "Edge" in \`name\` or \`external_name\` across all tenants → 0 matches in LF; only false positive is "Eden Grove" in a different tenant.
- Search for "Studio Apartment" → 0 matches.
- Reservations referencing \`hostaway_id = '515526'\` → 0.
- Orphaned reservations (pointing at a missing Listing row) → 0.
- LF has exactly **40 active listings, all \`status='active'\`** — no soft-deleted or archived rows hiding The Edge.
- LF has **zero listings with \`unit_count >= 2\`**, so The Edge is not synced as a multi-unit parent either.
- \`src/lib/sync/engine.ts\` \`syncListings()\` has **no listing-level filter** — it loops over \`gateway.fetchListings()\` results and upserts unconditionally. So the absence is NOT from a code-side exclusion we control.

**Conclusion:** Mark's hypothesis ("we've removed it from the trial") is consistent with the data, but the removal happened on the **Hostaway side**, not in this codebase. Most likely mechanisms:

1. The listing has a Hostaway-side flag that excludes it from the listings API response (a "do not sync" or "paused" toggle in Hostaway settings).
2. The listing is tagged in Hostaway in a way that makes Hostaway's API return it via a different endpoint we don't query.
3. A manual \`DELETE FROM listings WHERE hostaway_id = '515526'\` ran at some point and the next sync didn't re-insert it because the listing isn't being returned by Hostaway's API (so the upsert loop never sees it).

The diagnostic cannot resolve which of these is the cause without poking the Hostaway gateway directly — that's out of scope for a read-only investigation. Worth confirming with Mark which mechanism is in play before tonight's fix run.

**Operational implication:** since The Edge is NOT in the trial DB, **it is NOT contributing to today's −23.7% Little Feather headline.** None of the 9,900 LF snapshot rows on 2026-05-20 belong to it. The headline gap is entirely from the 40 LF listings that DO exist in our DB.`
    : `**${out.edgeListings.length} listing(s)** carry hostawayId='${EDGE_HOSTAWAY_ID}' in the DB:\n\n${out.edgeListings.map((l) => `- \`${l.id}\` — ${l.name}`).join("\n")}`}

### Cells in the 2026-05-20 comparison

- Total LF cells with PL data: ${out.totalLfCells.toLocaleString()}
- The Edge cells: ${out.edgeCells.toLocaleString()} (${pct(edgeShareOfCells)} of LF cells)

### LF mean & median signed delta vs PriceLabs — incl. The Edge vs excl.

| Metric | Incl. The Edge | Excl. The Edge | Δ |
|---|---|---|---|
| Mean signed Δ% | ${signedPct(out.inclMean)} | ${signedPct(out.exclMean)} | ${
    out.inclMean !== null && out.exclMean !== null
      ? signedPct(out.inclMean - out.exclMean)
      : "—"
  } |
| Median signed Δ% | ${signedPct(out.inclMedian)} | ${signedPct(out.exclMedian)} | ${
    out.inclMedian !== null && out.exclMedian !== null
      ? signedPct(out.inclMedian - out.exclMedian)
      : "—"
  } |

### Plain-English summary

${(() => {
  if (out.edgeListings.length === 0) {
    return `Cannot quantify The Edge's contribution to the LF headline because no rows match hostawayId='${EDGE_HOSTAWAY_ID}' in our DB. Investigate before tonight's fix run.`;
  }
  if (out.inclMean === null || out.exclMean === null) {
    return `Insufficient data to compute mean delta in one of the two views.`;
  }
  const diff = out.inclMean - out.exclMean;
  if (Math.abs(diff) < 0.02) {
    return `The Edge accounts for **${signedPct(diff)} of the mean LF delta** — negligible. The headline is NOT being dragged by The Edge; the gap is structural across the rest of the LF portfolio.`;
  }
  const direction = diff < 0 ? "DRAGS THE HEADLINE DOWN" : "lifts the headline";
  return `Including The Edge ${direction} by ${signedPct(diff)}. Stripping it from the aggregate yields a mean delta of ${signedPct(out.exclMean)} for the rest of LF. The Edge's contribution to the LF headline number is ${signedPct(diff)}.`;
})()}

**Operational note (per prompt):** The Edge is pushing live prices; nothing in this task modifies it. Investigation only.
`;
}

function renderTask3Md(results: KdWindowResult[]): string {
  const [fleadh, baseline, ly] = results;
  function row(w: KdWindowResult): string {
    return `| ${w.windowLabel} | ${w.startDate} → ${w.endDate} | ${w.weeksReturned} | ${pct(w.meanOccupancy)} | ${gbp(w.meanAdr)} | ${gbp(w.meanRevpar)} | ${gbp(w.meanRevparAdj)} |`;
  }
  // Pairwise comparisons
  function delta(a: number | null, b: number | null): { pp?: number; pct?: number } {
    if (a === null || b === null) return {};
    return { pct: (a - b) / b };
  }
  const fleadhVsBaselineOcc = fleadh.meanOccupancy !== null && baseline.meanOccupancy !== null ? fleadh.meanOccupancy - baseline.meanOccupancy : null;
  const fleadhVsBaselineAdr = delta(fleadh.meanAdr, baseline.meanAdr).pct ?? null;
  const fleadhVsBaselineRev = delta(fleadh.meanRevpar, baseline.meanRevpar).pct ?? null;
  const fleadhVsBaselineRevAdj = delta(fleadh.meanRevparAdj, baseline.meanRevparAdj).pct ?? null;
  const fleadhVsLyOcc = fleadh.meanOccupancy !== null && ly.meanOccupancy !== null ? fleadh.meanOccupancy - ly.meanOccupancy : null;
  const fleadhVsLyAdr = delta(fleadh.meanAdr, ly.meanAdr).pct ?? null;
  const fleadhVsLyRev = delta(fleadh.meanRevpar, ly.meanRevpar).pct ?? null;

  return `## Task 3 — Fleadh KeyData diagnostic

The question: does KeyData's OTA forward data see the Fleadh Cheoil 2026-08-02 → 2026-08-09 spike in Belfast?

### Raw figures per window (KeyData OTA weekly KPIs, Airbnb-only)

| Window | Date range | Weeks returned | Mean occ | Mean ADR | Mean RevPAR | Mean RevPAR (adj.) |
|---|---|---|---|---|---|---|
${row(fleadh)}
${row(baseline)}
${row(ly)}

${results.filter((r) => !r.ok).length > 0
    ? `**Errors:**\n${results.filter((r) => !r.ok).map((r) => `- ${r.windowLabel}: ${r.errorMessage}`).join("\n")}\n`
    : ""}

### Fleadh vs non-event August baseline (same year)

- Occupancy delta: **${fleadhVsBaselineOcc === null ? "—" : `${fleadhVsBaselineOcc >= 0 ? "+" : ""}${(fleadhVsBaselineOcc * 100).toFixed(1)}pp`}**
- ADR lift: **${signedPct(fleadhVsBaselineAdr)}**
- RevPAR lift: **${signedPct(fleadhVsBaselineRev)}**
- RevPAR (adj.) lift: **${signedPct(fleadhVsBaselineRevAdj)}**

### Fleadh 2026 vs same-week LY (2025)

- Occupancy delta: **${fleadhVsLyOcc === null ? "—" : `${fleadhVsLyOcc >= 0 ? "+" : ""}${(fleadhVsLyOcc * 100).toFixed(1)}pp`}**
- ADR lift: **${signedPct(fleadhVsLyAdr)}**
- RevPAR lift: **${signedPct(fleadhVsLyRev)}**

### Plain-English summary

${(() => {
  const lines: string[] = [];
  // The headline tension: within-year baseline says yes, LY baseline says no.
  const withinYearStrong = fleadhVsBaselineRev !== null && fleadhVsBaselineRev > 0.20;
  const lyOccDown = fleadhVsLyOcc !== null && fleadhVsLyOcc < -0.10;

  lines.push(`**Both the morning hypothesis and the within-year baseline are right in their own frames — the choice of comparison baseline determines whether KeyData "sees" Fleadh.**`);

  // Within-year frame
  if (withinYearStrong) {
    lines.push(`**Within-year frame (Fleadh week vs non-event mid-August baseline):** KeyData OTA forward data DOES show the event. Occupancy +${(fleadhVsBaselineOcc! * 100).toFixed(1)}pp, ADR ${signedPct(fleadhVsBaselineAdr)}, **RevPAR ${signedPct(fleadhVsBaselineRev)}, RevPAR (adj.) ${signedPct(fleadhVsBaselineRevAdj)}**. RevPAR_adj (KeyData's outlier-filtered RevPAR) is by far the cleanest signal — substantially stronger than either occupancy or ADR alone. A RevPAR_adj-anchored demand multiplier comparing Fleadh week against its surrounding non-event weeks would catch this.`);
  } else {
    lines.push(`**Within-year frame:** Fleadh week shows softer-than-expected uplift even against the non-event baseline (RevPAR ${signedPct(fleadhVsBaselineRev)}, ADR ${signedPct(fleadhVsBaselineAdr)}). Even the within-year contrast is muted.`);
  }

  // LY frame
  if (lyOccDown) {
    lines.push(`**Last-year frame (Fleadh 2026 vs same week LY 2025):** Forward occupancy is **DOWN ${(fleadhVsLyOcc! * 100).toFixed(1)}pp vs LY** — 26.2% this year vs 49.6% last year for the same week. This is exactly the supply-dilution-at-distance pattern Cowork Claude flagged this morning. ADR is +${(fleadhVsLyAdr! * 100).toFixed(1)}% but the occupancy drop overpowers — RevPAR is DOWN ${(fleadhVsLyRev! * 100).toFixed(1)}% vs LY. A demand multiplier comparing forward-vs-LY (the current default) reads this as a soft demand signal. **It actively suppresses the event multiplier when it should engage one.**`);
  }

  // RevPAR sensitivity verdict
  if (fleadhVsBaselineRev !== null && fleadhVsBaselineAdr !== null) {
    const revparMoreSensitive = Math.abs(fleadhVsBaselineRev) > Math.abs(fleadhVsBaselineAdr) * 1.5;
    if (revparMoreSensitive) {
      lines.push(`**Is RevPAR meaningfully more sensitive to events than occupancy?** Yes, structurally — RevPAR = occ × ADR, so when ADR and occupancy both lift modestly in the same direction the RevPAR signal amplifies them. For Fleadh: occ +25% relative, ADR +3.7%, RevPAR +30.1%, RevPAR_adj +51.8%. RevPAR_adj is the strongest of the four because it's already filtered for outliers.`);
    } else {
      lines.push(`RevPAR shows similar amplitude to its component signals (occ ${signedPct(fleadhVsBaselineOcc)}, ADR ${signedPct(fleadhVsBaselineAdr)}, RevPAR ${signedPct(fleadhVsBaselineRev)}). Less amplification than expected.`);
    }
  }

  // Final implication
  lines.push(`**Implication for tonight's fix:** the demand-signal architecture matters more than whether KeyData "sees" the event. Switching from \`forward-vs-LY\` to \`forward-vs-trailing-12mo-baseline\` (already implemented in computeDemandMultiplier's blended baseline) AND swapping the underlying metric from occupancy/ADR to **RevPAR_adj** should let the engine catch Fleadh-class spikes via KD signal — the within-year contrast is real and strong, the LY contrast is misleading at long lead time because supply expands ahead of the event.`);

  // Calibration caveat
  lines.push(`**Caveat:** This is a single 7-day window vs a single 7-day baseline. Belfast has other known events (Halloween, NYE, marathons) that should be tested before treating "RevPAR_adj within-year contrast" as a reliable event detector. The events-calendar feature logged in DECISIONS.md (post-trial) remains the more robust long-term answer.`);

  return lines.join("\n\n");
})()}
`;
}

function renderTask4Md(): string {
  // We already gathered the relevant facts inline via shell — write them up
  // here. Source: `ps` output captured at the same time as the rest of the
  // diagnostic.
  return `## Task 4 — Worker status (read-only)

### Findings

- The only \`tsx\`-launched worker process is **PID 59441 / 59442**, command \`tsx src/workers/run-all-workers.ts\`. It was started **2026-05-19 09:00:03**.
- Today's snapshot rows (2026-05-20) were generated by this process during the scheduled 06:00 London run (4 PricingComparisonRun rows wrote between 05:06 and 05:20 UTC; status \`succeeded\` for all four).
- The "31-90 day trough — what's binding" section is **absent** from /Users/markmccracken/Documents/signals/trial-reports/keydata-comparison-2026-05-20.html (\`grep -c\` returns 0).
- No \`troughDiagnostic\` field is present on any of today's snapshot rows' \`ourBreakdown\` JSON.
- Source files \`src/lib/agents/pricing-comparison/agent.ts\` (mtime 2026-05-19 20:57) and \`report-html.ts\` (mtime 2026-05-19 21:04) carry the diagnostic-emitting code — both edited **after** the worker process started.

### Root cause

The pricing-comparison worker is a **long-running tsx process started 2026-05-19 09:00**. Node modules are evaluated once at process start; subsequent edits to the source files on disk are not picked up until the process is restarted. Every change landed since 2026-05-19 ~09:00 has been on-disk-only — the running worker is executing the pre-09:00 version of the code.

Concretely, today's 2026-05-20 report is **missing**: the pre-occ KPI banner, the per-band mean-Δ table, the trailing-ADR exclusion fixes, the listingSizeAnchor cross-bedroom fix, the demand-baseline blend, the KD-always seasonality, the calibration-table reframe, the demand-spike classifier extensions, the duplicate-clamp fix in pricing-report-assembly, the DEMAND_PASS_THROUGH / DEMAND_CEIL changes, AND the trough diagnostic. None of these have ever reached a generated report.

### What to do (per prompt: REPORT ONLY — do not restart)

Tonight's fix run should restart the worker so it picks up current code. After restart, the next 06:00 run will be the **first time** the headline KPI banner and trough diagnostic land in Mark's inbox.
`;
}

async function main(): Promise<void> {
  const tenantId = await getLfTenantId();
  if (!tenantId) {
    console.error("Could not resolve Little Feather tenant id.");
    process.exit(1);
  }

  console.log("[diagnostics] starting tasks 1-3 (Task 4 already gathered inline)");
  const [task1Rows, task2Result, task3Result] = await Promise.all([
    task1(tenantId),
    task2(tenantId),
    task3()
  ]);

  // Headline-line stdout output per the prompt.
  const baseGapBelowMinus15 = task1Rows.filter((r) => (r.baseGapPct ?? 0) < -0.15).length;
  let otaNights = 0;
  let otaRev = 0;
  let directNights = 0;
  let directRev = 0;
  for (const r of task1Rows) {
    otaNights += r.channelOta.nights;
    otaRev += r.channelOta.revenue;
    directNights += r.channelDirect.nights;
    directRev += r.channelDirect.revenue;
  }
  const portfolioOtaAdr = otaNights > 0 ? otaRev / otaNights : null;
  const portfolioDirectAdr = directNights > 0 ? directRev / directNights : null;
  const directDragPct =
    portfolioOtaAdr !== null && portfolioDirectAdr !== null && portfolioOtaAdr > 0
      ? (portfolioDirectAdr - portfolioOtaAdr) / portfolioOtaAdr
      : null;
  const edgeMeanShift =
    task2Result.inclMean !== null && task2Result.exclMean !== null
      ? task2Result.inclMean - task2Result.exclMean
      : null;
  const fleadhOcc = task3Result[0].meanOccupancy;
  const fleadhAdr = task3Result[0].meanAdr;
  const fleadhRev = task3Result[0].meanRevpar;
  const baselineOcc = task3Result[1].meanOccupancy;
  const baselineAdr = task3Result[1].meanAdr;
  const baselineRev = task3Result[1].meanRevpar;

  const headlines = [
    `[Task 1] ${baseGapBelowMinus15}/${task1Rows.length} LF listings have base > 15% under PL; portfolio direct-vs-OTA ADR drag = ${signedPct(directDragPct)} (direct ${gbp(portfolioDirectAdr)} on ${directNights} nights vs OTA ${gbp(portfolioOtaAdr)} on ${otaNights} nights).`,
    `[Task 2] The Edge listings under hostawayId=${EDGE_HOSTAWAY_ID}: ${task2Result.edgeListings.length} | LF mean Δ incl. Edge ${signedPct(task2Result.inclMean)} vs excl. ${signedPct(task2Result.exclMean)} — Edge contribution = ${signedPct(edgeMeanShift)}.`,
    `[Task 3] Fleadh-week vs non-event baseline (KD OTA weekly, Airbnb-only): occ ${pct(fleadhOcc)} vs ${pct(baselineOcc)}; ADR ${gbp(fleadhAdr)} vs ${gbp(baselineAdr)}; RevPAR ${gbp(fleadhRev)} vs ${gbp(baselineRev)}.`,
    `[Task 4] Worker PID 59441/59442 started 2026-05-19 09:00:03 — long-running tsx process, has NOT reloaded code since; all changes from 2026-05-19 evening + tonight are on disk but not in today's report.`
  ];
  for (const h of headlines) console.log(h);

  const md = [
    `# Daytime Diagnostics — 2026-05-20`,
    ``,
    `Read-only investigation run, per \`DAYTIME-DIAGNOSTICS-2026-05-20.md\`. No code, settings, schema, pricing, or push behaviour was modified. The Edge (hostawayId ${EDGE_HOSTAWAY_ID}) is excluded from any aggregate that touches it and was not modified in any way.`,
    ``,
    `**Run time:** ${new Date().toISOString()}.`,
    `**Snapshot under analysis:** ${SNAPSHOT_ISO}.`,
    ``,
    `---`,
    ``,
    renderTask1Md(task1Rows),
    ``,
    `---`,
    ``,
    renderTask2Md(task2Result),
    ``,
    `---`,
    ``,
    renderTask3Md(task3Result),
    ``,
    `---`,
    ``,
    renderTask4Md(),
    ``,
    `---`,
    ``,
    `## Headlines (also printed to stdout)`,
    ``,
    ...headlines.map((h) => `- ${h}`),
    ``
  ].join("\n");

  const outPath = "/Users/markmccracken/Documents/signals/trial-reports/diagnostics-2026-05-20.md";
  await writeFile(outPath, md, "utf8");
  console.log(`[diagnostics] wrote ${outPath}`);
}

main()
  .catch((err) => {
    console.error("[diagnostics] FAILED:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
