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

/**
 * Minimum observable listing-nights before the trailing-DOW regret baseline is
 * trusted at all. A thin sample is worse than no baseline: an understated
 * expectation re-labels ordinary seasonal voids as pricing mistakes, and that
 * number is quoted to the operator as the case for cutting prices.
 */
export const REGRET_BASELINE_MIN_NIGHTS = 200;
/** Below this, a day-of-week borrows the overall rate instead of its own. */
export const REGRET_BASELINE_MIN_PER_DOW = 20;
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
  /**
   * True ONLY when a usable reading exists — the measurement ran AND found at
   * least one human move with a following snapshot.
   *
   * This used to mean "the engine exposes an API", so a client with zero
   * observed reactions still published `available: true` alongside four
   * all-zero fractions. On prod 2026-07-23 that was every client: 104 of 126
   * runs. The oversight model reads the profile verbatim, and "available, all
   * zeros" reads as a measured result of zero rather than an absence of data —
   * a confident-sounding claim about something never observed.
   */
  available: boolean;
  /** True when the measurement actually ran (i.e. the engine exposes an API).
   * Distinguishes "cannot measure" from "measured, found nothing" — the
   * starvation matrix needs both, and they resolve very differently. */
  measured: boolean;
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

/** One observable listing-night, assembled from NightFact + CalendarRate. */
export type ObservedNight = {
  listingId: string;
  /** Date-only string. */
  date: string;
  occupied: boolean;
  available: boolean;
  /** Calendar rate for the night, when a calendar row exists. */
  rate: number | null;
  /**
   * A CalendarRate row backed this night, so its AVAILABILITY was observed
   * rather than inferred.
   *
   * Load-bearing. Occupancy history (NightFact) reaches back to 2017, but
   * availability history (CalendarRate) only began 2025-10-24. Without this
   * flag, an old window returns occupied nights and nothing else, an empty
   * rate of ~0, and therefore an expectation of ~0 empties — which is the
   * exact bug this whole change exists to remove, reintroduced through the
   * back door.
   */
  observedAvailability: boolean;
};

/**
 * Per-listing-per-night occupancy for a past window, read from the tables that
 * are actually populated.
 *
 * WHY THIS EXISTS: `DailyAgg` was the intended source for both learning #4 and
 * the regret seasonal baseline, but prod holds ZERO daily_aggs rows and always
 * has — nothing in the codebase writes that table. `NightFact` carries
 * occupancy back to 2017 and `CalendarRate` carries availability, so both
 * learnings can be served from real data instead.
 *
 * Semantics deliberately MATCH `computeRegret`'s own convention, so the
 * baseline and the thing it is a baseline FOR are counted the same way:
 *   - a past calendar night still flagged `available` that was never occupied
 *     expired empty (owner blocks are `available: false`, so they drop out);
 *   - an occupied night is available by definition, whether or not the current
 *     calendar snapshot still says so;
 *   - listing-night granularity, NOT unit-scaled. A multi-unit listing counts
 *     once per night. This undercounts empties on multi-units — conservative,
 *     and it matches the regret window's own treatment (see computeRegret).
 *
 * A night with neither a calendar row nor an occupancy row is not observable
 * and is simply absent: we cannot tell "empty" from "not yet listed".
 */
export async function loadObservedNights(args: {
  tenantId: string;
  from: Date;
  to: Date;
}): Promise<ObservedNight[]> {
  const { tenantId, from, to } = args;
  const [occupiedRows, calendarRows] = await Promise.all([
    prisma.nightFact.findMany({
      where: { tenantId, isOccupied: true, date: { gte: from, lt: to } },
      select: { listingId: true, date: true }
    }),
    prisma.calendarRate.findMany({
      where: { tenantId, date: { gte: from, lt: to } },
      select: { listingId: true, date: true, available: true, rate: true }
    })
  ]);

  const occupied = new Set(occupiedRows.map((r) => `${r.listingId}|${toDateOnly(r.date)}`));
  const out = new Map<string, ObservedNight>();

  for (const row of calendarRows) {
    const date = toDateOnly(row.date);
    const key = `${row.listingId}|${date}`;
    const isOccupied = occupied.has(key);
    const rate = row.rate === null ? null : Number(row.rate);
    out.set(key, {
      listingId: row.listingId,
      date,
      occupied: isOccupied,
      // An occupied night was sellable even if today's snapshot says otherwise.
      available: row.available || isOccupied,
      rate: rate !== null && Number.isFinite(rate) && rate > 0 ? rate : null,
      observedAvailability: true
    });
  }
  // Occupied nights with no calendar row at all still count — they are proof
  // the night was both sellable and sold — but their availability was INFERRED,
  // not observed, so they cannot be used to establish an empty RATE.
  for (const row of occupiedRows) {
    const date = toDateOnly(row.date);
    const key = `${row.listingId}|${date}`;
    if (out.has(key)) continue;
    out.set(key, {
      listingId: row.listingId,
      date,
      occupied: true,
      available: true,
      rate: null,
      observedAvailability: false
    });
  }
  return [...out.values()];
}

/**
 * Learning #4 — pricing power by date type.
 *
 * Rebuilt on `loadObservedNights` (2026-07-23); it previously read `DailyAgg`
 * and so returned null on 126 of 126 prod runs. Only AVAILABLE nights are
 * judged: an unavailable night says nothing about whether the date could have
 * been sold at that rate. The pure core already labels a date type "unknown"
 * below n=5, so a thin slice cannot masquerade as a reading.
 */
export async function computePricingPower(tenantId: string): Promise<PricingPowerByDateType | null> {
  const today = fromDateOnly(toDateOnly(new Date()));
  const since = addUtcDays(today, -TRAILING_DAYS);
  const nights = (await loadObservedNights({ tenantId, from: since, to: today })).filter((n) => n.available);
  if (nights.length === 0) return null;
  return pricingPowerByDateType(
    nights.map((n) => ({ dateType: dateTypeFor(n.date), occupied: n.occupied, rate: n.rate }))
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
  const result = await computeRegretBaseline(args);
  // As of 2026-07-23 no client has a baseline: pace_yoy wants year-old
  // PaceSnapshot rows (that table starts 2026-04-24) and the season-matched
  // fallback wants year-old CalendarRate rows (from 2025-10-24). Both arrive on
  // their own, and the day one does, "held too high" silently reappears after
  // months of reading unmeasurable. Say so in the log rather than leaving the
  // next person to wonder what moved.
  if (result.baselineSource !== "none") {
    console.log(
      `[observe] regret baseline AVAILABLE for tenant=${args.tenantId} via ${result.baselineSource} ` +
        `(expected ${result.expectedEmpties?.toFixed(0) ?? "?"} empties across ${args.observableDates.length} settled ` +
        `nights) — held-too-high becomes measurable again for this client; it has read "unmeasurable" since 2026-07-23`
    );
  }
  return result;
}

async function computeRegretBaseline(args: {
  tenantId: string;
  since: Date;
  today: Date;
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

  // Fallback: same-DOW empty rate over THE SAME WINDOW ONE YEAR EARLIER,
  // sourced from NightFact + CalendarRate rather than PaceSnapshot.
  //
  // Rebuilt 2026-07-23. Two things were wrong before:
  //
  //  1. It read `DailyAgg`, which is empty in prod and always has been, so both
  //     baseline paths failed, every client carried `baselineSource: "none"`,
  //     and `regretFromNights` treated that as an expectation of ZERO empties —
  //     every empty night scored as "held too high".
  //
  //  2. Its window was `today-365 → since`: the preceding NINE MONTHS, not the
  //     matching season. Judging a summer window against an average that
  //     includes winter predicts far more empties than summer produces, so the
  //     excess collapses to zero. Measured on prod before this correction:
  //     Coorie Doon 793 empties against 1,928 "expected". That is not a
  //     seasonal expectation, it is an annual average — and swapping an
  //     inflated regret figure for a deflated one is not a fix.
  //
  // Now uses `lyStart`/`lyEnd` — the same dates as the pace_yoy path above — so
  // like is compared with like. It will keep returning "none" until CalendarRate
  // history reaches back a full year (it began 2025-10-24), which is the honest
  // answer in the meantime rather than a season-blind guess.
  const nights = await loadObservedNights({ tenantId: args.tenantId, from: lyStart, to: lyEnd });
  return expectedEmptiesFromObserved(nights, args.observableDates);
}

/**
 * Pure: turn a year of observed listing-nights into an expected number of
 * empties across `observableDates`, using each date's own day-of-week empty
 * rate. Exported for tests — the DB read around it is a thin wrapper.
 *
 * Returns `baselineSource: "none"` rather than a number whenever the sample is
 * too thin to believe. A wrong expectation is worse than none here: it
 * silently re-labels ordinary seasonal voids as pricing mistakes, and that
 * figure is quoted to the operator as the case for cutting prices.
 */
export function expectedEmptiesFromObserved(
  nights: ObservedNight[],
  observableDates: string[]
): { expectedEmpties: number | null; baselineSource: RegretBaselineSource } {
  // ONLY nights whose availability was actually observed can establish an empty
  // rate. Occupancy history runs to 2017 but availability history began
  // 2025-10-24; counting inferred-available nights would yield an empty rate of
  // ~0 on any older window, resurrecting the zero-expectation bug.
  const available = nights.filter((n) => n.available && n.observedAvailability);
  if (available.length < REGRET_BASELINE_MIN_NIGHTS) {
    return { expectedEmpties: null, baselineSource: "none" };
  }

  const byDow = new Map<number, { avail: number; occ: number }>();
  for (const n of available) {
    const dow = fromDateOnly(n.date).getUTCDay();
    const cur = byDow.get(dow) ?? { avail: 0, occ: 0 };
    cur.avail += 1;
    if (n.occupied) cur.occ += 1;
    byDow.set(dow, cur);
  }
  const totalAvail = available.length;
  const totalOcc = available.filter((n) => n.occupied).length;
  const overallRate = Math.max(0, (totalAvail - totalOcc) / totalAvail);
  // A day-of-week with too few observations borrows the overall rate rather
  // than trusting a handful of nights.
  const rateForDow = (dow: number): number => {
    const v = byDow.get(dow);
    return v && v.avail >= REGRET_BASELINE_MIN_PER_DOW ? Math.max(0, (v.avail - v.occ) / v.avail) : overallRate;
  };
  const expected = observableDates.reduce((s, d) => s + rateForDow(fromDateOnly(d).getUTCDay()), 0);
  return { expectedEmpties: expected, baselineSource: "trailing_dow" };
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
    return {
      available: false,
      measured: false,
      reason: "no engine API (hostaway-scan fallback)",
      reactions: empty,
      sampled: 0
    };
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
  // Measured, but nothing to read: no human move had a following snapshot.
  // NOT "available" — publishing four zero fractions as a result would state a
  // measurement that never happened.
  if (sampled === 0) {
    return {
      available: false,
      measured: true,
      reason: "no engine changes — no human moves (owner/mark) with a following snapshot",
      reactions,
      sampled: 0
    };
  }
  return { available: true, measured: true, reactions, sampled };
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
      : {
          learning: "pricing_power",
          sampleCount: 0,
          // Was "daily_aggs empty", which read like a fillable gap; in fact
          // nothing ever wrote that table, and #4 was null on 126 of 126 runs.
          // Now sourced from NightFact + CalendarRate, so null here means what
          // it says: no observable available nights in the trailing year.
          nullReason: "no observable available nights in the trailing 365d"
        }
  );

  // #5 engine reaction. `measured` keeps the matrix's two failure modes apart:
  // a null sampleCount means the measurement could not run at all (no engine
  // API — structural), zero means it ran and found nothing (resolves itself
  // once a human moves a lever).
  if (!args.engineReaction.available) {
    entries.push({
      learning: "engine_reaction",
      sampleCount: args.engineReaction.measured ? args.engineReaction.sampled : null,
      nullReason: args.engineReaction.reason ?? "engine reaction unavailable"
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
