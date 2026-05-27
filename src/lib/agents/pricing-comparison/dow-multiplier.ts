/**
 * Learned day-of-week multiplier for the trial daily rate (2026-05-27).
 *
 * ## Why this exists
 *
 * The automatic DoW multiplier was retired on 2026-05-22 on the theory
 * that the cross-sectional demand signal would capture the weekly
 * pattern. Today's report (2026-05-27) showed the opposite — 55% of
 * trough cells flooring on demand, with per-tenant DoW mean Δ vs PL
 * sitting Fri/Sat -25% to -38% under PL and Mon-Wed +9% to +19% over.
 *
 * Two coordinated faults:
 *   - Pace measures fill VELOCITY, not rate LEVELS. PriceLabs's
 *     Saturday premium is a rate fact (Saturdays cost more in this
 *     market). Pace can't see that.
 *   - The booking curve was DoW-agnostic — it averaged fill across all
 *     days at each lead time. Historical Saturdays fill faster at L=60d
 *     than weekdays do; the all-DoW curve under-counts that. Saturdays
 *     at L=60d were then pacing "behind" the average and flooring demand
 *     even when filling fine.
 *
 * This module restores the DoW multiplier — but LEARNED per market from
 * own (and KD) history, not configured. Phase E elsewhere partitions
 * the booking curve by DoW so pace doesn't double-count.
 *
 * ## How
 *
 *   - Per tenant: mean ADR over each DoW's past stayed nights in the
 *     trailing 12 months (city-level, all bedrooms). Same exclusion
 *     set as the trailing-ADR base inputs (ownerstays excluded,
 *     `losNights ≤ MAX_LOS_NIGHTS_FOR_TRAILING_ADR`).
 *   - Weekly average = mean across all 7 DoWs (NOT the raw average of
 *     all stayed nights — DoW-normalised so a Friday-heavy booking
 *     pattern doesn't bias the divisor).
 *   - Multiplier per DoW = DoW mean ADR / weekly average.
 *
 *   - KD fallback (per Mark's spec): when own per-DoW sample is below
 *     `DOW_LEARNED_MIN_NIGHTS_PER_DOW`, read the corresponding KD
 *     market DoW value (computed in this module from the cached
 *     `cache/keydata-2026-05-26/ota-market-kpis-day/backward-365d.json`).
 *     KD is the JUNIOR signal — used only when own is too sparse.
 *
 *   - Each multiplier capped to [DOW_LEARNED_MIN, DOW_LEARNED_MAX]
 *     (0.85, 1.35) to prevent outlier years from blowing things up.
 *
 * Trial-only.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import {
  STATUSES_EXCLUDED_FROM_TRAILING_ADR,
  MAX_LOS_NIGHTS_FOR_TRAILING_ADR
} from "@/lib/agents/pricing-comparison/trailing-adr";

/** Minimum past stayed nights per DoW to use own (vs KD fallback). */
export const DOW_LEARNED_MIN_NIGHTS_PER_DOW = 30;
/**
 * Outer artifact guard on any single learned DoW multiplier.
 *
 * Widened 2026-05-27 PM from [0.85, 1.35] → [0.75, 1.50]:
 *   - SB Mon-Thu pinned at the 0.85 floor (raw signal wants lower);
 *     SB Sat at the 1.35 cap (raw signal wants higher). Per-DoW Δ vs
 *     PL on SB still +12.7% on Mon and -27.2% on Sat after the
 *     2026-05-27 AM ship — both ends of the bracket were binding.
 *   - LF Sat at 1.33 sits inside the old window; widening doesn't
 *     change LF directly. SB is the binding case.
 *
 * Per Mark's principle: the listing's per-tenant min/max price
 * overrides are the customer-facing safety. These constants are
 * the engine's outer artifact guards — wide enough to let the data
 * speak, narrow enough to catch obvious config errors (a multiplier
 * below 0.75 or above 1.50 is almost certainly an outlier-year
 * artifact, not a genuine market pattern).
 */
export const DOW_LEARNED_MIN = 0.75;
export const DOW_LEARNED_MAX = 1.50;
/** Window for the own-history aggregation (matches trailing-ADR helper). */
const TRAILING_WINDOW_DAYS = 365;

/** Path to the cached KD market daily backward window. */
const KD_CACHE_BACKWARD_DAILY = path.resolve(
  "/Users/markmccracken/Documents/signals/.claude/worktrees/strange-spence-7704a8/cache/keydata-2026-05-26/ota-market-kpis-day/backward-365d.json"
);

export type DowMultiplierSource = "own" | "kd-fallback" | "neutral";

export type DowMultiplierResult = {
  /** Indexed 0=Sun ... 6=Sat (JS UTC day numbering). */
  multipliers: number[]; // length 7
  /** Own stayed-night count per DoW (the sample-gate driver). */
  sampleByDow: number[]; // length 7
  /** Per-DoW provenance flag. */
  sourceByDow: DowMultiplierSource[]; // length 7
  /** Raw own mean ADR per DoW (diagnostic). */
  ownMeanAdrByDow: Array<number | null>;
  /** Raw KD market mean ADR per DoW (diagnostic). */
  kdMeanAdrByDow: Array<number | null>;
  /** Weekly average of own DoW means (the divisor for own multipliers). */
  ownWeeklyAverage: number | null;
  /** Weekly average of KD DoW means (the divisor for KD multipliers). */
  kdWeeklyAverage: number | null;
};

const NEUTRAL_RESULT: DowMultiplierResult = {
  multipliers: [1, 1, 1, 1, 1, 1, 1],
  sampleByDow: [0, 0, 0, 0, 0, 0, 0],
  sourceByDow: ["neutral", "neutral", "neutral", "neutral", "neutral", "neutral", "neutral"],
  ownMeanAdrByDow: [null, null, null, null, null, null, null],
  kdMeanAdrByDow: [null, null, null, null, null, null, null],
  ownWeeklyAverage: null,
  kdWeeklyAverage: null
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Mean across the array, ignoring nulls. Returns null when every entry
 * is null (no signal). Used to compute the weekly-average divisor.
 */
function meanIgnoreNull(vals: Array<number | null>): number | null {
  let sum = 0;
  let n = 0;
  for (const v of vals) {
    if (v !== null && Number.isFinite(v)) {
      sum += v;
      n += 1;
    }
  }
  return n > 0 ? sum / n : null;
}

type KdCachedDayRow = {
  date: string;
  adr: number;
  ota_source: string;
};

/**
 * Read the cached KD market daily backward window and aggregate by
 * day-of-week. Returns mean ADR per DoW (Airbnb-filtered, same OTA
 * preference as `keydata-provider.ts`). Returns all-null when the
 * cache file is missing.
 */
async function loadKdMarketDowMeans(): Promise<{ means: Array<number | null>; weeklyAverage: number | null }> {
  let raw: { response?: { data?: { kpis?: KdCachedDayRow[] } } };
  try {
    raw = JSON.parse(await fs.readFile(KD_CACHE_BACKWARD_DAILY, "utf-8"));
  } catch {
    return { means: [null, null, null, null, null, null, null], weeklyAverage: null };
  }
  const kpis = raw.response?.data?.kpis ?? [];
  // Airbnb preferred; fall back to all rows if no airbnb (matches provider).
  const airbnb = kpis.filter((r) => r.ota_source === "airbnb");
  const rows = airbnb.length > 0 ? airbnb : kpis;
  const sums = [0, 0, 0, 0, 0, 0, 0];
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const r of rows) {
    const adr = Number(r.adr);
    if (!Number.isFinite(adr) || adr <= 0) continue;
    const d = new Date(`${r.date}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) continue;
    const dow = d.getUTCDay();
    sums[dow] += adr;
    counts[dow] += 1;
  }
  const means: Array<number | null> = sums.map((s, i) => (counts[i] > 0 ? s / counts[i] : null));
  const weeklyAverage = meanIgnoreNull(means);
  return { means, weeklyAverage };
}

/**
 * Learn per-DoW multiplier for a tenant from own NightFact history,
 * with KD market DoW as fallback when per-DoW sample is below the
 * gate.
 */
export async function loadDowMultiplierForTenant(args: { tenantId: string; asOfIso: string }): Promise<DowMultiplierResult> {
  const { tenantId, asOfIso } = args;
  const today = new Date(`${asOfIso}T00:00:00Z`);
  const windowStart = new Date(today);
  windowStart.setUTCDate(today.getUTCDate() - TRAILING_WINDOW_DAYS);

  // Pull all NightFact rows for the tenant in the trailing window.
  // City-level / cross-bedroom per Mark's spec.
  const facts = await prisma.nightFact.findMany({
    where: {
      tenantId,
      date: { gte: windowStart, lt: today },
      isOccupied: true,
      revenueAllocated: { gt: 0 },
      losNights: { not: null, lte: MAX_LOS_NIGHTS_FOR_TRAILING_ADR }
    },
    select: { date: true, revenueAllocated: true, status: true }
  });

  // Collapse to per-date revenue first (a date may appear on multiple
  // night_fact rows if a reservation spans across the inserted boundaries
  // — same defensive pattern as trailing-adr.ts).
  const dailyRevenue = new Map<string, number>();
  for (const f of facts) {
    if (f.status && STATUSES_EXCLUDED_FROM_TRAILING_ADR.has(f.status.toLowerCase())) continue;
    const iso = f.date.toISOString().slice(0, 10);
    dailyRevenue.set(iso, (dailyRevenue.get(iso) ?? 0) + Number(f.revenueAllocated ?? 0));
  }

  // Aggregate the per-date revenues into per-DoW sums.
  const sumByDow = [0, 0, 0, 0, 0, 0, 0];
  const countByDow = [0, 0, 0, 0, 0, 0, 0];
  for (const [iso, rev] of dailyRevenue) {
    const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
    sumByDow[dow] += rev;
    countByDow[dow] += 1;
  }
  const ownMeanAdrByDow: Array<number | null> = sumByDow.map((s, i) => (countByDow[i] > 0 ? s / countByDow[i] : null));
  // Weekly average — average of the seven DoW means (NOT of all
  // night-level rev numbers). This DoW-normalises the divisor so a
  // weekend-heavy booking pattern doesn't bias it.
  const ownWeeklyAverage = meanIgnoreNull(ownMeanAdrByDow);

  // KD fallback set (loaded from cache, NO live KD calls).
  const kd = await loadKdMarketDowMeans();

  const multipliers: number[] = [];
  const sourceByDow: DowMultiplierSource[] = [];
  for (let dow = 0; dow < 7; dow++) {
    const ownN = countByDow[dow];
    if (ownN >= DOW_LEARNED_MIN_NIGHTS_PER_DOW && ownMeanAdrByDow[dow] !== null && ownWeeklyAverage !== null && ownWeeklyAverage > 0) {
      // Own path
      const raw = ownMeanAdrByDow[dow]! / ownWeeklyAverage;
      multipliers.push(clamp(raw, DOW_LEARNED_MIN, DOW_LEARNED_MAX));
      sourceByDow.push("own");
    } else if (kd.means[dow] !== null && kd.weeklyAverage !== null && kd.weeklyAverage > 0) {
      // KD fallback
      const raw = kd.means[dow]! / kd.weeklyAverage;
      multipliers.push(clamp(raw, DOW_LEARNED_MIN, DOW_LEARNED_MAX));
      sourceByDow.push("kd-fallback");
    } else {
      // Neither own nor KD has data — neutral 1.0.
      multipliers.push(1.0);
      sourceByDow.push("neutral");
    }
  }

  return {
    multipliers,
    sampleByDow: countByDow,
    sourceByDow,
    ownMeanAdrByDow,
    kdMeanAdrByDow: kd.means,
    ownWeeklyAverage,
    kdWeeklyAverage: kd.weeklyAverage
  };
}

/**
 * Convenience for tests / non-DB code paths.
 */
export const NEUTRAL_DOW_RESULT: DowMultiplierResult = NEUTRAL_RESULT;
