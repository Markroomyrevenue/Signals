/**
 * The seven learnings — DB wrappers + aggregator (SIGNALS-OBSERVE-LEARN-SPEC.md §6).
 *
 * Each wrapper loads tenant-scoped, read-only data and delegates the math to the
 * pure cores in `learnings-core.ts`. `computeClientLearnings` runs them all,
 * skipping #5 (engine reaction) for the Hostaway-fallback client (no engine API
 * to diff). Reuses existing aggregates (NightFact, DailyAgg, Reservation,
 * EngineSnapshot/EngineChange) — no duplicate aggregation.
 */

import { addUtcDays, fromDateOnly, toDateOnly } from "@/lib/metrics/helpers";
import { prisma } from "@/lib/prisma";

import { computePromoGap, type PromoGapLearning } from "./actual-paid";
import { normaliseCityKey } from "./cohorts";
import { computePickupVelocity, type PickupLearning } from "./pickup";
import {
  REGRET_NEAR_ZERO_REVENUE,
  cancellationQuality,
  classifyEngineReaction,
  computeSettledRegret,
  leadTimeDistribution,
  nearestMinAt,
  leadTimeByMarket,
  netRealisedRate,
  pricingPowerByDateType,
  type CancellationQuality,
  type DateType,
  type EngineReaction,
  type LeadTimeDistribution,
  type NetRealisedRate,
  type PricingPowerByDateType,
  type RegretBaselineSource,
  type RegretSummary,
  type SettledNight
} from "./learnings-core";

const TRAILING_DAYS = 365;
/** Regret is judged over SETTLED nights in this trailing window. */
export const REGRET_SETTLED_DAYS = 90;
/** Minimum last-year listing-nights before the pace YoY baseline is trusted. */
const REGRET_PACE_BASELINE_MIN_NIGHTS = 30;

/** Coarse date-type tagging. Weekend = Fri/Sat night; a few fixed UK/NI holidays. */
export function dateTypeFor(dateOnly: string): DateType {
  const mmdd = dateOnly.slice(5);
  // Fixed-date UK/NI holidays that reliably carry pricing power.
  if (["12-24", "12-25", "12-26", "12-31", "01-01", "07-12", "03-17"].includes(mmdd)) return "holiday";
  const dow = fromDateOnly(dateOnly).getUTCDay(); // 0 Sun … 6 Sat
  return dow === 5 || dow === 6 ? "weekend" : "weekday";
}

export type EngineReactionLearning = {
  available: boolean;
  reason?: string;
  reactions: Record<EngineReaction, number>;
  sampled: number;
};

/** Canonical keys for learnings #1-#7 in spec order, plus #8 (promo gap,
 * added by build prompt 07 Part B — the actual-paid signal). */
export const LEARNING_KEYS = [
  "pickup_velocity",
  "lead_time",
  "regret",
  "pricing_power",
  "engine_reaction",
  "net_realised",
  "cancellation",
  "promo_gap"
] as const;
export type LearningKey = (typeof LEARNING_KEYS)[number];

/**
 * One ledger entry per learning per run: the sample count the learning used,
 * or WHY it produced nothing. A null learning and a computed learning look
 * identical in the logs — this is the starvation-visibility record (prod ran
 * six green runs with pricing power null for every client because daily_aggs
 * had 0 rows, and nothing surfaced it).
 */
export type LearningLedgerEntry = {
  learning: LearningKey;
  sampleCount: number | null;
  nullReason: string | null;
};

export type ClientLearnings = {
  tenantId: string;
  engine: string;
  computedAt: string;
  /** Learning #1 — moved-vs-control pickup velocity (weekly settle only). */
  pickup: PickupLearning | null;
  leadTime: LeadTimeDistribution | null;
  /** Learning #2 stratified per market (normalised `Listing.city`), gated at
   *  `MARKET_LEAD_MIN_NIGHTS` — feeds the market-stratified global doc. */
  leadTimeByMarket: Record<string, LeadTimeDistribution> | null;
  regret: RegretSummary | null;
  pricingPower: PricingPowerByDateType | null;
  engineReaction: EngineReactionLearning;
  netRealised: NetRealisedRate | null;
  cancellation: CancellationQuality | null;
  /** Learning #8 — actual-paid promo gap (weekly settle only, like #6). */
  promoGap: PromoGapLearning | null;
  /** Per-learning sample counts / null-reasons for this run (#1-#8). */
  ledger: LearningLedgerEntry[];
};

/**
 * A per-tenant MARKET (normalised `Listing.city`) lead curve needs this many
 * occupied nights before it is published. Prod calibration (trailing 365d,
 * 2026-07-04): belfast 31,289 nights (3 tenants), enniskillen 3,889, ayr
 * 2,989, troon 2,695 — the real markets clear 300 comfortably; one-listing
 * villages (median listing ~200-300 nights/yr) fall out rather than
 * publishing a single listing's curve as "the market".
 */
export const MARKET_LEAD_MIN_NIGHTS = 300;

/** Learning #2 — lead-time curve from trailing booked NightFacts, plus the
 * per-market stratification (normalised city key, gated). One fact scan. */
export async function computeLeadTime(tenantId: string): Promise<{
  leadTime: LeadTimeDistribution | null;
  leadTimeByMarket: Record<string, LeadTimeDistribution> | null;
}> {
  const since = addUtcDays(fromDateOnly(toDateOnly(new Date())), -TRAILING_DAYS);
  const rows = await prisma.nightFact.findMany({
    where: { tenantId, isOccupied: true, leadTimeDays: { not: null }, date: { gte: since } },
    select: { leadTimeDays: true, listingId: true }
  });
  if (rows.length === 0) return { leadTime: null, leadTimeByMarket: null };

  const listingIds = [...new Set(rows.map((r) => r.listingId))];
  const listings = await prisma.listing.findMany({
    where: { tenantId, id: { in: listingIds } },
    select: { id: true, city: true }
  });
  const marketByListing = new Map(listings.map((l) => [l.id, normaliseCityKey(l.city)]));

  const byMarket = leadTimeByMarket(
    rows.map((r) => ({ leadDays: r.leadTimeDays as number, market: marketByListing.get(r.listingId) ?? null })),
    MARKET_LEAD_MIN_NIGHTS
  );
  return {
    leadTime: leadTimeDistribution(rows.map((r) => r.leadTimeDays as number)),
    leadTimeByMarket: Object.keys(byMarket).length > 0 ? byMarket : null
  };
}

/** Learning #4 — pricing power by date type from DailyAgg occupancy + rate. */
export async function computePricingPower(tenantId: string): Promise<PricingPowerByDateType | null> {
  const today = fromDateOnly(toDateOnly(new Date()));
  const since = addUtcDays(today, -TRAILING_DAYS);
  const rows = await prisma.dailyAgg.findMany({
    where: { tenantId, date: { gte: since, lt: today }, availableNights: { gt: 0 } },
    select: { date: true, occupiedNights: true, liveRateAvg: true }
  });
  if (rows.length === 0) return null;
  return pricingPowerByDateType(
    rows.map((r) => ({
      dateType: dateTypeFor(toDateOnly(r.date)),
      occupied: r.occupiedNights > 0,
      rate: r.liveRateAvg === null ? null : Number(r.liveRateAvg)
    }))
  );
}

/**
 * Seasonal expectation of empties for the regret window. Preferred baseline:
 * same-week-last-year (window shifted back 364 days, keeping the day-of-week
 * alignment) from the existing PaceSnapshot data — a (listing, stayDate) with
 * on-books nights at the snapshot taken ON the stay date counts as sold; the
 * denominator is active-listing-nights (listings with any pace row in that
 * window). Fallback: a trailing same-DOW empty rate from DailyAgg over the
 * year BEFORE the regret window. Both are read-only. Multi-unit listings are
 * treated at listing-night granularity (undercounts empties — conservative).
 */
async function regretEmptyBaseline(args: {
  tenantId: string;
  since: Date;
  today: Date;
  /** Date-only strings of every observable settled night in the window. */
  observableDates: string[];
}): Promise<{ expectedEmpties: number | null; baselineSource: RegretBaselineSource }> {
  const windowDays = Math.round((args.today.getTime() - args.since.getTime()) / (24 * 60 * 60 * 1000));

  // Same-week-last-year from PaceSnapshot (READ-ONLY; pace writing untouched).
  const lyStart = addUtcDays(args.since, -364);
  const lyEnd = addUtcDays(args.today, -364);
  const paceRows = await prisma.paceSnapshot.findMany({
    where: {
      tenantId: args.tenantId,
      stayDate: { gte: lyStart, lt: lyEnd },
      snapshotDate: { gte: lyStart, lt: lyEnd }
    },
    select: { listingId: true, stayDate: true, snapshotDate: true, nightsOnBooks: true }
  });
  const activeListingsLy = new Set(paceRows.map((r) => r.listingId));
  const observableLy = activeListingsLy.size * windowDays;
  if (observableLy >= REGRET_PACE_BASELINE_MIN_NIGHTS) {
    const soldLy = new Set(
      paceRows
        .filter((r) => toDateOnly(r.snapshotDate) === toDateOnly(r.stayDate) && r.nightsOnBooks > 0)
        .map((r) => `${r.listingId}|${toDateOnly(r.stayDate)}`)
    ).size;
    const emptyRate = Math.min(1, Math.max(0, 1 - soldLy / observableLy));
    return { expectedEmpties: emptyRate * args.observableDates.length, baselineSource: "pace_yoy" };
  }

  // Fallback: trailing same-DOW empty rate from DailyAgg, EXCLUDING the regret
  // window itself (a baseline drawn from the window would make excess ≡ 0).
  const aggRows = await prisma.dailyAgg.findMany({
    where: {
      tenantId: args.tenantId,
      date: { gte: addUtcDays(args.today, -TRAILING_DAYS), lt: args.since },
      availableNights: { gt: 0 }
    },
    select: { date: true, occupiedNights: true, availableNights: true }
  });
  if (aggRows.length > 0) {
    const byDow = new Map<number, { avail: number; occ: number }>();
    for (const r of aggRows) {
      const dow = r.date.getUTCDay();
      const cur = byDow.get(dow) ?? { avail: 0, occ: 0 };
      cur.avail += r.availableNights;
      cur.occ += r.occupiedNights;
      byDow.set(dow, cur);
    }
    const totalAvail = [...byDow.values()].reduce((s, v) => s + v.avail, 0);
    const totalOcc = [...byDow.values()].reduce((s, v) => s + v.occ, 0);
    const overallRate = totalAvail > 0 ? Math.max(0, (totalAvail - totalOcc) / totalAvail) : 0;
    const rateForDow = (dow: number): number => {
      const v = byDow.get(dow);
      return v && v.avail > 0 ? Math.max(0, (v.avail - v.occ) / v.avail) : overallRate;
    };
    const expected = args.observableDates.reduce((s, d) => s + rateForDow(fromDateOnly(d).getUTCDay()), 0);
    return { expectedEmpties: expected, baselineSource: "trailing_dow" };
  }

  return { expectedEmpties: null, baselineSource: "none" };
}

/**
 * Learning #3 — regret over SETTLED nights only (stay date passed; outcome
 * known). Held-too-high: nights that expired empty in the trailing window IN
 * EXCESS of a seasonal expectation. Held-too-low: sold at/below the engine min
 * in force NEAR the booking date (nearest EngineSnapshot by capturedAt — not
 * the latest), at an unusually long lead. The gross booked nightly rate comes
 * from Reservation.accommodationFare / nights, never the discount-spread
 * `revenueAllocated`. Near-zero-revenue nights (owner blocks, artefact rows)
 * are excluded from every input. `heldTooLow` is null (not 0) when the tenant
 * has no engine min data, so the shares can never be pinned by construction.
 */
export async function computeRegret(tenantId: string, now = new Date()): Promise<RegretSummary | null> {
  const today = fromDateOnly(toDateOnly(now));
  const since = addUtcDays(today, -REGRET_SETTLED_DAYS);

  const [bookedRows, pastAvail] = await Promise.all([
    prisma.nightFact.findMany({
      where: { tenantId, isOccupied: true, date: { gte: since, lt: today } },
      select: {
        listingId: true,
        date: true,
        leadTimeDays: true,
        revenueAllocated: true,
        reservation: { select: { accommodationFare: true, nights: true, createdAt: true } }
      }
    }),
    // A PAST calendar night still marked available expired empty (owner blocks
    // are available=false, so they are structurally excluded here).
    prisma.calendarRate.findMany({
      where: { tenantId, available: true, date: { gte: since, lt: today } },
      select: { listingId: true, date: true }
    })
  ]);

  // Subtract EVERY occupied night (even near-zero-revenue ones) from the empty
  // set so an excluded booked night cannot double-count as an empty.
  const occupiedKey = new Set(bookedRows.map((r) => `${r.listingId}|${toDateOnly(r.date)}`));
  const emptyRows = pastAvail.filter((r) => !occupiedKey.has(`${r.listingId}|${toDateOnly(r.date)}`));

  const usableBooked = bookedRows.filter((r) => Number(r.revenueAllocated) > REGRET_NEAR_ZERO_REVENUE);

  const leads = usableBooked
    .map((r) => r.leadTimeDays)
    .filter((d): d is number => d !== null && d >= 0)
    .sort((a, b) => a - b);
  const medianLead = leads.length > 0 ? leads[Math.floor(leads.length / 2)] : null;

  // Engine mins per listing, kept as a time series so each booking is compared
  // against the min in force near ITS booking date (anachronism guard).
  const minSnaps = await prisma.engineSnapshot.findMany({
    where: { tenantId, min: { not: null }, listingId: { not: null } },
    select: { listingId: true, min: true, capturedAt: true },
    orderBy: { capturedAt: "asc" },
    take: 5000
  });
  const snapsByListing = new Map<string, Array<{ capturedAt: Date; min: number }>>();
  for (const s of minSnaps) {
    const listingId = s.listingId as string;
    const list = snapsByListing.get(listingId) ?? [];
    list.push({ capturedAt: s.capturedAt, min: Number(s.min) });
    snapsByListing.set(listingId, list);
  }
  const minDataAvailable = snapsByListing.size > 0;

  const observableDates = [
    ...usableBooked.map((r) => toDateOnly(r.date)),
    ...emptyRows.map((r) => toDateOnly(r.date))
  ];
  const { expectedEmpties, baselineSource } = await regretEmptyBaseline({
    tenantId,
    since,
    today,
    observableDates
  });

  const nights: SettledNight[] = [
    ...usableBooked.map((r): SettledNight => {
      const res = r.reservation;
      const grossNightlyRate = res && res.nights > 0 ? Number(res.accommodationFare) / res.nights : null;
      const snaps = snapsByListing.get(r.listingId);
      const minInForce = res && snaps ? nearestMinAt(snaps, res.createdAt) : null;
      return {
        booked: true,
        revenueAllocated: Number(r.revenueAllocated),
        leadDays: r.leadTimeDays,
        grossNightlyRate,
        minInForce
      };
    }),
    ...emptyRows.map(
      (): SettledNight => ({
        booked: false,
        revenueAllocated: null,
        leadDays: null,
        grossNightlyRate: null,
        minInForce: null
      })
    )
  ];

  return computeSettledRegret({
    nights,
    baselineMedianLead: medianLead,
    expectedEmpties,
    baselineSource,
    windowDays: REGRET_SETTLED_DAYS,
    minDataAvailable
  });
}

/**
 * Learning #5 — engine reaction (PriceLabs/Wheelhouse only). For each recent
 * human EngineChange (source owner|mark), find the engine's value afterward and
 * classify claw_back / fight / hold. Gracefully empty for hostaway-scan.
 */
export async function computeEngineReaction(args: {
  tenantId: string;
  engine: string;
}): Promise<EngineReactionLearning> {
  const empty: Record<EngineReaction, number> = { claw_back: 0, fight: 0, hold: 0, unknown: 0 };
  if (args.engine === "hostaway-scan") {
    return { available: false, reason: "no engine API (hostaway-scan fallback)", reactions: empty, sampled: 0 };
  }

  const humanMoves = await prisma.engineChange.findMany({
    where: { tenantId: args.tenantId, source: { in: ["owner", "mark"] }, lever: { in: ["base_price", "min", "max"] } },
    orderBy: { detectedAt: "desc" },
    take: 200,
    select: { engineListingId: true, lever: true, oldValue: true, newValue: true, detectedAt: true }
  });

  const reactions = { ...empty };
  let sampled = 0;
  for (const move of humanMoves) {
    const after = await prisma.engineSnapshot.findFirst({
      where: { tenantId: args.tenantId, engineListingId: move.engineListingId, capturedAt: { gt: move.detectedAt } },
      orderBy: { capturedAt: "asc" },
      select: { base: true, min: true, max: true }
    });
    if (!after) continue;
    const afterVal =
      move.lever === "base_price" ? after.base : move.lever === "min" ? after.min : after.max;
    const reaction = classifyEngineReaction({
      oldValue: move.oldValue === null ? null : Number(move.oldValue),
      newValue: move.newValue === null ? null : Number(move.newValue),
      engineAfter: afterVal === null ? null : Number(afterVal)
    });
    reactions[reaction] += 1;
    sampled += 1;
  }
  return { available: true, reactions, sampled };
}

/**
 * Learning #6 — net realised rate from Reservation financials (weekly settle).
 * Returns the value plus the reservation count it was computed from, so the
 * learning ledger can record the sample size (or that the source was empty).
 */
export async function computeNetRealised(
  tenantId: string
): Promise<{ value: NetRealisedRate | null; sampled: number }> {
  const since = addUtcDays(fromDateOnly(toDateOnly(new Date())), -90);
  const rows = await prisma.reservation.findMany({
    where: { tenantId, cancelledAt: null, arrival: { gte: since } },
    select: { accommodationFare: true, commission: true, guestFee: true, nights: true }
  });
  if (rows.length === 0) return { value: null, sampled: 0 };
  let gross = 0;
  let fees = 0;
  let nights = 0;
  for (const r of rows) {
    gross += Number(r.accommodationFare);
    fees += Number(r.commission) + Number(r.guestFee);
    nights += r.nights;
  }
  return { value: netRealisedRate({ grossRevenue: gross, discounts: 0, fees, nights }), sampled: rows.length };
}

/**
 * Learning #7 — cancellation quality vs win-price percentile. Returns the value
 * plus the reservation count, so the ledger can record how thin the source was
 * when the learning abstains (fewer than 10 reservations).
 */
export async function computeCancellationQuality(
  tenantId: string
): Promise<{ value: CancellationQuality | null; sampled: number }> {
  const since = addUtcDays(fromDateOnly(toDateOnly(new Date())), -TRAILING_DAYS);
  const rows = await prisma.reservation.findMany({
    where: { tenantId, arrival: { gte: since }, nights: { gt: 0 } },
    select: { accommodationFare: true, nights: true, cancelledAt: true }
  });
  if (rows.length < 10) return { value: null, sampled: rows.length };

  const perNight = rows.map((r) => ({
    rate: Number(r.accommodationFare) / r.nights,
    cancelled: r.cancelledAt !== null
  }));
  const sortedRates = perNight.map((p) => p.rate).sort((a, b) => a - b);
  const percentileOf = (rate: number): number => {
    let lo = 0;
    for (const v of sortedRates) {
      if (v < rate) lo += 1;
      else break;
    }
    return sortedRates.length > 1 ? lo / (sortedRates.length - 1) : 0.5;
  };
  return {
    value: cancellationQuality(
      perNight.map((p) => ({ winPricePercentile: percentileOf(p.rate), cancelled: p.cancelled }))
    ),
    sampled: rows.length
  };
}

/**
 * Build the per-run ledger entries for learnings #1-#7 from the computed
 * results. Pure — unit-testable on fixtures. Every learning gets exactly one
 * entry: a sample count when it produced a value, a `nullReason` when it did
 * not (so starvation is visible, not silent).
 */
export function buildLearningLedger(args: {
  leadTime: LeadTimeDistribution | null;
  regret: RegretSummary | null;
  pricingPower: PricingPowerByDateType | null;
  engineReaction: EngineReactionLearning;
  netRealised: { value: NetRealisedRate | null; sampled: number } | null;
  cancellation: { value: CancellationQuality | null; sampled: number };
  /** #8 — null on daily runs (settle-only, like #6). */
  promoGap: PromoGapLearning | null;
  /** #1 — null on daily runs (settle-only; measured on PeerControl rows). */
  pickup: PickupLearning | null;
  includeNetRealised: boolean;
}): LearningLedgerEntry[] {
  const entries: LearningLedgerEntry[] = [];

  // #1 pickup velocity — measured on the weekly settle from the peer-control
  // rows whose 7-day pickup window has elapsed (build prompt 07 Part B). The
  // sample is measured events WITH a recorded control set.
  if (!args.includeNetRealised || args.pickup === null) {
    entries.push({
      learning: "pickup_velocity",
      sampleCount: null,
      nullReason: "not computed on the daily run (weekly settle only)"
    });
  } else if (args.pickup.eventsWithControl === 0) {
    entries.push({
      learning: "pickup_velocity",
      sampleCount: 0,
      nullReason:
        `no measured price-change events with a peer control yet ` +
        `(measured=${args.pickup.eventsMeasured}; the ${args.pickup.windowDays}-day pickup window must pass first)`
    });
  } else {
    entries.push({ learning: "pickup_velocity", sampleCount: args.pickup.eventsWithControl, nullReason: null });
  }

  // #2 lead time.
  entries.push(
    args.leadTime
      ? { learning: "lead_time", sampleCount: args.leadTime.n, nullReason: null }
      : { learning: "lead_time", sampleCount: 0, nullReason: "no occupied night facts with a lead time in trailing 365d" }
  );

  // #3 regret.
  entries.push(
    args.regret
      ? { learning: "regret", sampleCount: args.regret.total, nullReason: null }
      : { learning: "regret", sampleCount: 0, nullReason: `no settled nights in trailing ${REGRET_SETTLED_DAYS}d` }
  );

  // #4 pricing power.
  entries.push(
    args.pricingPower
      ? {
          learning: "pricing_power",
          sampleCount: Object.values(args.pricingPower).reduce((s, v) => s + v.n, 0),
          nullReason: null
        }
      : { learning: "pricing_power", sampleCount: 0, nullReason: "daily_aggs empty — no rows in trailing 365d" }
  );

  // #5 engine reaction.
  if (!args.engineReaction.available) {
    entries.push({
      learning: "engine_reaction",
      sampleCount: null,
      nullReason: args.engineReaction.reason ?? "engine reaction unavailable"
    });
  } else if (args.engineReaction.sampled === 0) {
    entries.push({
      learning: "engine_reaction",
      sampleCount: 0,
      nullReason: "no engine changes — no human moves (owner/mark) with a following snapshot"
    });
  } else {
    entries.push({ learning: "engine_reaction", sampleCount: args.engineReaction.sampled, nullReason: null });
  }

  // #6 net realised. On daily runs it is not computed at all (weekly settle
  // only) — that must be recorded, or the daily profile write looks like it
  // legitimately produced null and the settle's value silently disappears.
  if (!args.includeNetRealised || args.netRealised === null) {
    entries.push({
      learning: "net_realised",
      sampleCount: null,
      nullReason: "not computed on the daily run (weekly settle only)"
    });
  } else if (args.netRealised.value === null) {
    entries.push({
      learning: "net_realised",
      sampleCount: 0,
      nullReason: "no uncancelled reservations arriving in trailing 90d"
    });
  } else {
    entries.push({ learning: "net_realised", sampleCount: args.netRealised.sampled, nullReason: null });
  }

  // #7 cancellation quality.
  entries.push(
    args.cancellation.value
      ? { learning: "cancellation", sampleCount: args.cancellation.sampled, nullReason: null }
      : {
          learning: "cancellation",
          sampleCount: args.cancellation.sampled,
          nullReason: `fewer than 10 reservations in trailing 365d (n=${args.cancellation.sampled})`
        }
  );

  // #8 promo gap — settle-only, like #6. The sample is bookings with a
  // resolvable listed rate near booking (the gap observations).
  if (!args.includeNetRealised || args.promoGap === null) {
    entries.push({
      learning: "promo_gap",
      sampleCount: null,
      nullReason: "not computed on the daily run (weekly settle only)"
    });
  } else if (args.promoGap.withListedRate === 0) {
    entries.push({
      learning: "promo_gap",
      sampleCount: 0,
      nullReason: `no bookings in trailing ${args.promoGap.windowDays}d with a scanned listed rate to compare against`
    });
  } else {
    entries.push({ learning: "promo_gap", sampleCount: args.promoGap.withListedRate, nullReason: null });
  }

  return entries;
}

/**
 * Append this run's ledger entries (one per learning) to the append-only
 * `observe_learning_ledger` table. Tenant-scoped. Returns the rows written.
 */
export async function writeLearningLedger(args: {
  tenantId: string;
  clientKey: string;
  runAt: Date;
  entries: LearningLedgerEntry[];
}): Promise<number> {
  if (args.entries.length === 0) return 0;
  const result = await prisma.observeLearningLedger.createMany({
    data: args.entries.map((e) => ({
      tenantId: args.tenantId,
      clientKey: args.clientKey,
      runAt: args.runAt,
      learning: e.learning,
      sampleCount: e.sampleCount,
      nullReason: e.nullReason
    }))
  });
  return result.count;
}

/**
 * Run all seven learnings for a client. `includeNetRealised` is true on the
 * weekly settle (learning #6 lands there, spec §10). Read-only + tenant-scoped.
 * The returned `ledger` records, per learning, the sample count used or why it
 * produced nothing — the caller persists it via `writeLearningLedger`.
 */
export async function computeClientLearnings(args: {
  tenantId: string;
  engine: string;
  includeNetRealised?: boolean;
  now?: Date;
}): Promise<ClientLearnings> {
  const { tenantId, engine } = args;
  const includeNetRealised = args.includeNetRealised ?? false;
  const [leadTimeLearning, pricingPower, regret, engineReaction, cancellation, netRealised, promoGap, pickup] =
    await Promise.all([
      computeLeadTime(tenantId),
      computePricingPower(tenantId),
      computeRegret(tenantId, args.now),
      computeEngineReaction({ tenantId, engine }),
      computeCancellationQuality(tenantId),
      includeNetRealised
        ? computeNetRealised(tenantId)
        : Promise.resolve<{ value: NetRealisedRate | null; sampled: number } | null>(null),
      includeNetRealised
        ? computePromoGap({ tenantId, now: args.now }).then((r) => r.learning)
        : Promise.resolve<PromoGapLearning | null>(null),
      includeNetRealised
        ? computePickupVelocity(tenantId, args.now)
        : Promise.resolve<PickupLearning | null>(null)
    ]);

  const leadTime = leadTimeLearning.leadTime;
  const ledger = buildLearningLedger({
    leadTime,
    regret,
    pricingPower,
    engineReaction,
    netRealised,
    cancellation,
    promoGap,
    pickup,
    includeNetRealised
  });

  return {
    tenantId,
    engine,
    computedAt: (args.now ?? new Date()).toISOString(),
    pickup,
    leadTime,
    leadTimeByMarket: leadTimeLearning.leadTimeByMarket,
    regret,
    pricingPower,
    engineReaction,
    netRealised: netRealised?.value ?? null,
    cancellation: cancellation.value,
    promoGap,
    ledger
  };
}
