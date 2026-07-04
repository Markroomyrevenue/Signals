/**
 * The siloed per-client profile (SIGNALS-OBSERVE-LEARN-SPEC.md §8).
 *
 * The living strategy doc for ONE client — especially where it diverges from the
 * global norm, recorded as explicit client RULES (not global overrides). Built
 * purely from the client's learnings so it is unit-testable; the writer upserts
 * a versioned `ClientProfile` row. Siloed by `tenantId`; only the abstracted,
 * anonymised view ever feeds `GlobalMethodology` (see `global-methodology.ts`).
 */

import { prisma } from "@/lib/prisma";

import type { PromoGapLearning } from "./actual-paid";
import type { ClientLearnings } from "./learnings";
import type { DateType, RateSensitivity } from "./learnings-core";

/** An explicit, client-specific divergence rule (spec §8 worked example). */
export type ClientRule = {
  key: string;
  description: string;
  /** Structured payload the later push stage can enforce (Phase 5). */
  params?: Record<string, unknown>;
};

export type ClientProfileDoc = {
  engine: string;
  computedAt: string;
  /** Learning #1 — bookings-per-listing-day after a price drop, subject vs its
   *  recorded peer control (weekly settle; measured on PeerControl rows). */
  pickupVelocity: {
    movedPerListingDay: number;
    controlPerListingDay: number;
    /** (moved / control) − 1; null when the controls booked nothing. */
    liftPct: number | null;
    /** Measured events WITH a control — the learning's n. */
    eventsWithControl: number;
    windowDays: number;
  } | null;
  /** How far/late they move + the typical commit window. */
  leadTime: { medianLeadDays: number | null; bucketPcts: Record<string, number> } | null;
  /** Appetite for drops vs holding premium nights empty (settled nights only).
   *  `heldTooLowPct` is null when the tenant has no engine min data — the
   *  direction is unmeasurable, not zero. */
  regret: {
    heldTooLowPct: number | null;
    heldTooHighPct: number;
    total: number;
    windowDays: number;
    emptyNights: number;
    expectedEmpties: number | null;
    baselineSource: string;
  } | null;
  /** Which date types carry pricing power (book regardless of rate). */
  pricingPower: Partial<Record<DateType, { sensitivity: RateSensitivity; occupancy: number }>> | null;
  /** Per-engine reaction profile (claw_back / fight / hold fractions). */
  engineReaction: { available: boolean; dominant: string | null; fractions: Record<string, number> };
  /** Net realised rate drag from fees/discounts. */
  feeDragPct: number | null;
  /** Cancellation-quality signal. */
  cancellationSignal: string | null;
  /** Learning #8 — actual-paid promo gap per channel + cohort (weekly settle).
   *  Channel medians include the structural VAT/fee wedge, which is why the
   *  ghost scorer judges "heavy promo" against the channel's own median. */
  promoGap: PromoGapLearning | null;
  /** The divergences, codified as explicit rules. */
  rules: ClientRule[];
};

/** Share of regret outcomes (held-too-low) above which a below-min habit is real. */
export const BELOW_MIN_RULE_THRESHOLD = 0.15;
/** Share of held-too-high above which the client tolerates empty premium nights. */
export const EMPTY_PREMIUM_RULE_THRESHOLD = 0.25;

function dominantReaction(fractions: Record<string, number>): string | null {
  let best: string | null = null;
  let bestVal = 0;
  for (const [k, v] of Object.entries(fractions)) {
    if (k === "unknown") continue;
    if (v > bestVal) {
      bestVal = v;
      best = k;
    }
  }
  return bestVal > 0 ? best : null;
}

/**
 * Assemble the per-client profile from its learnings, deriving the divergence
 * rules. Pure — no DB, no identifiers beyond the engine label.
 */
export function buildClientProfileDoc(learnings: ClientLearnings): ClientProfileDoc {
  const rules: ClientRule[] = [];

  const leadTime = learnings.leadTime
    ? {
        medianLeadDays: learnings.leadTime.medianLeadDays,
        bucketPcts: Object.fromEntries(learnings.leadTime.buckets.map((b) => [b.label, b.pct]))
      }
    : null;

  const regret = learnings.regret
    ? {
        heldTooLowPct:
          learnings.regret.heldTooLow === null
            ? null
            : learnings.regret.total > 0
              ? learnings.regret.heldTooLow / learnings.regret.total
              : 0,
        heldTooHighPct: learnings.regret.total > 0 ? learnings.regret.heldTooHigh / learnings.regret.total : 0,
        total: learnings.regret.total,
        windowDays: learnings.regret.windowDays,
        emptyNights: learnings.regret.emptyNights,
        expectedEmpties: learnings.regret.expectedEmpties,
        baselineSource: learnings.regret.baselineSource
      }
    : null;

  // Divergence rule 1 — an OBSERVATION, not a permission. A learned below-min
  // PERMISSION must not exist until it is validated against settled outcomes,
  // so no `allowBelowMin*` param is emitted. May not fire when its input is
  // absent: `heldTooLowPct` is null when the tenant has no engine min data.
  if (
    regret &&
    regret.heldTooLowPct !== null &&
    regret.total >= 10 &&
    regret.heldTooLowPct >= BELOW_MIN_RULE_THRESHOLD
  ) {
    rules.push({
      key: "below_min_long_lead",
      description:
        "Observation: routinely sells at/below the engine minimum on LONG booking leads (snapped up far earlier than typical). Observation only — below-min moves stay blocked until validated against settled outcomes.",
      params: {
        observationOnly: true,
        heldTooLowPct: regret.heldTooLowPct,
        n: regret.total,
        windowDays: regret.windowDays
      }
    });
  }

  // Divergence rule 2: tolerance for empty premium nights (holds high to the
  // wire). Requires a seasonal baseline — without one every empty counts as
  // excess (one-sided input) and the rule may not fire.
  if (
    regret &&
    regret.total >= 10 &&
    regret.baselineSource !== "none" &&
    regret.heldTooHighPct >= EMPTY_PREMIUM_RULE_THRESHOLD
  ) {
    rules.push({
      key: "tolerates_empty_premium",
      description: "Tolerates empty premium nights to the wire — slower to discount close-in.",
      params: {
        heldTooHighPct: regret.heldTooHighPct,
        n: regret.total,
        windowDays: regret.windowDays,
        baselineSource: regret.baselineSource
      }
    });
  }

  const pricingPower = learnings.pricingPower
    ? (Object.fromEntries(
        (Object.keys(learnings.pricingPower) as DateType[]).map((t) => [
          t,
          { sensitivity: learnings.pricingPower![t].rateSensitivity, occupancy: learnings.pricingPower![t].occupancy }
        ])
      ) as ClientProfileDoc["pricingPower"])
    : null;

  // Divergence rule 3: per-engine reaction profile.
  const totalReactions = Object.values(learnings.engineReaction.reactions).reduce((a, b) => a + b, 0);
  const fractions: Record<string, number> = {};
  for (const [k, v] of Object.entries(learnings.engineReaction.reactions)) {
    fractions[k] = totalReactions > 0 ? v / totalReactions : 0;
  }
  const dominant = learnings.engineReaction.available ? dominantReaction(fractions) : null;
  if (dominant === "claw_back" && (fractions.claw_back ?? 0) >= 0.5) {
    rules.push({
      key: "engine_claws_back",
      description: `${learnings.engine} tends to claw back human moves — expect reversion, time pushes accordingly.`,
      params: {
        clawBackFraction: fractions.claw_back,
        n: learnings.engineReaction.sampled,
        window: "last 200 human engine changes"
      }
    });
  }

  const pickupVelocity =
    learnings.pickup && learnings.pickup.value
      ? {
          movedPerListingDay: learnings.pickup.value.movedPerListingDay,
          controlPerListingDay: learnings.pickup.value.controlPerListingDay,
          liftPct: learnings.pickup.value.liftPct,
          eventsWithControl: learnings.pickup.eventsWithControl,
          windowDays: learnings.pickup.windowDays
        }
      : null;

  return {
    engine: learnings.engine,
    computedAt: learnings.computedAt,
    pickupVelocity,
    leadTime,
    regret,
    pricingPower,
    engineReaction: { available: learnings.engineReaction.available, dominant, fractions },
    feeDragPct: learnings.netRealised?.feeDragPct ?? null,
    cancellationSignal: learnings.cancellation?.signal ?? null,
    promoGap: learnings.promoGap ?? null,
    rules
  };
}

/**
 * Upsert the client's profile, bumping `revision` each write. Tenant-scoped.
 * Returns the new revision number.
 */
export async function writeClientProfile(args: {
  tenantId: string;
  clientKey: string;
  doc: ClientProfileDoc;
}): Promise<number> {
  const existing = await prisma.clientProfile.findUnique({
    where: { tenantId_clientKey: { tenantId: args.tenantId, clientKey: args.clientKey } },
    select: { revision: true }
  });
  const revision = (existing?.revision ?? 0) + 1;
  await prisma.clientProfile.upsert({
    where: { tenantId_clientKey: { tenantId: args.tenantId, clientKey: args.clientKey } },
    create: { tenantId: args.tenantId, clientKey: args.clientKey, profile: args.doc as object, revision },
    update: { profile: args.doc as object, revision }
  });
  return revision;
}
