/**
 * Recs generation orchestrator (2026-07-18): one call produces a client's
 * complete 14-day recommendation set and its oversight overlay.
 *
 *   evidence (RecsEvidence: Mark-prior + dose-response, warm-start or live)
 *     + market context (per listing, cached per day, engine-degrading)
 *     → composeRecSizing per at-risk night
 *     → generateSuggestionsForClient (recsPage mode: full-coverage window,
 *       decision memory, floors/events/anti-ratchet still binding)
 *     → runOversightForClient (Claude overlay; never blocks, never throws)
 *
 * Called from the 05:30 observe run (observe-service) and the page's manual
 * "regenerate now" route. Engine keys stay server-side throughout.
 */

import { env } from "@/lib/env";
import { toDateOnly } from "@/lib/metrics/helpers";
import { dropDateType } from "@/lib/observe/drop-outcomes";
import { resolveObserveSource } from "@/lib/observe/registry";
import {
  generateSuggestionsForClient,
  type GenerateSuggestionsResult,
  type RecsNightComposer
} from "@/lib/observe/suggestions";
import type { PriceLabsAdapter } from "@/lib/observe/engine/pricelabs";
import type { WheelhouseAdapter } from "@/lib/observe/engine/wheelhouse";
import { prisma } from "@/lib/prisma";

import { buildMarketContext, londonDayOf } from "./market/context";
import { computeMarketFactor } from "./market/factor";
import type { MarketContext, MarketReaders } from "./market/types";
import { runOversightForClient } from "./oversight/run";
import { composeRecSizing, sizingLeadBucket } from "./sizing";
import { loadSizingEvidence } from "./warmstart";

export const RECS_PAGE_WINDOW_DAYS = 14;
export const RECS_RECENT_ACTIONED_DAYS = 3;
/** Market context covers the next N days of own rates for price position. */
const MARKET_RATE_WINDOW_DAYS = 30;

export type GenerateRecsResult = GenerateSuggestionsResult & {
  provisional: boolean;
  provenance: "warm-start" | "live-observed";
  marketListings: number;
  oversight: string; // ok | error | disabled | skipped
};

/** PL `pms` param per tenant PMS (Cityscape is guesty — never assume hostaway). */
function pmsNameFor(pmsType: string): string {
  const v = pmsType.trim().toLowerCase();
  return v === "" ? "hostaway" : v;
}

export async function generateRecsForClient(args: {
  tenantId: string;
  clientKey?: string;
  now?: Date;
}): Promise<GenerateRecsResult> {
  const now = args.now ?? new Date();
  const tenant = await prisma.tenant.findUnique({
    where: { id: args.tenantId },
    select: { id: true, name: true, pmsType: true }
  });
  if (!tenant) throw new Error(`generateRecsForClient: unknown tenant`);
  const clientKey = args.clientKey ?? tenant.id;

  const [window, evidenceLookup] = await Promise.all([
    prisma.observationWindow.findFirst({ where: { tenantId: tenant.id, clientKey }, select: { status: true } }),
    loadSizingEvidence({ tenantId: tenant.id, clientKey })
  ]);
  const provisional = window?.status !== "graduated";

  // Evidence provenance for row labelling: live-observed only once the live
  // loop has re-computed the evidence store; warm-start until then.
  const anyLive = await prisma.recsEvidence.findFirst({
    where: { tenantId: tenant.id, clientKey, provenance: "live-observed", kind: { in: ["mark-prior", "drop-outcomes"] } },
    select: { id: true }
  });
  const provenance: "warm-start" | "live-observed" = anyLive ? "live-observed" : "warm-start";

  // ---- Market context per listing (cached per engine per day) --------------
  const source = resolveObserveSource({ id: tenant.id, name: tenant.name });
  const contextByListing = new Map<string, MarketContext>();
  if ((source.kind === "pricelabs" || source.kind === "wheelhouse") && source.adapter) {
    const readers: MarketReaders =
      source.kind === "pricelabs"
        ? { fetchPlNeighborhood: (id, pms) => (source.adapter as PriceLabsAdapter).fetchNeighborhood(id, pms) }
        : {
            fetchWhNeighborhoodPricing: (id) => (source.adapter as WheelhouseAdapter).fetchNeighborhoodPricing(id),
            fetchWhNeighborhoodOccupancy: (id) => (source.adapter as WheelhouseAdapter).fetchNeighborhoodOccupancy(id)
          };
    const day = londonDayOf(now);
    const pms = pmsNameFor(tenant.pmsType);
    // "Today" derives from the LONDON calendar day (not UTC parts) so a run in
    // the 00:00-01:00 BST hour doesn't key the window on yesterday.
    const [y, m, d] = day.split("-").map(Number);
    const today = new Date(Date.UTC(y, m - 1, d));
    const rateWindowEnd = new Date(today.getTime() + MARKET_RATE_WINDOW_DAYS * 86_400_000);
    const [listings, rates] = await Promise.all([
      prisma.listing.findMany({
        where: { tenantId: tenant.id, removedAt: null },
        select: { id: true, hostawayId: true, bedroomsNumber: true }
      }),
      prisma.calendarRate.findMany({
        where: { tenantId: tenant.id, date: { gte: today, lte: rateWindowEnd } },
        select: { listingId: true, date: true, rate: true }
      })
    ]);
    const ratesByListing = new Map<string, Map<string, number>>();
    for (const r of rates) {
      const map = ratesByListing.get(r.listingId) ?? new Map<string, number>();
      map.set(toDateOnly(r.date), Number(r.rate));
      ratesByListing.set(r.listingId, map);
    }
    let firstListing = true;
    for (const listing of listings) {
      if (!listing.hostawayId) continue;
      // Wheelhouse caps at 20 req/min and a cache-miss day fires 2 calls per
      // listing back-to-back — space listings out proactively instead of
      // leaning on 429 retries (cache hits skip the network so the spacing
      // only costs time on the first run of the day).
      if (!firstListing && source.kind === "wheelhouse") {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      firstListing = false;
      try {
        const ctx = await buildMarketContext({
          tenantId: tenant.id,
          engine: source.kind,
          engineListingId: String(listing.hostawayId),
          pms,
          myRateByDate: ratesByListing.get(listing.id) ?? new Map(),
          day,
          bedrooms: listing.bedroomsNumber ?? null,
          readers,
          now
        });
        contextByListing.set(listing.id, ctx);
      } catch (error) {
        // A single listing's market read never blocks the client's recs.
        console.warn(
          `[recs-generate] market context failed for a listing (${tenant.name}): ` +
            `${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`
        );
      }
    }
  }

  const composeNight: RecsNightComposer = (night, judged) => {
    const evidence = evidenceLookup(sizingLeadBucket(night.daysToStay), dropDateType(night.date));
    const ctx = contextByListing.get(night.listingId) ?? null;
    const factor = ctx
      ? computeMarketFactor(ctx, {
          date: night.date,
          myRate: night.rate,
          expectedFill: null,
          scaledFill: null,
          behindCurve: true
        })
      : null;
    if (!evidence && !factor) return null; // base sizing ships alone
    return composeRecSizing({
      baseDropPct: judged.dropPct,
      evidence,
      market: factor
        ? { depthMultiplier: factor.depthMultiplier, holdBias: factor.holdBias, contribution: factor.contribution }
        : null
    });
  };

  const result = await generateSuggestionsForClient({
    tenantId: tenant.id,
    clientKey,
    now,
    status: window?.status === "graduated" ? "pending" : "shadow",
    recsPage: {
      windowDays: RECS_PAGE_WINDOW_DAYS,
      provenance,
      provisional,
      recentActionedDays: RECS_RECENT_ACTIONED_DAYS,
      composeNight
    }
  });

  // Oversight overlay — degrades gracefully by contract (never throws).
  let oversight = "skipped";
  if (env.recsOversightEnabled) {
    const overs = await runOversightForClient({ tenantId: tenant.id, clientKey, now: () => now });
    oversight = overs.status;
  }

  return { ...result, provisional, provenance, marketListings: contextByListing.size, oversight };
}
