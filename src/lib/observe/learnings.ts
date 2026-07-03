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

import {
  cancellationQuality,
  classifyEngineReaction,
  leadTimeDistribution,
  netRealisedRate,
  pricingPowerByDateType,
  type CancellationQuality,
  type DateType,
  type EngineReaction,
  type LeadTimeDistribution,
  type NetRealisedRate,
  type PricingPowerByDateType,
  type RegretSummary
} from "./learnings-core";

const TRAILING_DAYS = 365;
const REGRET_FORWARD_DAYS = 7;

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

/** Canonical keys for learnings #1-#7, in spec order. */
export const LEARNING_KEYS = [
  "pickup_velocity",
  "lead_time",
  "regret",
  "pricing_power",
  "engine_reaction",
  "net_realised",
  "cancellation"
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
  leadTime: LeadTimeDistribution | null;
  regret: RegretSummary | null;
  pricingPower: PricingPowerByDateType | null;
  engineReaction: EngineReactionLearning;
  netRealised: NetRealisedRate | null;
  cancellation: CancellationQuality | null;
  /** Per-learning sample counts / null-reasons for this run (#1-#7). */
  ledger: LearningLedgerEntry[];
};

/** Learning #2 — lead-time curve from trailing booked NightFacts. */
export async function computeLeadTime(tenantId: string): Promise<LeadTimeDistribution | null> {
  const since = addUtcDays(fromDateOnly(toDateOnly(new Date())), -TRAILING_DAYS);
  const rows = await prisma.nightFact.findMany({
    where: { tenantId, isOccupied: true, leadTimeDays: { not: null }, date: { gte: since } },
    select: { leadTimeDays: true }
  });
  if (rows.length === 0) return null;
  return leadTimeDistribution(rows.map((r) => r.leadTimeDays as number));
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
 * Learning #3 — regret. Held-too-high: forward available-unbooked nights inside
 * the wire window. Held-too-low: booked nights at/below the listing's min that
 * landed faster than half the typical lead. Combines both into one tally.
 */
export async function computeRegret(tenantId: string): Promise<RegretSummary | null> {
  const today = fromDateOnly(toDateOnly(new Date()));
  const wireEnd = addUtcDays(today, REGRET_FORWARD_DAYS);

  // Held-too-high: forward available nights with no occupied NightFact.
  const [forwardAvail, forwardOccupied] = await Promise.all([
    prisma.calendarRate.findMany({
      where: { tenantId, available: true, date: { gte: today, lte: wireEnd } },
      select: { listingId: true, date: true, rate: true }
    }),
    prisma.nightFact.findMany({
      where: { tenantId, isOccupied: true, date: { gte: today, lte: wireEnd } },
      select: { listingId: true, date: true }
    })
  ]);
  const occupiedKey = new Set(forwardOccupied.map((r) => `${r.listingId}|${toDateOnly(r.date)}`));
  const heldTooHigh = forwardAvail.filter(
    (r) => Number(r.rate) > 0 && !occupiedKey.has(`${r.listingId}|${toDateOnly(r.date)}`)
  ).length;

  // Held-too-low: booked cheap + early in the trailing 90d.
  const since = addUtcDays(today, -90);
  const leadRows = await prisma.nightFact.findMany({
    where: { tenantId, isOccupied: true, leadTimeDays: { not: null }, date: { gte: since, lt: today } },
    select: { leadTimeDays: true }
  });
  const leads = leadRows.map((r) => r.leadTimeDays as number).filter((d) => d >= 0).sort((a, b) => a - b);
  const medianLead = leads.length > 0 ? leads[Math.floor(leads.length / 2)] : null;

  let heldTooLow = 0;
  if (medianLead !== null && medianLead > 0) {
    // Per-listing min proxy from latest engine snapshot, else null (skip).
    const minSnaps = await prisma.engineSnapshot.findMany({
      where: { tenantId, min: { not: null } },
      orderBy: { capturedAt: "desc" },
      select: { listingId: true, min: true },
      take: 2000
    });
    const minByListing = new Map<string, number>();
    for (const s of minSnaps) {
      if (s.listingId && !minByListing.has(s.listingId)) minByListing.set(s.listingId, Number(s.min));
    }
    if (minByListing.size > 0) {
      // Booked far earlier than typical (snapped up ahead) AND at/below min.
      const cheapEarly = await prisma.nightFact.findMany({
        where: {
          tenantId,
          isOccupied: true,
          leadTimeDays: { not: null, gte: Math.ceil(medianLead * 1.5) },
          date: { gte: since, lt: today }
        },
        select: { listingId: true, revenueAllocated: true }
      });
      heldTooLow = cheapEarly.filter((r) => {
        const min = minByListing.get(r.listingId);
        return min !== undefined && Number(r.revenueAllocated) <= min * 1.05;
      }).length;
    }
  }

  const total = heldTooHigh + heldTooLow;
  if (total === 0 && forwardAvail.length === 0) return null;
  return { heldTooLow, heldTooHigh, none: 0, total };
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
  includeNetRealised: boolean;
}): LearningLedgerEntry[] {
  const entries: LearningLedgerEntry[] = [];

  // #1 pickup velocity — the pure core exists but is never wired into this
  // aggregator (peer-control pickups are not measured). Recorded so the gap is
  // visible in the starvation matrix rather than silently absent.
  entries.push({
    learning: "pickup_velocity",
    sampleCount: null,
    nullReason: "not wired — pickupVelocity core is never computed (peer-control pickups not measured)"
  });

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
      : { learning: "regret", sampleCount: 0, nullReason: "no forward available nights and no regret events" }
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
  const [leadTime, pricingPower, regret, engineReaction, cancellation, netRealised] = await Promise.all([
    computeLeadTime(tenantId),
    computePricingPower(tenantId),
    computeRegret(tenantId),
    computeEngineReaction({ tenantId, engine }),
    computeCancellationQuality(tenantId),
    includeNetRealised
      ? computeNetRealised(tenantId)
      : Promise.resolve<{ value: NetRealisedRate | null; sampled: number } | null>(null)
  ]);

  const ledger = buildLearningLedger({
    leadTime,
    regret,
    pricingPower,
    engineReaction,
    netRealised,
    cancellation,
    includeNetRealised
  });

  return {
    tenantId,
    engine,
    computedAt: (args.now ?? new Date()).toISOString(),
    leadTime,
    regret,
    pricingPower,
    engineReaction,
    netRealised: netRealised?.value ?? null,
    cancellation: cancellation.value,
    ledger
  };
}
