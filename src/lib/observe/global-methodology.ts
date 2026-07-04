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
  /** Per-market lead curves keyed by normalised CITY label (e.g. "belfast").
   *  A city name identifies no client — tenant/listing identity never enters. */
  leadTimeByMarket: Record<
    string,
    { medianLeadDays: number | null; bucketPcts: Record<string, number>; n: number }
  > | null;
  /** `heldTooLowPct` is null when that client has no engine min data. */
  regret: { heldTooLowPct: number | null; heldTooHighPct: number } | null;
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
    leadTimeByMarket: profile.leadTimeByMarket
      ? Object.fromEntries(
          Object.entries(profile.leadTimeByMarket).map(([market, v]) => [
            market,
            { medianLeadDays: v.medianLeadDays, bucketPcts: { ...v.bucketPcts }, n: v.n }
          ])
        )
      : null,
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
  /** Number of CONTRIBUTING CLIENTS (not folds) — one latest profile each. */
  samples: number;
  leadTimeBucketPcts: Record<string, number>;
  leadTimeSamples: number;
  medianLeadDays: number | null;
  medianLeadSamples: number;
  /** Each side is null until at least one client contributes it. */
  regret: { heldTooLowPct: number | null; heldTooHighPct: number | null };
  regretSamples: number;
  regretHeldTooLowSamples: number;
  pricingPowerVotes: Record<string, { inelastic: number; elastic: number; unknown: number }>;
  engineReactionByEngine: Record<string, { fractions: Record<string, number>; samples: number }>;
  /** Market-stratified lead curves (normalised city labels; anonymised) —
   *  equal weight per contributing client per market, like the per-engine
   *  stratification. `nights` is the pooled observation count behind it. */
  leadTimeByMarket: Record<
    string,
    { leadTimeBucketPcts: Record<string, number>; medianLeadDays: number | null; samples: number; nights: number }
  >;
  feeDragPctMean: number | null;
  feeDragSamples: number;
  cancellationSignalVotes: Record<string, number>;
};

export function emptyGlobalMethodology(): GlobalMethodologyDoc {
  return {
    samples: 0,
    leadTimeBucketPcts: {},
    leadTimeSamples: 0,
    medianLeadDays: null,
    medianLeadSamples: 0,
    regret: { heldTooLowPct: null, heldTooHighPct: null },
    regretSamples: 0,
    regretHeldTooLowSamples: 0,
    pricingPowerVotes: {},
    engineReactionByEngine: {},
    leadTimeByMarket: {},
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
 * Fold one anonymised contribution into a running aggregate. Pure — no
 * identifiers can enter because the input is already anonymised. NO LONGER the
 * production path (an incremental fold on every daily run double-counts
 * clients and keeps deleted-tenant ghosts forever) — production rebuilds via
 * `rebuildGlobalMethodology`. Kept for its unit tests and the leak checks.
 */
export function mergeGlobalMethodology(
  current: GlobalMethodologyDoc | null,
  contribution: AnonymisedContribution
): GlobalMethodologyDoc {
  const doc = current ? { ...current } : emptyGlobalMethodology();
  const n = doc.samples;

  doc.leadTimeBucketPcts = mergeMeanRecord(doc.leadTimeBucketPcts, n, contribution.leadTimeBucketPcts);
  if (contribution.leadTimeBucketPcts) doc.leadTimeSamples += 1;

  if (contribution.medianLeadDays !== null) {
    doc.medianLeadDays = runMean(doc.medianLeadDays, doc.medianLeadSamples, contribution.medianLeadDays);
    doc.medianLeadSamples += 1;
  }

  if (contribution.regret) {
    const low =
      contribution.regret.heldTooLowPct === null
        ? doc.regret.heldTooLowPct
        : runMean(doc.regret.heldTooLowPct, doc.regretHeldTooLowSamples, contribution.regret.heldTooLowPct);
    doc.regret = {
      heldTooLowPct: low,
      heldTooHighPct: runMean(doc.regret.heldTooHighPct, doc.regretSamples, contribution.regret.heldTooHighPct)
    };
    if (contribution.regret.heldTooLowPct !== null) doc.regretHeldTooLowSamples += 1;
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

/**
 * Rebuild the global doc from scratch out of one anonymised contribution per
 * CURRENT client — equal weight per client, per-field sample counts. Pure.
 * `samples` = number of contributing clients; each mean field is averaged over
 * only the clients that actually contributed it (a client without lead-time
 * data does not drag the lead-time mean).
 */
export function rebuildGlobalMethodology(contributions: AnonymisedContribution[]): GlobalMethodologyDoc {
  const doc = emptyGlobalMethodology();
  doc.samples = contributions.length;
  const mean = (values: number[]): number => values.reduce((s, v) => s + v, 0) / values.length;

  const withLead = contributions.filter((c) => c.leadTimeBucketPcts !== null);
  doc.leadTimeSamples = withLead.length;
  if (withLead.length > 0) {
    const keys = new Set(withLead.flatMap((c) => Object.keys(c.leadTimeBucketPcts ?? {})));
    for (const k of keys) {
      doc.leadTimeBucketPcts[k] = mean(withLead.map((c) => c.leadTimeBucketPcts?.[k] ?? 0));
    }
  }

  const medians = contributions
    .map((c) => c.medianLeadDays)
    .filter((v): v is number => v !== null);
  doc.medianLeadSamples = medians.length;
  doc.medianLeadDays = medians.length > 0 ? mean(medians) : null;

  const withRegret = contributions.filter((c) => c.regret !== null);
  doc.regretSamples = withRegret.length;
  doc.regret.heldTooHighPct =
    withRegret.length > 0 ? mean(withRegret.map((c) => c.regret?.heldTooHighPct ?? 0)) : null;
  const lows = withRegret
    .map((c) => c.regret?.heldTooLowPct ?? null)
    .filter((v): v is number => v !== null);
  doc.regretHeldTooLowSamples = lows.length;
  doc.regret.heldTooLowPct = lows.length > 0 ? mean(lows) : null;

  for (const c of contributions) {
    if (c.pricingPowerSensitivity) {
      for (const [type, v] of Object.entries(c.pricingPowerSensitivity)) {
        const cur = doc.pricingPowerVotes[type] ?? { inelastic: 0, elastic: 0, unknown: 0 };
        const bucket =
          v.sensitivity === "inelastic" ? "inelastic" : v.sensitivity === "elastic" ? "elastic" : "unknown";
        doc.pricingPowerVotes[type] = { ...cur, [bucket]: cur[bucket] + 1 };
      }
    }
    if (c.cancellationSignal) {
      doc.cancellationSignalVotes[c.cancellationSignal] =
        (doc.cancellationSignalVotes[c.cancellationSignal] ?? 0) + 1;
    }
  }

  const byEngine = new Map<string, Array<Record<string, number>>>();
  for (const c of contributions) {
    if (!c.engineReactionFractions) continue;
    const list = byEngine.get(c.engine) ?? [];
    list.push(c.engineReactionFractions);
    byEngine.set(c.engine, list);
  }
  for (const [engine, fractionSets] of byEngine) {
    const keys = new Set(fractionSets.flatMap((f) => Object.keys(f)));
    const fractions: Record<string, number> = {};
    for (const k of keys) fractions[k] = mean(fractionSets.map((f) => f[k] ?? 0));
    doc.engineReactionByEngine[engine] = { fractions, samples: fractionSets.length };
  }

  // Market stratification: per city label, equal weight per contributing
  // client (a client's Belfast curve counts once however many listings feed
  // it), exactly as engineReactionByEngine does per engine. Belfast is the
  // one in-house multi-tenant market today (3 tenants, 67 listings).
  const byMarket = new Map<
    string,
    Array<{ medianLeadDays: number | null; bucketPcts: Record<string, number>; n: number }>
  >();
  for (const c of contributions) {
    if (!c.leadTimeByMarket) continue;
    for (const [market, v] of Object.entries(c.leadTimeByMarket)) {
      const list = byMarket.get(market) ?? [];
      list.push(v);
      byMarket.set(market, list);
    }
  }
  for (const [market, entries] of [...byMarket.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const bucketKeys = new Set(entries.flatMap((e) => Object.keys(e.bucketPcts)));
    const leadTimeBucketPcts: Record<string, number> = {};
    for (const k of bucketKeys) leadTimeBucketPcts[k] = mean(entries.map((e) => e.bucketPcts[k] ?? 0));
    const medians = entries.map((e) => e.medianLeadDays).filter((v): v is number => v !== null);
    doc.leadTimeByMarket[market] = {
      leadTimeBucketPcts,
      medianLeadDays: medians.length > 0 ? mean(medians) : null,
      samples: entries.length,
      nights: entries.reduce((s, e) => s + e.n, 0)
    };
  }

  const drags = contributions.map((c) => c.feeDragPct).filter((v): v is number => v !== null);
  doc.feeDragSamples = drags.length;
  doc.feeDragPctMean = drags.length > 0 ? mean(drags) : null;

  return doc;
}

/** Read the single global methodology doc, or null if not bootstrapped yet. */
export async function readGlobalMethodology(): Promise<GlobalMethodologyDoc | null> {
  const row = await prisma.globalMethodology.findUnique({ where: { id: GLOBAL_METHODOLOGY_ID } });
  return row ? (row.methodology as GlobalMethodologyDoc) : null;
}

/**
 * Recompute the global doc from the LATEST profile of every CURRENT tenant and
 * overwrite the singleton row. The ONLY writer of the global row (no tenant
 * scope by design, spec §8) — runs on the weekly settle, not on daily runs.
 * Replacing the old incremental fold with a full recompute means deleted
 * tenants stop contributing on the next settle, no client is double-counted
 * across runs, and settle-only fields (feeDrag) can no longer be overwritten
 * with a daily null.
 */
export async function recomputeGlobalMethodology(): Promise<GlobalMethodologyDoc> {
  const [tenants, profiles] = await Promise.all([
    prisma.tenant.findMany({ select: { id: true } }),
    // Deliberately cross-tenant: this builds the internal anonymised global
    // doc. Identifiers are stripped by anonymiseForGlobal before aggregation.
    prisma.clientProfile.findMany({
      orderBy: { updatedAt: "desc" },
      select: { tenantId: true, profile: true }
    })
  ]);
  const currentTenantIds = new Set(tenants.map((t) => t.id));
  const latestByTenant = new Map<string, ClientProfileDoc>();
  for (const p of profiles) {
    if (!currentTenantIds.has(p.tenantId)) continue; // deleted-tenant ghost — evict
    if (!latestByTenant.has(p.tenantId)) latestByTenant.set(p.tenantId, p.profile as ClientProfileDoc);
  }
  const rebuilt = rebuildGlobalMethodology([...latestByTenant.values()].map(anonymiseForGlobal));
  const existing = await prisma.globalMethodology.findUnique({
    where: { id: GLOBAL_METHODOLOGY_ID },
    select: { revision: true }
  });
  await prisma.globalMethodology.upsert({
    where: { id: GLOBAL_METHODOLOGY_ID },
    create: { id: GLOBAL_METHODOLOGY_ID, methodology: rebuilt as object, revision: 1 },
    update: { methodology: rebuilt as object, revision: (existing?.revision ?? 0) + 1 }
  });
  return rebuilt;
}
