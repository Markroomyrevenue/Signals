/**
 * Phase A — historic warm-start for the recs page (2026-07-18).
 *
 * Mark is not waiting for the 30-day graduations: day-one recommendations are
 * seeded from history instead of shipping generic. This module computes, per
 * client:
 *
 *  - `drop-outcomes` evidence: the SAME episode / 3% noise-floor / matched-
 *    control design as `observe/drop-outcomes.ts` (design is load-bearing —
 *    reviews/observe-learn-2026-07/02-causal-stats.md §7; the loading flow
 *    mirrors scripts/mine-drop-outcomes.ts). Cells carry their n; thin cells
 *    are marked, not trusted.
 *  - `mark-prior` evidence: the revealed sizing prior — median drop size per
 *    lead bucket across ≥3% episodes. This is a PRIOR, not a target, and it is
 *    stored with an explicit attribution caveat: rate_changes has no source
 *    column, so an "episode" may be the RMS's move rather than Mark's; the 3%
 *    floor is what makes it PLAUSIBLY a deliberate move (H6, red-team review).
 *
 * Everything is stored in `RecsEvidence` (NOT ClientProfile — the daily
 * observe run full-replaces the profile JSON, which would silently wipe a
 * one-off warm-start), provenance "warm-start", per-cell sample sizes intact.
 * The live loop and the ghost scorer re-check these conclusions as real days
 * accumulate; `refreshLiveEvidence` re-runs the same computation later with
 * provenance "live-observed".
 *
 * Endogeneity guard (review B5): once the push path writes `PushLog`, our own
 * pushed changes appear in the rate-scan stream. `loadEndogenousNights`
 * collects (listingId, date) pairs we pushed and the episode miner excludes
 * them, so the learner never learns from its own actions as if they were the
 * operator's.
 */

import type { PrismaClient } from "@prisma/client";

import { addUtcDays, fromDateOnly, toDateOnly } from "@/lib/metrics/helpers";
import {
  aggregateDropOutcomes,
  analyseListingDrops,
  collapseDropEpisodes,
  leadBucketLabel,
  stratifiedSampleEpisodes,
  DROP_NOISE_FLOOR,
  MATCH_WINDOW_DAYS,
  MIN_REAL_REVENUE,
  type DropEpisode,
  type DropOutcomeCell,
  type NightRecord,
  type TreatedNightOutcome
} from "@/lib/observe/drop-outcomes";
import { prisma } from "@/lib/prisma";

import type { DoseResponseCell, MarkPriorBand, SizingEvidence } from "./sizing";

/** Cells with fewer matched treated nights than this are context, not signal. */
export const WARMSTART_MIN_MATCHED = 20;
/** Stratified episode cap per listing (mirrors the miner's default). */
export const WARMSTART_EPISODE_CAP = 400;

export type MarkPriorPayload = {
  computedAt: string;
  /** Evidence window, e.g. "2026-06-02 → 2026-07-17" (detection dates). */
  window: string;
  episodesTotal: number;
  attributionCaveat: string;
  bands: Array<{ leadBucket: string; medianDropPct: number; p25: number; p75: number; n: number }>;
};

export type DropOutcomesPayload = {
  computedAt: string;
  params: { noiseFloor: number; minMatched: number; episodeCap: number };
  treatedNightsSettled: number;
  caveat: string;
  cells: DropOutcomeCell[];
};

const ATTRIBUTION_CAVEAT =
  "rate_changes has no source column: an episode may be the pricing engine's move, not the operator's. " +
  "The 3% noise floor makes it plausibly deliberate; treat these bands as a heuristic prior, never attribution.";

const OBSERVATIONAL_CAVEAT =
  "Observational, selection-on-weakness biased AGAINST drops (dropped nights were already weak); " +
  "matched within-listing controls only. Supports 'X of Y comparable nights filled', never 'the drop caused the fill'.";

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
  return sorted[idx];
}

/** Mark's revealed sizing per lead bucket, from collapsed ≥3% episodes. Pure. */
export function computeMarkPriorBands(episodes: DropEpisode[], computedAt: string): MarkPriorPayload {
  const byBucket = new Map<string, number[]>();
  let minDetected: string | null = null;
  let maxDetected: string | null = null;
  for (const ep of episodes) {
    const detected = toDateOnly(ep.detectedAt);
    if (minDetected === null || detected < minDetected) minDetected = detected;
    if (maxDetected === null || detected > maxDetected) maxDetected = detected;
    for (const night of ep.nights) {
      const bucket = leadBucketLabel(night.leadDays);
      if (bucket === null) continue;
      const list = byBucket.get(bucket) ?? [];
      list.push(night.dropPct);
      byBucket.set(bucket, list);
    }
  }
  const bands = [...byBucket.entries()]
    .map(([leadBucket, drops]) => {
      const sorted = [...drops].sort((a, b) => a - b);
      return {
        leadBucket,
        medianDropPct: median(sorted),
        p25: quantile(sorted, 0.25),
        p75: quantile(sorted, 0.75),
        n: sorted.length
      };
    })
    .sort((a, b) => a.leadBucket.localeCompare(b.leadBucket));
  return {
    computedAt,
    window: minDetected && maxDetected ? `${minDetected} → ${maxDetected}` : "no episodes",
    episodesTotal: episodes.length,
    attributionCaveat: ATTRIBUTION_CAVEAT,
    bands
  };
}

/**
 * (listingId, stay-date) pairs this system itself pushed — excluded from
 * episode mining so pushed drops are never mistaken for operator behaviour.
 */
export async function loadEndogenousNights(db: PrismaClient, tenantId: string): Promise<Set<string>> {
  const rows = await db.pushLog.findMany({
    where: { tenantId, result: "success", lever: "price", dateFrom: { not: null } },
    select: { listingId: true, dateFrom: true, dateTo: true }
  });
  const keys = new Set<string>();
  for (const row of rows) {
    if (!row.listingId || !row.dateFrom) continue;
    let cursor = row.dateFrom;
    const end = row.dateTo ?? row.dateFrom;
    while (cursor.getTime() <= end.getTime()) {
      keys.add(`${row.listingId}|${toDateOnly(cursor)}`);
      cursor = addUtcDays(cursor, 1);
    }
  }
  return keys;
}

export type OwnHistoryEvidence = {
  markPrior: MarkPriorPayload;
  dropOutcomes: DropOutcomesPayload;
  episodesFound: number;
  treatedNightsSettled: number;
};

/**
 * The own-history warm-start for one tenant: the miner's exact flow (episode
 * collapse → settle → within-listing matched controls → dose-response cells),
 * as a library function against an injected Prisma client so it can run
 * against prod (SELECT + RecsEvidence upserts only) or dev. Tenant-scoped on
 * every query (house rule).
 */
export async function computeOwnHistoryEvidence(
  db: PrismaClient,
  tenant: { id: string; name: string },
  opts: { today?: string; episodeCap?: number } = {}
): Promise<OwnHistoryEvidence> {
  const today = opts.today ?? toDateOnly(new Date());
  const cap = opts.episodeCap ?? WARMSTART_EPISODE_CAP;
  const computedAt = new Date().toISOString();

  const [dropRows, endogenous] = await Promise.all([
    db.rateChange.findMany({
      where: { tenantId: tenant.id, lever: "price", changePct: { lte: -DROP_NOISE_FLOOR } },
      select: {
        id: true,
        listingId: true,
        scanId: true,
        date: true,
        detectedAt: true,
        changePct: true,
        oldValue: true,
        newValue: true
      }
    }),
    loadEndogenousNights(db, tenant.id)
  ]);
  const exogenousRows = dropRows.filter((r) => !endogenous.has(`${r.listingId}|${toDateOnly(r.date)}`));

  const episodes = collapseDropEpisodes(
    exogenousRows.map((r) => ({
      id: r.id,
      listingId: r.listingId,
      scanId: r.scanId,
      date: toDateOnly(r.date),
      detectedAt: r.detectedAt,
      changePct: Number(r.changePct),
      oldValue: r.oldValue === null ? null : Number(r.oldValue),
      newValue: r.newValue === null ? null : Number(r.newValue)
    }))
  );
  const markPrior = computeMarkPriorBands(episodes, computedAt);
  const sampled = stratifiedSampleEpisodes(episodes, cap);

  let treated: TreatedNightOutcome[] = [];
  if (sampled.length > 0) {
    const listingIds = [...new Set(sampled.map((e) => e.listingId))];
    const minDropDate = exogenousRows.reduce(
      (min, r) => (toDateOnly(r.date) < min ? toDateOnly(r.date) : min),
      toDateOnly(exogenousRows[0].date)
    );
    const rangeStart = fromDateOnly(toDateOnly(addUtcDays(fromDateOnly(minDropDate), -MATCH_WINDOW_DAYS)));
    const todayDate = fromDateOnly(today);

    const [facts, calendar, brcRows] = await Promise.all([
      db.nightFact.findMany({
        where: { tenantId: tenant.id, listingId: { in: listingIds }, date: { gte: rangeStart, lt: todayDate } },
        select: {
          listingId: true,
          date: true,
          isOccupied: true,
          status: true,
          revenueAllocated: true,
          bookingCreatedAt: true,
          leadTimeDays: true
        }
      }),
      db.calendarRate.findMany({
        where: { tenantId: tenant.id, listingId: { in: listingIds }, date: { gte: rangeStart, lt: todayDate } },
        select: { listingId: true, date: true, available: true }
      }),
      db.bookingRateContext.findMany({
        where: { tenantId: tenant.id, listingId: { in: listingIds }, stayDate: { lt: todayDate } },
        select: { listingId: true, stayDate: true, rateChangeId: true }
      })
    ]);

    const droppedDates = new Map<string, Set<string>>();
    for (const r of exogenousRows) {
      const set = droppedDates.get(r.listingId) ?? new Set<string>();
      set.add(toDateOnly(r.date));
      droppedDates.set(r.listingId, set);
    }
    const nightsByListing = new Map<string, Map<string, NightRecord>>();
    const nightFor = (listingId: string, date: string): NightRecord => {
      let nights = nightsByListing.get(listingId);
      if (!nights) {
        nights = new Map();
        nightsByListing.set(listingId, nights);
      }
      let night = nights.get(date);
      if (!night) {
        night = {
          date,
          occupiedBookings: [],
          cancelledBookings: [],
          openAtEnd: false,
          dropped: droppedDates.get(listingId)?.has(date) ?? false
        };
        nights.set(date, night);
      }
      return night;
    };
    for (const f of facts) {
      const night = nightFor(f.listingId, toDateOnly(f.date));
      const revenue = Number(f.revenueAllocated);
      if (f.status === "cancelled") {
        night.cancelledBookings.push({ bookingCreatedAt: f.bookingCreatedAt, leadTimeDays: f.leadTimeDays });
      } else if (f.isOccupied && f.status !== "ownerstay" && revenue > MIN_REAL_REVENUE) {
        night.occupiedBookings.push({ bookingCreatedAt: f.bookingCreatedAt, leadTimeDays: f.leadTimeDays, revenue });
      }
    }
    for (const c of calendar) {
      if (c.available) nightFor(c.listingId, toDateOnly(c.date)).openAtEnd = true;
    }
    const brcByListing = new Map<string, Map<string, Set<string>>>();
    for (const b of brcRows) {
      if (!b.rateChangeId) continue;
      const perDate = brcByListing.get(b.listingId) ?? new Map<string, Set<string>>();
      const key = toDateOnly(b.stayDate);
      const set = perDate.get(key) ?? new Set<string>();
      set.add(b.rateChangeId);
      perDate.set(key, set);
      brcByListing.set(b.listingId, perDate);
    }

    const episodesByListing = new Map<string, DropEpisode[]>();
    for (const ep of sampled) {
      const list = episodesByListing.get(ep.listingId) ?? [];
      list.push(ep);
      episodesByListing.set(ep.listingId, list);
    }
    for (const [listingId, listingEpisodes] of episodesByListing) {
      const analysis = analyseListingDrops({
        listingId,
        episodes: listingEpisodes,
        nights: nightsByListing.get(listingId) ?? new Map(),
        brcChangeIdsByDate: brcByListing.get(listingId),
        today
      });
      treated = treated.concat(analysis.treated);
    }
  }

  const cells = aggregateDropOutcomes(treated);
  return {
    markPrior,
    dropOutcomes: {
      computedAt,
      params: { noiseFloor: DROP_NOISE_FLOOR, minMatched: WARMSTART_MIN_MATCHED, episodeCap: cap },
      treatedNightsSettled: treated.length,
      caveat: OBSERVATIONAL_CAVEAT,
      cells
    },
    episodesFound: episodes.length,
    treatedNightsSettled: treated.length
  };
}

/** Upsert one evidence row (unique per tenant × clientKey × kind). */
export async function upsertRecsEvidence(
  db: PrismaClient,
  args: { tenantId: string; clientKey: string; kind: string; provenance: "warm-start" | "live-observed"; payload: unknown }
): Promise<void> {
  await db.recsEvidence.upsert({
    where: { tenantId_clientKey_kind: { tenantId: args.tenantId, clientKey: args.clientKey, kind: args.kind } },
    create: {
      tenantId: args.tenantId,
      clientKey: args.clientKey,
      kind: args.kind,
      provenance: args.provenance,
      payload: args.payload as object,
      computedAt: new Date()
    },
    update: { provenance: args.provenance, payload: args.payload as object, computedAt: new Date() }
  });
}

// ---------------------------------------------------------------------------
// Engine-history evidence (context, explicitly non-causal)
// ---------------------------------------------------------------------------

export type EngineHistoryPayload = {
  computedAt: string;
  engine: string;
  /** Why this evidence cannot feed the causal read (honest scope note). */
  causalNote: string;
  perListing: Array<{
    engineListingId: string;
    /** PL: next-30-day price stats from listing_prices. WH: same from price_calendar. */
    next30?: { min: number; median: number; max: number; days: number } | null;
    /** WH only: base-price recommendation moves ≥3% in the fetched history. */
    baseRecMoves?: Array<{ modelDate: string; fromRec: number; toRec: number; movePct: number }> | null;
  }>;
};

const ENGINE_HISTORY_CAUSAL_NOTE =
  "insufficient for causal read: engine-side data has no per-night booked-state timeline matched to each price " +
  "move at our episode/matched-control design's standard, and rate limits preclude a full calendar_day_history " +
  "sweep. Collected as descriptive forward-state / recommendation-history context only.";

type ForwardCalendarReader = (engineListingId: string) => Promise<Array<{ date: string; price: number | null }>>;
type BaseHistoryReader = (
  engineListingId: string
) => Promise<Array<{ modelDate: string; recommendation: number | null }>>;

function next30Stats(days: Array<{ date: string; price: number | null }>): EngineHistoryPayload["perListing"][number]["next30"] {
  const prices = days.map((d) => d.price).filter((p): p is number => p !== null && Number.isFinite(p) && p > 0);
  if (prices.length === 0) return null;
  const sorted = [...prices].sort((a, b) => a - b);
  return { min: sorted[0], median: median(sorted), max: sorted[sorted.length - 1], days: prices.length };
}

/** ≥3% moves in the engine's own base-price recommendation history. Pure. */
export function baseRecMovesFromHistory(
  rows: Array<{ modelDate: string; recommendation: number | null }>
): NonNullable<EngineHistoryPayload["perListing"][number]["baseRecMoves"]> {
  const moves: NonNullable<EngineHistoryPayload["perListing"][number]["baseRecMoves"]> = [];
  let prev: { modelDate: string; recommendation: number } | null = null;
  for (const row of rows) {
    if (row.recommendation === null || !Number.isFinite(row.recommendation) || row.recommendation <= 0) continue;
    if (prev && prev.recommendation > 0) {
      const movePct = (row.recommendation - prev.recommendation) / prev.recommendation;
      if (Math.abs(movePct) >= DROP_NOISE_FLOOR) {
        moves.push({ modelDate: row.modelDate, fromRec: prev.recommendation, toRec: row.recommendation, movePct });
      }
    }
    prev = { modelDate: row.modelDate, recommendation: row.recommendation };
  }
  return moves;
}

/**
 * Collect descriptive engine-side context for one tenant's listings. Readers
 * are injected (registry adapters at the call site; fakes in tests). Failures
 * per listing degrade to a null entry — one listing's error never sinks the
 * evidence pass.
 */
export async function computeEngineHistoryEvidence(args: {
  engine: string;
  engineListingIds: string[];
  forwardCalendar?: ForwardCalendarReader;
  baseHistory?: BaseHistoryReader;
}): Promise<EngineHistoryPayload> {
  const perListing: EngineHistoryPayload["perListing"] = [];
  for (const engineListingId of args.engineListingIds) {
    const entry: EngineHistoryPayload["perListing"][number] = { engineListingId };
    if (args.forwardCalendar) {
      try {
        entry.next30 = next30Stats(await args.forwardCalendar(engineListingId));
      } catch {
        entry.next30 = null;
      }
    }
    if (args.baseHistory) {
      try {
        entry.baseRecMoves = baseRecMovesFromHistory(await args.baseHistory(engineListingId));
      } catch {
        entry.baseRecMoves = null;
      }
    }
    perListing.push(entry);
  }
  return {
    computedAt: new Date().toISOString(),
    engine: args.engine,
    causalNote: ENGINE_HISTORY_CAUSAL_NOTE,
    perListing
  };
}

// ---------------------------------------------------------------------------
// Sizing-evidence lookup (consumed by recs generation)
// ---------------------------------------------------------------------------

const BAND_MIDPOINTS: Record<string, number> = { "3-7%": 0.05, "7-15%": 0.11, "15%+": 0.18 };

export type SizingEvidenceLookup = (leadBucket: string | null, dateType: "weekday" | "weekend") => SizingEvidence | null;

/**
 * Load a client's evidence rows and return a per-night lookup for the sizing
 * composer. Falls back gracefully: no rows → null (base sizing ships alone).
 */
export async function loadSizingEvidence(args: {
  tenantId: string;
  clientKey: string;
  db?: PrismaClient;
}): Promise<SizingEvidenceLookup> {
  const db = args.db ?? prisma;
  const rows = await db.recsEvidence.findMany({
    where: { tenantId: args.tenantId, clientKey: args.clientKey, kind: { in: ["mark-prior", "drop-outcomes"] } },
    select: { kind: true, provenance: true, payload: true }
  });
  const markPriorRow = rows.find((r) => r.kind === "mark-prior");
  const dropRow = rows.find((r) => r.kind === "drop-outcomes");
  const provenance: "warm-start" | "live-observed" =
    rows.some((r) => r.provenance === "live-observed") ? "live-observed" : "warm-start";

  const priorByBucket = new Map<string, MarkPriorBand>();
  if (markPriorRow) {
    const payload = markPriorRow.payload as unknown as MarkPriorPayload;
    for (const band of payload.bands ?? []) {
      if (band.n > 0 && Number.isFinite(band.medianDropPct)) {
        priorByBucket.set(band.leadBucket, {
          medianDropPct: band.medianDropPct,
          n: band.n,
          window: payload.window
        });
      }
    }
  }

  // Best dose-response cell per (leadBucket, dateType): prefer the matching
  // dateType, prefer cells with enough matched controls, then most-matched.
  const cellsByKey = new Map<string, DropOutcomeCell[]>();
  if (dropRow) {
    const payload = dropRow.payload as unknown as DropOutcomesPayload;
    for (const cell of payload.cells ?? []) {
      const key = `${cell.leadBucket}|${cell.dateType}`;
      const list = cellsByKey.get(key) ?? [];
      list.push(cell);
      cellsByKey.set(key, list);
    }
  }
  const bestCell = (leadBucket: string, dateType: string): DoseResponseCell | null => {
    const candidates = cellsByKey.get(`${leadBucket}|${dateType}`) ?? [];
    // A cell may only DRIVE sizing when it clears the n bar AND actually
    // carries fill information — a 0%-vs-0% cell (both treated and control
    // never filled) is informationless and must never trigger the shrink
    // branch (fidelity review 2026-07-18: shrinking on literally no
    // information, with a line implying a comparison the data doesn't hold).
    const informative = candidates.filter(
      (c) =>
        c.matchedTreatedNights >= WARMSTART_MIN_MATCHED &&
        c.fillDeltaPp !== null &&
        ((c.treatedFillRateMatched ?? 0) > 0 || (c.controlFillRate ?? 0) > 0)
    );
    if (informative.length > 0) {
      const best = informative.reduce((a, b) => ((a.fillDeltaPp ?? 0) >= (b.fillDeltaPp ?? 0) ? a : b));
      return {
        fillDeltaPp: best.fillDeltaPp as number,
        n: best.matchedTreatedNights,
        band: best.dropBand,
        bandMidPct: BAND_MIDPOINTS[best.dropBand] ?? 0.11
      };
    }
    // Thin/informationless evidence is MARKED, not silently omitted: return
    // the largest-n candidate flagged non-informative so the composer names
    // it on the page without ever resizing on it ("marked, not trusted").
    const withDelta = candidates.filter((c) => c.fillDeltaPp !== null);
    if (withDelta.length === 0) return null;
    const largest = withDelta.reduce((a, b) => (a.matchedTreatedNights >= b.matchedTreatedNights ? a : b));
    return {
      fillDeltaPp: largest.fillDeltaPp as number,
      n: largest.matchedTreatedNights,
      band: largest.dropBand,
      bandMidPct: BAND_MIDPOINTS[largest.dropBand] ?? 0.11,
      informative: false
    };
  };

  if (priorByBucket.size === 0 && cellsByKey.size === 0) return () => null;
  return (leadBucket, dateType) => {
    if (leadBucket === null) return null;
    const markPrior = priorByBucket.get(leadBucket) ?? null;
    const doseResponse = bestCell(leadBucket, dateType);
    if (!markPrior && !doseResponse) return null;
    return { markPrior, doseResponse, provenance };
  };
}
