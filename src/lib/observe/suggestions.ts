/**
 * Gated suggestions (SIGNALS-OBSERVE-LEARN-SPEC.md §9).
 *
 * Once a client graduates, write `Suggestion` rows ordered by REVENUE AT RISK,
 * each judged against the EXPECTED BOOKING CURVE FOR THAT LEAD TIME (not against
 * final occupancy). Nothing is applied — every row is `pending` and waits for
 * human approval. The pure judging core is unit-tested; the DB generator is
 * tenant-scoped and read-only outside the `Suggestion` table.
 */

import { getTrialLocalEventsForTenant } from "@/lib/agents/pricing-comparison/trial-events";
import { addUtcDays, fromDateOnly, toDateOnly } from "@/lib/metrics/helpers";
import { eventAdjustmentForDate } from "@/lib/pricing/events";
import { parsePricingSettingsOverride, type PricingLocalEvent } from "@/lib/pricing/settings";
import { tenantNameSlug } from "@/lib/pricing/trial-tenants";
import { prisma } from "@/lib/prisma";

import {
  buildCohortCurveSet,
  buildCohortOccupancySet,
  resolveCohortCurve,
  resolveCohortOccupancy,
  type CohortProvenance,
  type ResolvedCohortCurve,
  type ResolvedCohortOccupancy
} from "./cohorts";
import { LEAD_TIME_BUCKETS, type LeadTimeDistribution } from "./learnings-core";

/** Default horizon for forward suggestions (signal horizon is ~6 months). */
export const SUGGESTION_HORIZON_DAYS = 120;
/** Below this expected-fill, an empty night is normal — not yet at risk. */
export const RISK_FILL_THRESHOLD = 0.5;
/** Cap rows per client so the readout stays focused on what matters most. */
export const MAX_SUGGESTIONS = 50;
/** Below this many occupied nights with a lead, the tenant has no usable
 * curve at any rung and generation skips entirely (pre-cohort behaviour). */
export const MIN_TENANT_LEAD_NIGHTS = 20;
/** How far back `rate_states` is scanned for the lowest-observed-rate floor fallback. */
export const FLOOR_LOOKBACK_DAYS = 180;
/** Per-night cumulative drop cap: prior non-pending drops within the trailing
 * window totalling this much block any further drop (anti-ratchet). */
export const CUMULATIVE_DROP_CAP = 0.25;
/** Trailing window (days) over which prior drops count toward the cumulative cap. */
export const CUMULATIVE_CAP_WINDOW_DAYS = 14;
/**
 * Machine-written statuses the daily regeneration replaces. These rows are
 * marked `superseded` — NEVER deleted — so the record of what was suggested
 * when, at what rate, survives for retrospective (ghost) scoring.
 * Human-actioned rows (`approved` / `rejected` / `applied`) are never touched.
 *
 * Volume + retention: rows are superseded daily. The classic at-risk stream
 * adds at most ~`MAX_SUGGESTIONS` rows per client per day; recs-page mode
 * (2026-07-18) adds full 14-day coverage on top — up to ~listings × 14 rows
 * per client per day on the biggest tenants. Superseded rows older than 120
 * days should be pruned by a follow-up job — no pruning is built yet.
 */
export const SUPERSEDABLE_STATUSES = ["pending", "shadow"] as const;

/**
 * Why a would-be suggestion was suppressed. Deliberately surfaced (counted +
 * persisted + rendered in the readout) as a trust metric: the reviewer can see
 * how many drops the safety gates held back, and why.
 */
export type SuggestionBlockedReason =
  | "min_floor"
  | "event"
  | "already_actioned"
  | "cumulative_cap"
  /** Recs-page memory: this night was human-actioned within the last
   * `recentActionedDays` days and the world has not moved materially — the
   * prior decision stands rather than being silently re-suggested. */
  | "recently_actioned";

export type SuggestionBlockedCounts = Partial<Record<SuggestionBlockedReason, number>>;

/**
 * Expected cumulative fill by `daysToStay` days before stay: the fraction of
 * bookings that typically arrive at least this far ahead (lead ≥ daysToStay).
 * Sums bucket pcts by each bucket's midpoint lead. Pure.
 */
export function expectedCumulativeFill(daysToStay: number, buckets: LeadTimeDistribution["buckets"]): number {
  const pctByLabel = new Map(buckets.map((b) => [b.label, b.pct]));
  let fill = 0;
  for (const def of LEAD_TIME_BUCKETS) {
    const mid = def.max === Number.POSITIVE_INFINITY ? def.min : (def.min + def.max) / 2;
    if (mid >= daysToStay) fill += pctByLabel.get(def.label) ?? 0;
  }
  return fill;
}

export type NightJudgement = {
  atRisk: boolean;
  revenueAtRisk: number;
  proposedValue: number | null;
  dropPct: number;
  confidence: number;
  reason: string;
  /** Set when the night IS at risk but a safety gate suppressed the drop. */
  blockedReason?: SuggestionBlockedReason;
  /** Set when no minimum-price floor could be resolved — the drop went out unclamped. */
  floorUnknown?: boolean;
};

/**
 * Judge one forward night against the booking curve. Pure. An empty night whose
 * expected fill is already high (it should normally be booked by now) is behind
 * pace → revenue at risk → a timed-pct drop. A night still early on its curve is
 * fine. Booked nights are never at risk.
 *
 * Safety gates (each returns `atRisk: true` + a `blockedReason` instead of a
 * drop, so the caller can count what was held back):
 * - `already_actioned`: a human has already approved (or a push has applied) a
 *   suggestion for this night — regenerating a fresh drop on top would compound
 *   cut-on-cut with no memory.
 * - `event`: the night carries a positive local-event adjustment (it is priced
 *   UP for an event, e.g. Fleadh Cheoil) — never propose a drop against an
 *   event lift; empty event nights are the event pricing playing out, not a
 *   pace problem.
 * - `cumulative_cap`: prior non-pending drops for this night within the
 *   trailing `CUMULATIVE_CAP_WINDOW_DAYS` days already total
 *   ≥ `CUMULATIVE_DROP_CAP` — the anti-ratchet stop.
 * - `min_floor`: `proposedValue` is clamped to `floor` (the listing's minimum
 *   price); if the clamped value is at or above the current rate there is no
 *   room to drop, so nothing is emitted. When `floor` is null/undefined the
 *   clamp is skipped and the judgement is flagged `floorUnknown`.
 */
export function judgeNightForSuggestion(args: {
  daysToStay: number;
  booked: boolean;
  rate: number;
  expectedFill: number;
  riskThreshold?: number;
  /** Resolved minimum price for the listing; null/undefined = unknown. */
  floor?: number | null;
  /** Local-event adjustment (%) covering this night; null/undefined = none. */
  eventAdjustmentPct?: number | null;
  /** An approved/applied suggestion already covers this night. */
  hasActionedSuggestion?: boolean;
  /** Sum of prior non-pending drop pcts (0..1) for this night, trailing window. */
  cumulativeDropPct?: number;
  /**
   * Trailing-365d final occupancy (0..1) for this night's day-of-week, from
   * the listing's resolved occupancy cohort (listing → group → size band →
   * tenant). The raw curve is the share of EVENTUAL bookings with lead ≥ d,
   * not the probability the night is booked; multiplying by final occupancy
   * calibrates the trigger so it compares like with like. Default 1 (no
   * scaling).
   */
  occupancyFactor?: number;
  /**
   * Unsold units on this night (multi-unit listings sell N rooms of one type;
   * `Listing.unitCount >= 2`). Scales revenueAtRisk — a 40-unit building with
   * one room left has 1 unit's revenue at risk, an empty one has 40. Default 1.
   */
  unsoldUnits?: number;
}): NightJudgement {
  const threshold = args.riskThreshold ?? RISK_FILL_THRESHOLD;
  if (args.booked || args.rate <= 0 || args.daysToStay < 0) {
    return { atRisk: false, revenueAtRisk: 0, proposedValue: null, dropPct: 0, confidence: 0, reason: "not at risk" };
  }
  const occupancyFactor = Math.min(1, Math.max(0, args.occupancyFactor ?? 1));
  const scaledFill = args.expectedFill * occupancyFactor;
  const fillLabel =
    `raw curve ${(args.expectedFill * 100).toFixed(0)}%` +
    (occupancyFactor < 1 ? `, occupancy-scaled ${(scaledFill * 100).toFixed(0)}%` : "");
  if (scaledFill < threshold) {
    return {
      atRisk: false,
      revenueAtRisk: 0,
      proposedValue: null,
      dropPct: 0,
      confidence: 0,
      reason: `early on curve (expected fill ${fillLabel} < ${(threshold * 100).toFixed(0)}%)`
    };
  }
  // Behind pace: scale the drop with how far past the curve we are.
  const dropPct = Math.min(0.25, Math.max(0.05, (scaledFill - threshold) * 0.5 + 0.05));
  const confidence = Math.min(0.9, scaledFill);
  // Multi-unit: revenue at risk is the nightly rate times the units still unsold.
  const revenueAtRisk = args.rate * Math.max(1, Math.round(args.unsoldUnits ?? 1));
  const reason = `empty at ${args.daysToStay}d out; curve expects ~${(scaledFill * 100).toFixed(0)}% booked by now (${fillLabel})`;

  // No compounding: a night a human already actioned never gets a fresh drop.
  if (args.hasActionedSuggestion) {
    return {
      atRisk: true,
      revenueAtRisk,
      proposedValue: null,
      dropPct: 0,
      confidence,
      reason: `${reason}; an approved/applied suggestion already covers this night — no fresh drop`,
      blockedReason: "already_actioned"
    };
  }

  // Event shield: a positively event-adjusted night is priced up on purpose —
  // never counter it with a drop.
  if (typeof args.eventAdjustmentPct === "number" && args.eventAdjustmentPct > 0) {
    return {
      atRisk: true,
      revenueAtRisk,
      proposedValue: null,
      dropPct: 0,
      confidence,
      reason: `${reason}; night carries a +${args.eventAdjustmentPct}% event adjustment — drop withheld`,
      blockedReason: "event"
    };
  }

  // Anti-ratchet: prior drops within the trailing window already total the cap.
  if ((args.cumulativeDropPct ?? 0) >= CUMULATIVE_DROP_CAP) {
    return {
      atRisk: true,
      revenueAtRisk,
      proposedValue: null,
      dropPct: 0,
      confidence,
      reason:
        `${reason}; prior drops in the last ${CUMULATIVE_CAP_WINDOW_DAYS}d total ` +
        `${(((args.cumulativeDropPct ?? 0)) * 100).toFixed(0)}% ≥ ${(CUMULATIVE_DROP_CAP * 100).toFixed(0)}% cap`,
      blockedReason: "cumulative_cap"
    };
  }

  const floorKnown = args.floor !== null && args.floor !== undefined && args.floor > 0;
  const unclamped = Math.round(args.rate * (1 - dropPct));
  // Never propose below the listing's minimum price (ceil so a fractional floor
  // is never undercut by rounding).
  const proposedValue = floorKnown ? Math.max(unclamped, Math.ceil(args.floor as number)) : unclamped;
  if (proposedValue >= args.rate) {
    return {
      atRisk: true,
      revenueAtRisk,
      proposedValue: null,
      dropPct: 0,
      confidence,
      reason: `${reason}; drop clamped to min price ${proposedValue} ≥ current rate — no room to drop`,
      blockedReason: "min_floor"
    };
  }
  return {
    atRisk: true,
    revenueAtRisk,
    proposedValue,
    dropPct,
    confidence,
    reason,
    ...(floorKnown ? {} : { floorUnknown: true })
  };
}

/**
 * The `Suggestion.detail` JSON a regeneration writes. `curveCohort` is the
 * grain provenance (build prompt 07 Part A): which cohort curve — and at
 * what rung of the listing → group → size band → tenant ladder, on how many
 * bookings — this night was judged against. The ghost scorer merges its
 * `score` into the same JSON later; keys here must not collide with it.
 */
export type SuggestionDetail = {
  floorUnknown?: boolean;
  floor?: number;
  curveCohort?: CohortProvenance;
  /** Which cohort's DOW occupancy scaled the trigger for this night. */
  occupancyCohort?: CohortProvenance;
  /** Recs-page rows only (type "recs-night"): full-coverage 14-day window. */
  recsPage?: true;
  /** Recs-page: explicit "no change advised" (proposedValue === oldValue). */
  hold?: true;
  /** Recs-page: why an at-risk night's drop was withheld (visible memory). */
  suppressed?: SuggestionBlockedReason;
  /** Recs-page: the sizing decomposition (base curve size → prior → evidence
   * → market), one human-readable line per component that fired. */
  sizing?: { baseDropPct: number; finalDropPct: number; components: string[] };
};

export type SuggestionDraft = {
  listingId: string;
  /** External engine listing id (= Listing.hostawayId; PL uses PMS ids and WH
   * echoes the Hostaway id, verified 2026-07-18). Required for approve→push. */
  engineListingId?: string | null;
  date: string;
  oldValue: number;
  proposedValue: number;
  revenueAtRisk: number;
  confidence: number;
  reason: string;
  detail?: SuggestionDetail;
  /** Recs-page rows are typed "recs-night"; default (absent) = "timed-pct". */
  rowType?: "timed-pct" | "recs-night";
  /** Per-draft status override; default = the regeneration's status arg. */
  status?: "pending" | "shadow";
  /** warm-start | live-observed; recs-page rows always carry one. */
  provenance?: string;
  /** True when generated before the client's 30-day window graduated. */
  provisional?: boolean;
};

export type SuggestionNightInput = {
  listingId: string;
  date: string;
  daysToStay: number;
  booked: boolean;
  rate: number;
  /** Resolved minimum price for the listing; null/undefined = unknown (clamp skipped). */
  floor?: number | null;
  /** Local-event adjustment (%) covering this night; null/undefined = none. */
  eventAdjustmentPct?: number | null;
  /** An approved/applied suggestion already covers this night. */
  hasActionedSuggestion?: boolean;
  /** Sum of prior non-pending drop pcts (0..1) for this night, trailing window. */
  cumulativeDropPct?: number;
  /** Trailing-365d final occupancy (0..1) for this night's day-of-week. */
  occupancyFactor?: number;
  /** Unsold units on this night (multi-unit); scales revenueAtRisk. Default 1. */
  unsoldUnits?: number;
  /**
   * The listing's resolved cohort curve (listing → group → size band →
   * tenant ladder). When present its buckets replace the shared tenant
   * buckets for this night and its provenance is recorded on the draft's
   * detail. Absent = judge against the shared `buckets` (tenant curve).
   */
  curve?: { buckets: LeadTimeDistribution["buckets"]; provenance: CohortProvenance };
  /**
   * Provenance of the cohort whose DOW occupancy produced
   * `occupancyFactor`; recorded on the draft's detail when present.
   */
  occupancyProvenance?: CohortProvenance;
};

export type BuildSuggestionDraftsResult = {
  drafts: SuggestionDraft[];
  /** Would-be suggestions suppressed by a safety gate, by reason. Trust metric. */
  blocked: SuggestionBlockedCounts;
};

function countBlocked(blocked: SuggestionBlockedCounts, reason: SuggestionBlockedReason): void {
  blocked[reason] = (blocked[reason] ?? 0) + 1;
}

/**
 * Pure: turn forward nights + the curve into ordered, capped suggestion
 * drafts. Each night is judged against ITS OWN resolved cohort curve when
 * `night.curve` is set (`args.buckets` is the shared fallback), and the
 * cohort provenance is recorded on the draft's detail so a human can read
 * what the judgement was made against.
 */
export function buildSuggestionDrafts(args: {
  nights: SuggestionNightInput[];
  buckets: LeadTimeDistribution["buckets"];
  maxSuggestions?: number;
}): BuildSuggestionDraftsResult {
  const drafts: SuggestionDraft[] = [];
  const blocked: SuggestionBlockedCounts = {};
  for (const night of args.nights) {
    const judged = judgeNightForSuggestion({
      daysToStay: night.daysToStay,
      booked: night.booked,
      rate: night.rate,
      expectedFill: expectedCumulativeFill(night.daysToStay, night.curve?.buckets ?? args.buckets),
      floor: night.floor,
      eventAdjustmentPct: night.eventAdjustmentPct,
      hasActionedSuggestion: night.hasActionedSuggestion,
      cumulativeDropPct: night.cumulativeDropPct,
      occupancyFactor: night.occupancyFactor,
      unsoldUnits: night.unsoldUnits
    });
    if (judged.blockedReason) {
      countBlocked(blocked, judged.blockedReason);
      continue;
    }
    if (judged.atRisk && judged.proposedValue !== null) {
      const floorKnown = night.floor !== null && night.floor !== undefined && night.floor > 0;
      const detail: SuggestionDetail = {};
      if (judged.floorUnknown) detail.floorUnknown = true;
      else if (floorKnown) detail.floor = night.floor as number;
      if (night.curve) detail.curveCohort = night.curve.provenance;
      if (night.occupancyProvenance) detail.occupancyCohort = night.occupancyProvenance;
      drafts.push({
        listingId: night.listingId,
        date: night.date,
        oldValue: night.rate,
        proposedValue: judged.proposedValue,
        revenueAtRisk: judged.revenueAtRisk,
        confidence: judged.confidence,
        reason: judged.reason,
        ...(Object.keys(detail).length > 0 ? { detail } : {})
      });
    }
  }
  drafts.sort((a, b) => b.revenueAtRisk - a.revenueAtRisk);
  return { drafts: drafts.slice(0, args.maxSuggestions ?? MAX_SUGGESTIONS), blocked };
}

export type GenerateSuggestionsResult = {
  generated: number;
  topRevenueAtRisk: number | null;
  /** Would-be suggestions suppressed by the safety gates, by reason. */
  blocked: SuggestionBlockedCounts;
  /** `pending` (graduated: the human queue) or `shadow` (calibration only). */
  mode: "pending" | "shadow";
  /** Recs-page rows written for the 14-day window (subset of `generated`). */
  recsWindowRows?: number;
};

/** Injected sizing composer for recs-window nights (implemented in
 * src/lib/recs — injected so this module never imports recs code). Returning
 * null keeps the base curve-derived size. */
export type RecsNightComposer = (
  night: SuggestionNightInput,
  judged: NightJudgement
) => { dropPct: number; hold: boolean; components: string[] } | null;

export type RecsPageConfig = {
  /** Page window in days (spec: 14). */
  windowDays: number;
  provenance: "warm-start" | "live-observed";
  /** Client not yet graduated — rows are approvable but labelled provisional. */
  provisional: boolean;
  /** Nights human-actioned within this many days are not re-suggested unless
   * the world moved materially (spec: start N=3). */
  recentActionedDays: number;
  composeNight?: RecsNightComposer;
};

/**
 * Pure: full-coverage recs-page drafts for the nights inside the page window.
 * Every AVAILABLE night gets exactly one row — a sized drop, an explicit hold
 * ("no change advised" is a valid, approvable rec), or a hold carrying a
 * visible suppression reason — EXCEPT nights already covered by a human-
 * actioned suggestion (the actioned row itself remains the record; emitting a
 * fresh row would compound or silently re-suggest a made decision).
 */
export function buildRecsWindowDrafts(args: {
  nights: SuggestionNightInput[];
  buckets: LeadTimeDistribution["buckets"];
  cfg: RecsPageConfig;
  /** listingId|date → most recent rejected action within the memory window. */
  recentRejected: Map<string, { actionedAt: Date; oldValueAtAction: number | null }>;
}): BuildSuggestionDraftsResult {
  const drafts: SuggestionDraft[] = [];
  const blocked: SuggestionBlockedCounts = {};
  const base = { rowType: "recs-night" as const, provenance: args.cfg.provenance, provisional: args.cfg.provisional };

  for (const night of args.nights) {
    if (night.booked || night.rate <= 0 || night.daysToStay < 0) continue; // available nights only
    if (night.hasActionedSuggestion) continue; // the approved/applied row is the record

    const judged = judgeNightForSuggestion({
      daysToStay: night.daysToStay,
      booked: night.booked,
      rate: night.rate,
      expectedFill: expectedCumulativeFill(night.daysToStay, night.curve?.buckets ?? args.buckets),
      floor: night.floor,
      eventAdjustmentPct: night.eventAdjustmentPct,
      hasActionedSuggestion: false,
      cumulativeDropPct: night.cumulativeDropPct,
      occupancyFactor: night.occupancyFactor,
      unsoldUnits: night.unsoldUnits
    });

    const floorKnown = night.floor !== null && night.floor !== undefined && night.floor > 0;
    const detailBase: SuggestionDetail = { recsPage: true };
    if (floorKnown) detailBase.floor = night.floor as number;
    else detailBase.floorUnknown = true;
    if (night.curve) detailBase.curveCohort = night.curve.provenance;
    if (night.occupancyProvenance) detailBase.occupancyCohort = night.occupancyProvenance;

    const pushHold = (reason: string, extra: Partial<SuggestionDetail>, revenueAtRisk: number, confidence: number): void => {
      drafts.push({
        ...base,
        listingId: night.listingId,
        date: night.date,
        oldValue: night.rate,
        proposedValue: night.rate,
        revenueAtRisk,
        confidence,
        reason,
        detail: { ...detailBase, hold: true, ...extra }
      });
    };

    // Decision memory: a rejection inside the window stands unless the world
    // moved materially (price basis shifted ≥1%; availability changes remove
    // the night from this list upstream).
    const recent = args.recentRejected.get(`${night.listingId}|${night.date}`);
    if (recent) {
      const oldVal = recent.oldValueAtAction;
      const priceMoved = oldVal !== null && oldVal > 0 && Math.abs(night.rate - oldVal) / oldVal >= 0.01;
      if (!priceMoved) {
        countBlocked(blocked, "recently_actioned");
        pushHold(
          `a drop for this night was rejected on ${toDateOnly(recent.actionedAt)} and the price basis is unchanged — decision stands, not re-suggesting yet`,
          { suppressed: "recently_actioned" },
          judged.atRisk ? judged.revenueAtRisk : 0,
          judged.confidence
        );
        continue;
      }
    }

    if (!judged.atRisk) {
      // On pace — an explicit, approvable "no change advised".
      pushHold(`on pace — no change advised; ${judged.reason}`, {}, 0, judged.confidence);
      continue;
    }

    if (judged.blockedReason) {
      // At risk, but a safety gate held the drop back. Surface it, don't hide it.
      countBlocked(blocked, judged.blockedReason);
      pushHold(`held back (${judged.blockedReason.replace(/_/g, " ")}): ${judged.reason}`, { suppressed: judged.blockedReason }, judged.revenueAtRisk, judged.confidence);
      continue;
    }

    // Drop path. The composer layers Mark-prior + outcome evidence + market on
    // top of the curve-derived base size; absent (or returning null) the base
    // size ships untouched. Floors re-clamp AFTER composition — evidence can
    // never push a price below the minimum.
    const composed = args.cfg.composeNight?.(night, judged) ?? null;
    if (composed?.hold) {
      pushHold(`${judged.reason}; ${composed.components.join("; ")}`, { sizing: { baseDropPct: judged.dropPct, finalDropPct: 0, components: composed.components } }, judged.revenueAtRisk, judged.confidence);
      continue;
    }
    const finalDropPct = composed ? composed.dropPct : judged.dropPct;
    const unclamped = Math.round(night.rate * (1 - finalDropPct));
    const proposedValue = floorKnown ? Math.max(unclamped, Math.ceil(night.floor as number)) : unclamped;
    if (proposedValue >= night.rate) {
      countBlocked(blocked, "min_floor");
      pushHold(`held back (min floor): drop clamped to min price ${proposedValue} ≥ current rate; ${judged.reason}`, { suppressed: "min_floor" }, judged.revenueAtRisk, judged.confidence);
      continue;
    }
    drafts.push({
      ...base,
      listingId: night.listingId,
      date: night.date,
      oldValue: night.rate,
      proposedValue,
      revenueAtRisk: judged.revenueAtRisk,
      confidence: judged.confidence,
      reason: composed ? `${judged.reason}; ${composed.components.join("; ")}` : judged.reason,
      detail: {
        ...detailBase,
        ...(composed ? { sizing: { baseDropPct: judged.dropPct, finalDropPct, components: composed.components } } : {})
      }
    });
  }
  return { drafts, blocked };
}

/** The exact row shape a regeneration writes to the `Suggestion` table. */
export type SuggestionInsertRow = {
  tenantId: string;
  clientKey: string;
  listingId: string;
  engineListingId?: string | null;
  dateFrom: Date;
  dateTo: Date;
  lever: "price";
  oldValue: number;
  proposedValue: number;
  type: "timed-pct" | "recs-night";
  reason: string;
  revenueAtRisk: number;
  confidence: number;
  status: "pending" | "shadow";
  detail?: SuggestionDetail;
  provenance?: string;
  provisional?: boolean;
};

/** The two `Suggestion`-table writes a regeneration needs (prisma or a fake). */
export type SuggestionRegenerationStore = {
  updateMany(args: {
    where: { tenantId: string; clientKey: string; status: { in: string[] } };
    data: { status: "superseded" };
  }): Promise<unknown>;
  createMany(args: { data: SuggestionInsertRow[] }): Promise<unknown>;
};

/**
 * Persist one regeneration pass: mark the client's prior machine-written rows
 * (`pending` + `shadow`) as `superseded` — never deleted; they are the ghost
 * scorer's raw material — then insert the fresh drafts with the given status
 * (`pending` for graduated clients, `shadow` during the observation window).
 * Human-actioned rows are untouched. Tenant + clientKey scoped.
 */
export async function applySuggestionRegeneration(args: {
  store: SuggestionRegenerationStore;
  tenantId: string;
  clientKey: string;
  status: "pending" | "shadow";
  drafts: SuggestionDraft[];
}): Promise<void> {
  await args.store.updateMany({
    where: { tenantId: args.tenantId, clientKey: args.clientKey, status: { in: [...SUPERSEDABLE_STATUSES] } },
    data: { status: "superseded" }
  });
  if (args.drafts.length > 0) {
    await args.store.createMany({
      data: args.drafts.map((d) => ({
        tenantId: args.tenantId,
        clientKey: args.clientKey,
        listingId: d.listingId,
        ...(d.engineListingId ? { engineListingId: d.engineListingId } : {}),
        dateFrom: fromDateOnly(d.date),
        dateTo: fromDateOnly(d.date),
        lever: "price" as const,
        oldValue: d.oldValue,
        proposedValue: d.proposedValue,
        type: d.rowType ?? ("timed-pct" as const),
        reason: d.reason,
        revenueAtRisk: d.revenueAtRisk,
        confidence: d.confidence,
        status: d.status ?? args.status,
        ...(d.detail ? { detail: d.detail } : {}),
        ...(d.provenance ? { provenance: d.provenance } : {}),
        ...(d.provisional !== undefined ? { provisional: d.provisional } : {})
      }))
    });
  }
}

/**
 * Resolve the local events visible to the suggestion generator, via the shared
 * `eventAdjustmentForDate` helper's input shape (CLAUDE.md: one source of truth
 * for event date resolution; nothing is routed through `settings.localEvents`
 * writes). Two read-only sources:
 * 1. The trial-only events file (`trial-events.ts`) — e.g. Fleadh Cheoil 2026.
 * 2. Any `localEvents` already present in the tenant's pricing settings.
 * Portfolio/group-scope events apply tenant-wide (conservative: for a drop
 * SHIELD, over-blocking is the safe direction); property-scope events apply to
 * that listing only. Tenant-scoped, read-only. Also reused by the weekly
 * learner report's "coming up" section (weekly-report.ts).
 */
export async function resolveLocalEvents(args: {
  tenantId: string;
}): Promise<{ tenantWide: PricingLocalEvent[]; byListingId: Map<string, PricingLocalEvent[]> }> {
  const [tenant, settingRows] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: args.tenantId }, select: { id: true, name: true } }),
    prisma.pricingSetting.findMany({
      where: { tenantId: args.tenantId },
      select: { scope: true, scopeRef: true, settings: true }
    })
  ]);
  const tenantWide: PricingLocalEvent[] = tenant
    ? [...getTrialLocalEventsForTenant({ id: tenant.id, name: tenant.name, slug: tenantNameSlug(tenant.name) })]
    : [];
  const byListingId = new Map<string, PricingLocalEvent[]>();
  for (const row of settingRows) {
    const events = parsePricingSettingsOverride(row.settings).localEvents;
    if (!events || events.length === 0) continue;
    if (row.scope === "property" && typeof row.scopeRef === "string" && row.scopeRef.trim()) {
      const key = row.scopeRef.trim();
      byListingId.set(key, [...(byListingId.get(key) ?? []), ...events]);
    } else {
      tenantWide.push(...events);
    }
  }
  return { tenantWide, byListingId };
}

/**
 * Resolve each listing's minimum-price floor. Resolution order (first hit wins):
 * 1. Latest `EngineSnapshot.min` for the listing (the engine's own floor).
 * 2. The pricing-settings `minimumPriceOverride` for the listing (property scope).
 * 3. The lowest rate observed for the listing in `rate_states` over the trailing
 *    `FLOOR_LOOKBACK_DAYS` days.
 * Listings with no hit are absent from the map (floor unknown → clamp skipped,
 * draft flagged `floorUnknown`). Tenant-scoped, read-only.
 */
async function resolveListingFloors(args: {
  tenantId: string;
  listingIds: string[];
  today: Date;
}): Promise<Map<string, number>> {
  const { tenantId, listingIds } = args;
  const floors = new Map<string, number>();
  if (listingIds.length === 0) return floors;

  const [snapshotMins, settingRows, observedMins] = await Promise.all([
    // distinct+orderBy ⇒ the newest snapshot per listing that carries a min.
    prisma.engineSnapshot.findMany({
      where: { tenantId, listingId: { in: listingIds }, min: { not: null } },
      orderBy: { capturedAt: "desc" },
      distinct: ["listingId"],
      select: { listingId: true, min: true }
    }),
    prisma.pricingSetting.findMany({
      where: { tenantId, scope: "property", scopeRef: { in: listingIds } },
      select: { scopeRef: true, settings: true }
    }),
    prisma.rateState.groupBy({
      by: ["listingId"],
      where: {
        tenantId,
        listingId: { in: listingIds },
        rate: { gt: 0 },
        date: { gte: addUtcDays(args.today, -FLOOR_LOOKBACK_DAYS), lte: args.today }
      },
      _min: { rate: true }
    })
  ]);

  // Apply in reverse priority so higher-priority sources overwrite.
  for (const row of observedMins) {
    const min = row._min.rate === null ? null : Number(row._min.rate);
    if (min !== null && min > 0) floors.set(row.listingId, min);
  }
  for (const row of settingRows) {
    if (typeof row.scopeRef !== "string") continue;
    const parsed = parsePricingSettingsOverride(row.settings);
    const min = parsed.minimumPriceOverride;
    if (typeof min === "number" && min > 0) floors.set(row.scopeRef, min);
  }
  for (const row of snapshotMins) {
    const min = row.min === null ? null : Number(row.min);
    if (row.listingId && min !== null && min > 0) floors.set(row.listingId, min);
  }
  return floors;
}

/**
 * Per-night guards against compounding drops, from prior `Suggestion` rows for
 * the SAME tenant/listing/date (any clientKey — night safety is per night):
 * - `actioned`: nights covered by an approved/applied suggestion (never re-drop).
 * - `cumulativeDropPct`: sum of non-pending drop pcts created within the trailing
 *   `CUMULATIVE_CAP_WINDOW_DAYS` days, keyed `listingId|date`.
 * Tenant-scoped, read-only.
 */
async function resolvePriorSuggestionGuards(args: {
  tenantId: string;
  today: Date;
  horizonEnd: Date;
  now: Date;
  /** When set, also collect rejections actioned within this many days for the
   * recs-page decision memory (recently_actioned suppression). */
  recentRejectedDays?: number;
}): Promise<{
  actioned: Set<string>;
  cumulativeDropPct: Map<string, number>;
  recentRejected: Map<string, { actionedAt: Date; oldValueAtAction: number | null }>;
}> {
  const { tenantId, today, horizonEnd } = args;
  const [actionedRows, rejectedRows, recentRows] = await Promise.all([
    prisma.suggestion.findMany({
      where: {
        tenantId,
        lever: "price",
        status: { in: ["approved", "applied"] },
        listingId: { not: null },
        dateTo: { gte: today },
        dateFrom: { lte: horizonEnd }
      },
      select: { listingId: true, dateFrom: true, dateTo: true }
    }),
    args.recentRejectedDays
      ? prisma.suggestion.findMany({
          where: {
            tenantId,
            lever: "price",
            status: "rejected",
            listingId: { not: null },
            actionedAt: { gte: addUtcDays(args.now, -args.recentRejectedDays) },
            dateTo: { gte: today },
            dateFrom: { lte: horizonEnd }
          },
          select: { listingId: true, dateFrom: true, dateTo: true, actionedAt: true, oldValue: true }
        })
      : Promise.resolve([] as Array<{ listingId: string | null; dateFrom: Date; dateTo: Date; actionedAt: Date | null; oldValue: unknown }>),
    prisma.suggestion.findMany({
      where: {
        tenantId,
        lever: "price",
        // Only rows a human (or a push) acted on count toward the anti-ratchet
        // cap. `superseded` and `shadow` rows were never applied — before the
        // supersession change they were simply deleted, so counting them now
        // would wrongly ratchet-block every regenerated night.
        status: { notIn: [...SUPERSEDABLE_STATUSES, "superseded"] },
        listingId: { not: null },
        createdAt: { gte: addUtcDays(args.now, -CUMULATIVE_CAP_WINDOW_DAYS) },
        oldValue: { not: null },
        proposedValue: { not: null },
        dateTo: { gte: today },
        dateFrom: { lte: horizonEnd }
      },
      select: { listingId: true, dateFrom: true, dateTo: true, oldValue: true, proposedValue: true }
    })
  ]);

  const eachNight = (dateFrom: Date, dateTo: Date, visit: (dateStr: string) => void): void => {
    let cursor = dateFrom.getTime() > today.getTime() ? dateFrom : today;
    const end = dateTo.getTime() < horizonEnd.getTime() ? dateTo : horizonEnd;
    while (cursor.getTime() <= end.getTime()) {
      visit(toDateOnly(cursor));
      cursor = addUtcDays(cursor, 1);
    }
  };

  const actioned = new Set<string>();
  for (const row of actionedRows) {
    eachNight(row.dateFrom, row.dateTo, (dateStr) => actioned.add(`${row.listingId}|${dateStr}`));
  }

  const cumulativeDropPct = new Map<string, number>();
  for (const row of recentRows) {
    const oldValue = Number(row.oldValue);
    const proposedValue = Number(row.proposedValue);
    if (!(oldValue > 0) || !(proposedValue < oldValue)) continue; // only actual drops count
    const dropPct = (oldValue - proposedValue) / oldValue;
    eachNight(row.dateFrom, row.dateTo, (dateStr) => {
      const key = `${row.listingId}|${dateStr}`;
      cumulativeDropPct.set(key, (cumulativeDropPct.get(key) ?? 0) + dropPct);
    });
  }

  // Most recent rejection per night inside the memory window (recs page only).
  const recentRejected = new Map<string, { actionedAt: Date; oldValueAtAction: number | null }>();
  for (const row of rejectedRows) {
    if (!row.actionedAt) continue;
    const oldValueAtAction = row.oldValue === null || row.oldValue === undefined ? null : Number(row.oldValue);
    eachNight(row.dateFrom, row.dateTo, (dateStr) => {
      const key = `${row.listingId}|${dateStr}`;
      const existing = recentRejected.get(key);
      if (!existing || existing.actionedAt.getTime() < (row.actionedAt as Date).getTime()) {
        recentRejected.set(key, { actionedAt: row.actionedAt as Date, oldValueAtAction });
      }
    });
  }
  return { actioned, cumulativeDropPct, recentRejected };
}

/**
 * Generate `Suggestion` rows for a client — `pending` for graduated clients,
 * `shadow` from day 1 for clients still observing (calibration data only). The
 * client's prior machine-written rows (pending/shadow) are marked `superseded`
 * — not deleted — so the list stays fresh with pace while the history survives
 * for scoring. Approved/rejected/applied rows are untouched. Tenant-scoped;
 * writes only the `Suggestion` table.
 */
export async function generateSuggestionsForClient(args: {
  tenantId: string;
  clientKey: string;
  now?: Date;
  horizonDays?: number;
  maxSuggestions?: number;
  /**
   * `pending` (default) for graduated clients — the human-approval queue.
   * `shadow` for clients still inside the observation window: rows are written
   * from day 1 purely as calibration data for the ghost scorer, and are never
   * shown in the readout's pending list or the day-30 email.
   */
  status?: "pending" | "shadow";
  /**
   * Recs-page mode (2026-07-18): nights inside `windowDays` get FULL-COVERAGE
   * rows (sized drop / explicit hold / visible suppression, type "recs-night",
   * always status "pending", `provisional` when ungraduated) so the internal
   * approvals page can show every available night day-by-day. Nights beyond
   * the window keep the existing at-risk-only behaviour and status.
   */
  recsPage?: RecsPageConfig;
}): Promise<GenerateSuggestionsResult> {
  const { tenantId, clientKey } = args;
  const now = args.now ?? new Date();
  const mode = args.status ?? "pending";
  const today = fromDateOnly(toDateOnly(now));
  const horizonEnd = addUtcDays(today, args.horizonDays ?? SUGGESTION_HORIZON_DAYS);

  // Cohort curve ladder (build prompt 07 Part A): each listing-night is
  // judged against the most specific curve its own data supports — listing →
  // group → tenant × size band → tenant — instead of one pooled tenant curve
  // (the granularity audit's Argo-54d-vs-St-James-3d miscalibration).
  const trailingWindowStart = addUtcDays(today, -365);
  const [listingRows, trailingFacts] = await Promise.all([
    prisma.listing.findMany({
      where: { tenantId, removedAt: null },
      select: { id: true, tags: true, bedroomsNumber: true, city: true, unitCount: true, hostawayId: true }
    }),
    prisma.nightFact.findMany({
      where: { tenantId, isOccupied: true, date: { gte: trailingWindowStart, lt: today } },
      select: { listingId: true, date: true, leadTimeDays: true, reservationId: true }
    })
  ]);
  const curveSet = buildCohortCurveSet({
    listings: listingRows,
    facts: trailingFacts
      .filter((f) => f.leadTimeDays !== null)
      .map((f) => ({ listingId: f.listingId, leadTimeDays: f.leadTimeDays as number, reservationId: f.reservationId }))
  });
  // The tenant rung is exactly the old tenant-wide curve; same skip gate.
  if (!curveSet.tenant || curveSet.tenant.distribution.n < MIN_TENANT_LEAD_NIGHTS) {
    return { generated: 0, topRevenueAtRisk: null, blocked: {}, mode }; // not enough lead-time signal yet
  }
  const curveByListing = new Map<string, ResolvedCohortCurve | null>();
  const curveForListing = (listingId: string): ResolvedCohortCurve | null => {
    let resolved = curveByListing.get(listingId);
    if (resolved === undefined) {
      resolved = resolveCohortCurve(curveSet, listingId);
      curveByListing.set(listingId, resolved);
    }
    return resolved;
  };

  // Cohort DOW occupancy: the trigger's occupancy scaler resolves through the
  // same ladder, so each listing is calibrated against its own (or its
  // group's) occupancy — a ~200-unit student block no longer drowns 50 flats
  // in a unit-weighted tenant average (the audit's Little Feather case).
  const occupancySet = buildCohortOccupancySet({
    listings: listingRows,
    occupied: trailingFacts.map((f) => ({ listingId: f.listingId, date: toDateOnly(f.date) })),
    windowStart: toDateOnly(trailingWindowStart),
    windowEnd: toDateOnly(today)
  });
  const occupancyByListing = new Map<string, ResolvedCohortOccupancy | null>();
  const occupancyForListing = (listingId: string): ResolvedCohortOccupancy | null => {
    let resolved = occupancyByListing.get(listingId);
    if (resolved === undefined) {
      resolved = resolveCohortOccupancy(occupancySet, listingId);
      occupancyByListing.set(listingId, resolved);
    }
    return resolved;
  };

  const [available, occupied] = await Promise.all([
    prisma.calendarRate.findMany({
      where: { tenantId, available: true, date: { gte: today, lte: horizonEnd } },
      select: { listingId: true, date: true, rate: true }
    }),
    prisma.nightFact.findMany({
      where: { tenantId, isOccupied: true, date: { gte: today, lte: horizonEnd } },
      select: { listingId: true, date: true }
    })
  ]);
  // Occupied UNITS per (listing, date) — multi-unit listings (unitCount >= 2)
  // sell N rooms of one type, so one occupied NightFact is one unit sold.
  const occupiedUnitsByNight = new Map<string, number>();
  for (const o of occupied) {
    const key = `${o.listingId}|${toDateOnly(o.date)}`;
    occupiedUnitsByNight.set(key, (occupiedUnitsByNight.get(key) ?? 0) + 1);
  }
  const unitCountByListing = new Map(listingRows.map((l) => [l.id, Math.max(1, l.unitCount ?? 1)]));

  const candidateListingIds = [...new Set(available.map((a) => a.listingId))];
  const [floors, localEvents, priorGuards] = await Promise.all([
    resolveListingFloors({ tenantId, listingIds: candidateListingIds, today }),
    resolveLocalEvents({ tenantId }),
    resolvePriorSuggestionGuards({
      tenantId,
      today,
      horizonEnd,
      now,
      ...(args.recsPage ? { recentRejectedDays: args.recsPage.recentActionedDays } : {})
    })
  ]);
  const eventsForListing = (listingId: string): PricingLocalEvent[] => {
    const propertyEvents = localEvents.byListingId.get(listingId);
    return propertyEvents ? [...localEvents.tenantWide, ...propertyEvents] : localEvents.tenantWide;
  };

  const nights: SuggestionNightInput[] = available.map((a) => {
    const dateStr = toDateOnly(a.date);
    const nightKey = `${a.listingId}|${dateStr}`;
    const unitCount = unitCountByListing.get(a.listingId) ?? 1;
    const occupiedUnits = Math.min(occupiedUnitsByNight.get(nightKey) ?? 0, unitCount);
    const resolvedCurve = curveForListing(a.listingId);
    const resolvedOccupancy = occupancyForListing(a.listingId);
    return {
      ...(resolvedCurve ? { curve: { buckets: resolvedCurve.buckets, provenance: resolvedCurve.provenance } } : {}),
      ...(resolvedOccupancy ? { occupancyProvenance: resolvedOccupancy.provenance } : {}),
      listingId: a.listingId,
      date: dateStr,
      daysToStay: Math.round((a.date.getTime() - today.getTime()) / (24 * 60 * 60 * 1000)),
      // Multi-unit: only a fully-sold night counts as booked; a 40-unit building
      // with one unit sold still has 39 units at risk.
      booked: unitCount >= 2 ? occupiedUnits >= unitCount : occupiedUnits > 0,
      rate: Number(a.rate),
      floor: floors.get(a.listingId) ?? null,
      eventAdjustmentPct: eventAdjustmentForDate(eventsForListing(a.listingId), dateStr)?.adjustmentPct ?? null,
      hasActionedSuggestion: priorGuards.actioned.has(nightKey),
      cumulativeDropPct: priorGuards.cumulativeDropPct.get(nightKey) ?? 0,
      occupancyFactor: resolvedOccupancy?.factors[a.date.getUTCDay()] ?? 1,
      unsoldUnits: Math.max(1, unitCount - occupiedUnits)
    };
  });

  // Recs-page mode: nights inside the page window get full-coverage rows; the
  // at-risk-only stream continues for the nights beyond it. One combined
  // regeneration pass so supersession stays a single, atomic-by-convention step.
  const recsCfg = args.recsPage ?? null;
  const windowNights = recsCfg ? nights.filter((n) => n.daysToStay <= recsCfg.windowDays) : [];
  const beyondNights = recsCfg ? nights.filter((n) => n.daysToStay > recsCfg.windowDays) : nights;

  const beyond = buildSuggestionDrafts({
    nights: beyondNights,
    buckets: curveSet.tenant.distribution.buckets,
    maxSuggestions: args.maxSuggestions
  });
  const recsWindow = recsCfg
    ? buildRecsWindowDrafts({
        nights: windowNights,
        buckets: curveSet.tenant.distribution.buckets,
        cfg: recsCfg,
        recentRejected: priorGuards.recentRejected
      })
    : { drafts: [], blocked: {} as SuggestionBlockedCounts };
  // Recs-window rows are always pending (the approvals page is the consumer);
  // beyond-window rows keep the caller's status (pending/shadow).
  const recsDrafts = recsWindow.drafts.map((d) => ({ ...d, status: "pending" as const }));

  // Stamp the engine listing id (= hostawayId) on every draft so approve→push
  // can address the engine without a backfill (data-integrity review B-1).
  const engineIdByListing = new Map(listingRows.map((l) => [l.id, l.hostawayId ? String(l.hostawayId) : null]));
  const drafts = [...recsDrafts, ...beyond.drafts].map((d) => ({
    ...d,
    engineListingId: engineIdByListing.get(d.listingId) ?? null
  }));
  const blocked: SuggestionBlockedCounts = { ...beyond.blocked };
  for (const [reason, count] of Object.entries(recsWindow.blocked)) {
    const key = reason as SuggestionBlockedReason;
    blocked[key] = (blocked[key] ?? 0) + (count ?? 0);
  }

  // Supersede prior machine-written rows (never delete — history is the ghost
  // scorer's evidence), then insert the fresh generation.
  await applySuggestionRegeneration({ store: prisma.suggestion, tenantId, clientKey, status: mode, drafts });

  // Persist the blocked-by-reason counts (trust metric) on the client's
  // observation window so the readout can render its "blocked" line.
  const blockedTotal = Object.values(blocked).reduce((sum, n) => sum + (n ?? 0), 0);
  await prisma.observationWindow.updateMany({
    where: { tenantId, clientKey },
    data: {
      lastSuggestionRun: {
        generatedAt: now.toISOString(),
        generated: drafts.length,
        mode,
        blocked,
        blockedTotal
      }
    }
  });

  return {
    generated: drafts.length,
    topRevenueAtRisk: beyond.drafts[0]?.revenueAtRisk ?? recsDrafts[0]?.revenueAtRisk ?? null,
    blocked,
    mode,
    ...(recsCfg ? { recsWindowRows: recsDrafts.length } : {})
  };
}

/**
 * Read `{rung, cohortKey, n}` provenance out of a persisted detail JSON field,
 * defensively (rows written before the cohort ladder carry none). Pure.
 */
export function readProvenanceFromDetail(value: unknown): CohortProvenance | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as { rung?: unknown; cohortKey?: unknown; n?: unknown };
  if (typeof p.rung !== "string" || typeof p.cohortKey !== "string" || typeof p.n !== "number") return null;
  return { rung: p.rung as CohortProvenance["rung"], cohortKey: p.cohortKey, n: p.n };
}

/** Read a client's suggestions ordered by revenue at risk. Tenant-scoped, read-only. */
export async function readSuggestions(args: {
  tenantId: string;
  clientKey?: string;
  status?: string;
  limit?: number;
  /** e.g. ["recs-night"] — keeps the readout's pending list on the classic
   * at-risk stream while the recs page reads its own full-coverage rows. */
  excludeTypes?: string[];
}): Promise<
  Array<{
    listingId: string | null;
    dateFrom: string;
    dateTo: string;
    lever: string;
    oldValue: number | null;
    proposedValue: number | null;
    type: string;
    reason: string;
    revenueAtRisk: number | null;
    confidence: number | null;
    status: string;
    /** The cohort curve this night was judged against (rung/cohort/n). */
    curveCohort: CohortProvenance | null;
    /** The cohort occupancy the trigger was scaled by (rung/cohort/n). */
    occupancyCohort: CohortProvenance | null;
  }>
> {
  const rows = await prisma.suggestion.findMany({
    where: {
      tenantId: args.tenantId,
      ...(args.clientKey ? { clientKey: args.clientKey } : {}),
      ...(args.status ? { status: args.status } : {}),
      ...(args.excludeTypes && args.excludeTypes.length > 0 ? { type: { notIn: args.excludeTypes } } : {})
    },
    orderBy: { revenueAtRisk: "desc" },
    take: args.limit ?? 100,
    select: {
      listingId: true,
      dateFrom: true,
      dateTo: true,
      lever: true,
      oldValue: true,
      proposedValue: true,
      type: true,
      reason: true,
      revenueAtRisk: true,
      confidence: true,
      status: true,
      detail: true
    }
  });
  return rows.map((r) => {
    const detail =
      r.detail && typeof r.detail === "object" && !Array.isArray(r.detail)
        ? (r.detail as { curveCohort?: unknown; occupancyCohort?: unknown })
        : null;
    return {
      listingId: r.listingId,
      dateFrom: toDateOnly(r.dateFrom),
      dateTo: toDateOnly(r.dateTo),
      lever: r.lever,
      oldValue: r.oldValue === null ? null : Number(r.oldValue),
      proposedValue: r.proposedValue === null ? null : Number(r.proposedValue),
      type: r.type,
      reason: r.reason,
      revenueAtRisk: r.revenueAtRisk === null ? null : Number(r.revenueAtRisk),
      confidence: r.confidence === null ? null : Number(r.confidence),
      status: r.status,
      curveCohort: readProvenanceFromDetail(detail?.curveCohort),
      occupancyCohort: readProvenanceFromDetail(detail?.occupancyCohort)
    };
  });
}
