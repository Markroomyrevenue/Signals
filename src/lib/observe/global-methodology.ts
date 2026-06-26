/**
 * The portable, anonymised global methodology (SIGNALS-OBSERVE-LEARN-SPEC.md §8).
 *
 * ONE internal doc, no tenant. It holds only abstracted market truth that
 * transfers to any future client — when guests book, pricing power by date type,
 * regret patterns, engine-reaction tendencies. It is the day-1 baseline every new
 * client inherits and is NEVER client-facing.
 *
 * Siloing is enforced by `anonymiseForGlobal`, a strict WHITELIST: only ratios,
 * percentages, and labels cross into the global doc. No `tenantId`, listing name,
 * client identifier, or raw rate (absolute currency value) is ever copied. The
 * merge is a pure running aggregate so both functions are unit-tested; the only
 * DB surface is the single-row upsert.
 */

import { prisma } from "@/lib/prisma";

import type { ClientProfileDoc } from "./client-profile";

/** The fixed id of the single global row (enforces the singleton). */
export const GLOBAL_METHODOLOGY_ID = "global";

/** The anonymised, identifier-free contribution one client makes to the global doc. */
export type AnonymisedContribution = {
  engine: string; // engine TYPE only (pricelabs|wheelhouse|hostaway-scan) — not a client id
  leadTimeBucketPcts: Record<string, number> | null;
  medianLeadDays: number | null;
  regret: { heldTooLowPct: number; heldTooHighPct: number } | null;
  pricingPowerSensitivity: Record<string, { sensitivity: string; occupancy: number }> | null;
  engineReactionFractions: Record<string, number> | null;
  feeDragPct: number | null;
  cancellationSignal: string | null;
};

/**
 * Strict whitelist: copy ONLY ratios / percentages / labels out of a client
 * profile. Absolute money (meanRate, netPerNight), ids, and names are never
 * referenced, so they cannot leak. Pure.
 */
export function anonymiseForGlobal(profile: ClientProfileDoc): AnonymisedContribution {
  return {
    engine: profile.engine,
    leadTimeBucketPcts: profile.leadTime ? { ...profile.leadTime.bucketPcts } : null,
    medianLeadDays: profile.leadTime?.medianLeadDays ?? null,
    regret: profile.regret
      ? { heldTooLowPct: profile.regret.heldTooLowPct, heldTooHighPct: profile.regret.heldTooHighPct }
      : null,
    pricingPowerSensitivity: profile.pricingPower
      ? Object.fromEntries(
          Object.entries(profile.pricingPower).map(([type, v]) => [
            type,
            { sensitivity: v!.sensitivity, occupancy: v!.occupancy }
          ])
        )
      : null,
    engineReactionFractions: profile.engineReaction.available ? { ...profile.engineReaction.fractions } : null,
    feeDragPct: profile.feeDragPct,
    cancellationSignal: profile.cancellationSignal
  };
}

export type GlobalMethodologyDoc = {
  samples: number;
  leadTimeBucketPcts: Record<string, number>;
  medianLeadDays: number | null;
  medianLeadSamples: number;
  regret: { heldTooLowPct: number; heldTooHighPct: number };
  regretSamples: number;
  pricingPowerVotes: Record<string, { inelastic: number; elastic: number; unknown: number }>;
  engineReactionByEngine: Record<string, { fractions: Record<string, number>; samples: number }>;
  feeDragPctMean: number | null;
  feeDragSamples: number;
  cancellationSignalVotes: Record<string, number>;
};

export function emptyGlobalMethodology(): GlobalMethodologyDoc {
  return {
    samples: 0,
    leadTimeBucketPcts: {},
    medianLeadDays: null,
    medianLeadSamples: 0,
    regret: { heldTooLowPct: 0, heldTooHighPct: 0 },
    regretSamples: 0,
    pricingPowerVotes: {},
    engineReactionByEngine: {},
    feeDragPctMean: null,
    feeDragSamples: 0,
    cancellationSignalVotes: {}
  };
}

/** Incremental running mean: prior mean over `n` samples folded with `x`. Pure. */
function runMean(old: number | null, n: number, x: number): number {
  if (old === null || n <= 0) return x;
  return old + (x - old) / (n + 1);
}

function mergeMeanRecord(
  old: Record<string, number>,
  n: number,
  next: Record<string, number> | null
): Record<string, number> {
  if (!next) return old;
  const out: Record<string, number> = { ...old };
  const keys = new Set([...Object.keys(old), ...Object.keys(next)]);
  for (const k of keys) out[k] = runMean(old[k] ?? null, n, next[k] ?? 0);
  return out;
}

/**
 * Fold one anonymised contribution into the running global aggregate. Pure — no
 * identifiers can enter because the input is already anonymised.
 */
export function mergeGlobalMethodology(
  current: GlobalMethodologyDoc | null,
  contribution: AnonymisedContribution
): GlobalMethodologyDoc {
  const doc = current ? { ...current } : emptyGlobalMethodology();
  const n = doc.samples;

  doc.leadTimeBucketPcts = mergeMeanRecord(doc.leadTimeBucketPcts, n, contribution.leadTimeBucketPcts);

  if (contribution.medianLeadDays !== null) {
    doc.medianLeadDays = runMean(doc.medianLeadDays, doc.medianLeadSamples, contribution.medianLeadDays);
    doc.medianLeadSamples += 1;
  }

  if (contribution.regret) {
    doc.regret = {
      heldTooLowPct: runMean(doc.regret.heldTooLowPct, doc.regretSamples, contribution.regret.heldTooLowPct),
      heldTooHighPct: runMean(doc.regret.heldTooHighPct, doc.regretSamples, contribution.regret.heldTooHighPct)
    };
    doc.regretSamples += 1;
  }

  if (contribution.pricingPowerSensitivity) {
    const votes = { ...doc.pricingPowerVotes };
    for (const [type, v] of Object.entries(contribution.pricingPowerSensitivity)) {
      const cur = votes[type] ?? { inelastic: 0, elastic: 0, unknown: 0 };
      const bucket = v.sensitivity === "inelastic" ? "inelastic" : v.sensitivity === "elastic" ? "elastic" : "unknown";
      votes[type] = { ...cur, [bucket]: cur[bucket as keyof typeof cur] + 1 };
    }
    doc.pricingPowerVotes = votes;
  }

  if (contribution.engineReactionFractions) {
    const byEngine = { ...doc.engineReactionByEngine };
    const cur = byEngine[contribution.engine] ?? { fractions: {}, samples: 0 };
    byEngine[contribution.engine] = {
      fractions: mergeMeanRecord(cur.fractions, cur.samples, contribution.engineReactionFractions),
      samples: cur.samples + 1
    };
    doc.engineReactionByEngine = byEngine;
  }

  if (contribution.feeDragPct !== null) {
    doc.feeDragPctMean = runMean(doc.feeDragPctMean, doc.feeDragSamples, contribution.feeDragPct);
    doc.feeDragSamples += 1;
  }

  if (contribution.cancellationSignal) {
    const votes = { ...doc.cancellationSignalVotes };
    votes[contribution.cancellationSignal] = (votes[contribution.cancellationSignal] ?? 0) + 1;
    doc.cancellationSignalVotes = votes;
  }

  doc.samples = n + 1;
  return doc;
}

/** Read the single global methodology doc, or null if not bootstrapped yet. */
export async function readGlobalMethodology(): Promise<GlobalMethodologyDoc | null> {
  const row = await prisma.globalMethodology.findUnique({ where: { id: GLOBAL_METHODOLOGY_ID } });
  return row ? (row.methodology as GlobalMethodologyDoc) : null;
}

/**
 * Fold an anonymised contribution into the global doc, bootstrapping it on first
 * call. The ONLY writer of the global row. No tenant scope by design (spec §8).
 */
export async function bootstrapOrUpdateGlobalMethodology(
  contribution: AnonymisedContribution
): Promise<GlobalMethodologyDoc> {
  const current = await readGlobalMethodology();
  const merged = mergeGlobalMethodology(current, contribution);
  const existing = await prisma.globalMethodology.findUnique({
    where: { id: GLOBAL_METHODOLOGY_ID },
    select: { revision: true }
  });
  await prisma.globalMethodology.upsert({
    where: { id: GLOBAL_METHODOLOGY_ID },
    create: { id: GLOBAL_METHODOLOGY_ID, methodology: merged as object, revision: 1 },
    update: { methodology: merged as object, revision: (existing?.revision ?? 0) + 1 }
  });
  return merged;
}
