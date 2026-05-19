/**
 * HTML report renderer for the daily comparison agent.
 *
 * Inputs: an array of ComparisonRunSummary plus the underlying snapshot rows
 * (queried lazily by listing-window). Output: a self-contained HTML string
 * (no external CSS/JS) suitable for inlining in an email and saving to disk.
 *
 * Goals: scannable in 5 minutes, every claim is sourced (so Mark can drill in
 * if a number looks off).
 */

import { prisma } from "@/lib/prisma";
import type { ComparisonRunSummary } from "@/lib/agents/pricing-comparison/agent";
import type { Prisma as PrismaTypes } from "@prisma/client";

type RawSnapshot = {
  listingId: string;
  targetDate: Date;
  ourRate: PrismaTypes.Decimal;
  hostawayRate: PrismaTypes.Decimal | null;
  deltaPct: number | null;
  classification: string;
  windowDays: number;
  ourBreakdown: PrismaTypes.JsonValue;
  divergenceCause: string | null;
  ourLift: number | null;
  plLift: number | null;
  liftDelta: number | null;
  ourOccupancyMultiplier: number | null;
  rateWithoutOccupancy: PrismaTypes.Decimal | null;
  keyDataForwardOcc: number | null;
  keyDataForwardAdr: number | null;
  keyDataForwardOccLy: number | null;
  keyDataForwardAdrLy: number | null;
};

const ESC = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

const PCT = (n: number): string => `${(n * 100).toFixed(1)}%`;
const SIGNED_PCT = (n: number): string => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
const GBP = (n: number | null): string => (n === null ? "—" : `£${n.toFixed(0)}`);

function bandFor(windowDays: number): "0-7d" | "8-14d" | "15-30d" | "31-60d" | "61-90d" {
  if (windowDays <= 7) return "0-7d";
  if (windowDays <= 14) return "8-14d";
  if (windowDays <= 30) return "15-30d";
  if (windowDays <= 60) return "31-60d";
  return "61-90d";
}

function aggregateByBand(rows: RawSnapshot[]) {
  const bands = ["0-7d", "8-14d", "15-30d", "31-60d", "61-90d"] as const;
  return bands.map((band) => {
    const filtered = rows.filter((r) => bandFor(r.windowDays) === band);
    const withDelta = filtered.filter((r) => r.deltaPct !== null);
    const agree = filtered.filter((r) => r.classification === "agree").length;
    const meanDelta = withDelta.length > 0 ? withDelta.reduce((s, r) => s + (r.deltaPct ?? 0), 0) / withDelta.length : 0;
    const absVals = withDelta.map((r) => Math.abs(r.deltaPct ?? 0)).sort((a, b) => a - b);
    const medianAbs = absVals.length > 0 ? absVals[Math.floor(absVals.length / 2)] : 0;
    return {
      band,
      total: filtered.length,
      agree,
      agreementPct: filtered.length > 0 ? agree / filtered.length : 0,
      meanDelta,
      medianAbsDelta: medianAbs
    };
  });
}

function aggregateByDoW(rows: RawSnapshot[]) {
  const dowNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return dowNames.map((dow, i) => {
    const filtered = rows.filter((r) => r.targetDate.getUTCDay() === i);
    const withDelta = filtered.filter((r) => r.deltaPct !== null);
    const agree = filtered.filter((r) => r.classification === "agree").length;
    const meanDelta = withDelta.length > 0 ? withDelta.reduce((s, r) => s + (r.deltaPct ?? 0), 0) / withDelta.length : 0;
    return {
      dow,
      total: filtered.length,
      agreementPct: filtered.length > 0 ? agree / filtered.length : 0,
      meanDelta
    };
  });
}

function topDivergences(rows: RawSnapshot[], n: number) {
  return rows
    .filter((r) => r.deltaPct !== null)
    .sort((a, b) => Math.abs(b.deltaPct ?? 0) - Math.abs(a.deltaPct ?? 0))
    .slice(0, n);
}

/**
 * Bucket every snapshot row in this tenant by divergence cause. Only rows
 * where the classifier emitted a non-null cause are counted (i.e. rows
 * with |deltaPct| > 5% AND enough baseline data on both sides). Rows in
 * agreement contribute to `inAgreement`.
 */
function aggregateByDivergenceCause(rows: RawSnapshot[]) {
  let demand = 0;
  let level = 0;
  let mixed = 0;
  let occupancy = 0;
  let spikeCaught = 0;
  let spikeMissed = 0;
  let inAgreement = 0;
  let unclassified = 0;
  for (const r of rows) {
    if (r.divergenceCause === "demand_disagreement") demand += 1;
    else if (r.divergenceCause === "level_disagreement") level += 1;
    else if (r.divergenceCause === "mixed") mixed += 1;
    else if (r.divergenceCause === "occupancy_driven") occupancy += 1;
    else if (r.divergenceCause === "demand_spike_caught") spikeCaught += 1;
    else if (r.divergenceCause === "demand_spike_missed") spikeMissed += 1;
    else if (r.deltaPct !== null && Math.abs(r.deltaPct) <= 0.05) inAgreement += 1;
    else unclassified += 1;
  }
  const totalDivergent = demand + level + mixed + occupancy + spikeCaught + spikeMissed;
  return {
    demand,
    level,
    mixed,
    occupancy,
    spikeCaught,
    spikeMissed,
    inAgreement,
    unclassified,
    totalDivergent,
    demandPct: totalDivergent > 0 ? demand / totalDivergent : 0,
    levelPct: totalDivergent > 0 ? level / totalDivergent : 0,
    mixedPct: totalDivergent > 0 ? mixed / totalDivergent : 0,
    occupancyPct: totalDivergent > 0 ? occupancy / totalDivergent : 0,
    spikeCaughtPct: totalDivergent > 0 ? spikeCaught / totalDivergent : 0,
    spikeMissedPct: totalDivergent > 0 ? spikeMissed / totalDivergent : 0
  };
}

function attributeDivergence(breakdown: PrismaTypes.JsonValue): string {
  if (!breakdown || typeof breakdown !== "object" || Array.isArray(breakdown)) return "no breakdown";
  const b = breakdown as Record<string, unknown>;
  const keys: Array<{ name: string; value: number }> = [];
  for (const k of ["seasonality", "dayOfWeek", "demand", "occupancy", "events", "pace"]) {
    const v = Number(b[k]);
    if (Number.isFinite(v)) keys.push({ name: k, value: Math.abs(v - 1) });
  }
  if (keys.length === 0) return "no breakdown";
  keys.sort((a, b) => b.value - a.value);
  return `${keys[0].name} ${(keys[0].value * 100).toFixed(0)}%`;
}

export type BacktestSnapshotForReport = {
  runId?: string;
  tenants: Array<{
    tenantName: string;
    listingsTested: number;
    nightsTested: number;
    medianAbsPctError: number;
    directionalAccuracy: number;
  }>;
};

export async function renderDailyComparisonHtml(
  summaries: ComparisonRunSummary[],
  options: {
    snapshotDate: string;
    trialDayNumber: number;
    defensibilityVerdicts?: { defensible: number; borderline: number; questionable: number };
    /** Active trial window (e.g. 2026-05-18 → 2026-06-01). Surfaced in the banner. */
    trialWindow?: { start: string; end: string };
    /** Most recent backtest summary, rendered as a one-glance metrics row. */
    backtestSnapshot?: BacktestSnapshotForReport;
  }
): Promise<string> {
  if (summaries.length === 0) {
    return `<!doctype html><html><body><h1>KeyData trial — Day ${options.trialDayNumber}</h1><p>No tenants in trial; nothing to compare.</p></body></html>`;
  }
  const sections: string[] = [];

  // Top-level totals
  const allCells = summaries.reduce((s, r) => s + r.cellsCompared, 0);
  const allListings = summaries.reduce((s, r) => s + r.listingsProcessed, 0);
  const overallAgreement =
    allCells > 0
      ? summaries.reduce((s, r) => s + r.agreement * r.cellsCompared, 0) / allCells
      : 0;

  const cappedDayNumber = Math.min(14, Math.max(1, options.trialDayNumber));
  const trialWindowLabel = options.trialWindow
    ? `Trial window ${ESC(options.trialWindow.start)} → ${ESC(options.trialWindow.end)}`
    : "Trial window unset";
  sections.push(`
    <h1 style="margin:0 0 4px">KeyData trial — Day ${cappedDayNumber} of 14</h1>
    <p style="color:#444;margin:0 0 4px;font-size:13px">${trialWindowLabel} · KeyData vs PriceLabs daily report.</p>
    <p style="color:#666;margin:0 0 24px;font-size:13px">Snapshot ${ESC(options.snapshotDate)} · ${summaries.length} tenant${summaries.length === 1 ? "" : "s"} · ${allListings} listings · ${allCells} listing-dates compared</p>
    <table style="border-collapse:collapse;width:100%;margin-bottom:24px">
      <tr><th align="left" style="padding:6px;border-bottom:1px solid #ddd">Tenant</th>
          <th align="right" style="padding:6px;border-bottom:1px solid #ddd">Listings</th>
          <th align="right" style="padding:6px;border-bottom:1px solid #ddd">Cells</th>
          <th align="right" style="padding:6px;border-bottom:1px solid #ddd">Agreement %</th>
          <th align="right" style="padding:6px;border-bottom:1px solid #ddd">Mean Δ</th>
          <th align="right" style="padding:6px;border-bottom:1px solid #ddd">Median |Δ|</th>
          <th align="right" style="padding:6px;border-bottom:1px solid #ddd">Big divergence</th></tr>
      ${summaries
        .map(
          (s) => `
      <tr>
        <td style="padding:6px;border-bottom:1px solid #f0f0f0">${ESC(s.tenantName)}</td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${s.listingsProcessed}</td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${s.cellsCompared}</td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${PCT(s.agreement)}</td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${SIGNED_PCT(s.meanDeltaPct)}</td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${PCT(s.medianAbsDeltaPct)}</td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${s.largeDivergenceCount}</td>
      </tr>`
        )
        .join("")}
      <tr style="font-weight:600">
        <td style="padding:6px;border-top:2px solid #888">All</td>
        <td align="right" style="padding:6px;border-top:2px solid #888">${allListings}</td>
        <td align="right" style="padding:6px;border-top:2px solid #888">${allCells}</td>
        <td align="right" style="padding:6px;border-top:2px solid #888">${PCT(overallAgreement)}</td>
        <td align="right" style="padding:6px;border-top:2px solid #888"></td>
        <td align="right" style="padding:6px;border-top:2px solid #888"></td>
        <td align="right" style="padding:6px;border-top:2px solid #888">${summaries.reduce((s, r) => s + r.largeDivergenceCount, 0)}</td>
      </tr>
    </table>
  `);

  // Trial scope panel — surfaces the dynamic Student-Accom exclusion + the
  // multi-unit skip count for each tenant. Helps Mark see at a glance which
  // listings were in scope today.
  sections.push(`
    <h2 style="margin:24px 0 8px">Trial scope (resolved at runtime)</h2>
    <p style="color:#666;margin:0 0 8px;font-size:13px">Student-Accom exclusion is dynamic — re-evaluated on every daily run, not a persistent toggle on the listing.</p>
    <table style="border-collapse:collapse;width:100%;margin-bottom:24px;font-size:13px">
      <tr><th align="left" style="padding:6px;border-bottom:1px solid #ddd">Tenant</th>
          <th align="right" style="padding:6px;border-bottom:1px solid #ddd">Active listings</th>
          <th align="right" style="padding:6px;border-bottom:1px solid #ddd">Multi-unit skipped</th>
          <th align="right" style="padding:6px;border-bottom:1px solid #ddd">Student-Accom excluded</th>
          <th align="right" style="padding:6px;border-bottom:1px solid #ddd">In trial today</th></tr>
      ${summaries
        .map(
          (s) => `
      <tr>
        <td style="padding:6px;border-bottom:1px solid #f0f0f0">${ESC(s.tenantName)}</td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${s.listingsBeforeScopeFilter}</td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${s.multiUnitSkipped}</td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${s.studentAccomExcluded}</td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0;font-weight:600">${s.listingsProcessed}</td>
      </tr>`
        )
        .join("")}
    </table>
  `);

  // Divergence root-cause headline. Aggregates across every tenant so the
  // top-of-report tells the same story Mark would see if he summed each
  // per-tenant section. Only divergent rows count toward the splits.
  const totalDemand = summaries.reduce((s, r) => s + r.divergenceCauseCounts.demand, 0);
  const totalLevel = summaries.reduce((s, r) => s + r.divergenceCauseCounts.level, 0);
  const totalMixed = summaries.reduce((s, r) => s + r.divergenceCauseCounts.mixed, 0);
  const totalOccupancy = summaries.reduce((s, r) => s + r.divergenceCauseCounts.occupancy, 0);
  const totalSpikeCaught = summaries.reduce((s, r) => s + r.divergenceCauseCounts.spikeCaught, 0);
  const totalSpikeMissed = summaries.reduce((s, r) => s + r.divergenceCauseCounts.spikeMissed, 0);
  const totalDivergent = totalDemand + totalLevel + totalMixed + totalOccupancy + totalSpikeCaught + totalSpikeMissed;
  sections.push(`
    <h2 style="margin:24px 0 8px">Divergence root-cause breakdown</h2>
    <p style="color:#666;margin:0 0 8px;font-size:13px">Why our engine and PriceLabs disagree, for cells with |Δ| &gt; 5%. ${totalDivergent} divergent listing-dates classified today. Demand spike = KeyData market data shows BOTH occupancy and ADR materially up vs same date last year (≥+15pp occ, ≥+15% ADR).</p>
    <table style="border-collapse:collapse;width:100%;margin-bottom:24px;font-size:13px">
      <tr><th align="left" style="padding:6px;border-bottom:1px solid #ddd">Cause</th>
          <th align="right" style="padding:6px;border-bottom:1px solid #ddd">Count</th>
          <th align="right" style="padding:6px;border-bottom:1px solid #ddd">% of divergent</th>
          <th align="left" style="padding:6px;border-bottom:1px solid #ddd">What it means</th></tr>
      <tr style="background:#f0f7ef">
        <td style="padding:6px;border-bottom:1px solid #f0f0f0"><strong style="color:#1a8a3a">Demand spike caught (good sign)</strong></td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${totalSpikeCaught}</td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${PCT(totalDivergent > 0 ? totalSpikeCaught / totalDivergent : 0)}</td>
        <td style="padding:6px;border-bottom:1px solid #f0f0f0;color:#444">KeyData confirms a real market spike (occ AND ADR both up materially vs LY) and we priced ABOVE PriceLabs. Our engine caught the event, PL didn't. Think Fleadh / Halloween / NYE / festival dates.</td>
      </tr>
      <tr style="background:#fbe9e9">
        <td style="padding:6px;border-bottom:1px solid #f0f0f0"><strong style="color:#b91c1c">Demand spike missed (money on the table)</strong></td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${totalSpikeMissed}</td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${PCT(totalDivergent > 0 ? totalSpikeMissed / totalDivergent : 0)}</td>
        <td style="padding:6px;border-bottom:1px solid #f0f0f0;color:#444">Same verified market spike but we priced BELOW PriceLabs. PL caught the event, we didn't — we'd be leaving revenue on the table on these dates. Worth investigating to see why our model missed.</td>
      </tr>
      <tr style="background:#f0f7ef">
        <td style="padding:6px;border-bottom:1px solid #f0f0f0"><strong style="color:#1a8a3a">Occupancy-driven (good sign)</strong></td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${totalOccupancy}</td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${PCT(totalDivergent > 0 ? totalOccupancy / totalDivergent : 0)}</td>
        <td style="padding:6px;border-bottom:1px solid #f0f0f0;color:#444">Gap fully explained by our occupancy-based multiplier — strip the occupancy lift and we'd be inside the agreement band with PL. Our model is reacting to occupancy pressure, PL isn't.</td>
      </tr>
      <tr>
        <td style="padding:6px;border-bottom:1px solid #f0f0f0"><strong>Demand-signal</strong></td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${totalDemand}</td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${PCT(totalDivergent > 0 ? totalDemand / totalDivergent : 0)}</td>
        <td style="padding:6px;border-bottom:1px solid #f0f0f0;color:#666">Lifts off baseline disagree by &gt;5pp or point opposite directions — engines read demand differently.</td>
      </tr>
      <tr>
        <td style="padding:6px;border-bottom:1px solid #f0f0f0"><strong>Level/logic</strong></td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${totalLevel}</td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${PCT(totalDivergent > 0 ? totalLevel / totalDivergent : 0)}</td>
        <td style="padding:6px;border-bottom:1px solid #f0f0f0;color:#666">Lifts agree to within 3pp but absolute level diverges — same demand read, different base/floor calibration.</td>
      </tr>
      <tr>
        <td style="padding:6px;border-bottom:1px solid #f0f0f0"><strong>Mixed</strong></td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${totalMixed}</td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${PCT(totalDivergent > 0 ? totalMixed / totalDivergent : 0)}</td>
        <td style="padding:6px;border-bottom:1px solid #f0f0f0;color:#666">Lifts agree directionally but their delta is 3–5pp — partial demand disagreement compounded with level differences.</td>
      </tr>
    </table>
  `);

  if (options.defensibilityVerdicts) {
    const v = options.defensibilityVerdicts;
    const total = v.defensible + v.borderline + v.questionable;
    sections.push(`
      <h2 style="margin:24px 0 8px">Defensibility audit (today's sample)</h2>
      <p style="margin:0 0 16px">${total} listing-dates graded by Claude:
        <strong style="color:#1a8a3a">${v.defensible} defensible</strong> ·
        <strong style="color:#bf7f00">${v.borderline} borderline</strong> ·
        <strong style="color:#b91c1c">${v.questionable} questionable</strong>.</p>
    `);
  }

  if (options.backtestSnapshot) {
    const bt = options.backtestSnapshot;
    sections.push(`
      <h2 style="margin:24px 0 8px">Backtest snapshot</h2>
      <p style="color:#666;font-size:13px;margin:0 0 8px">Most recent backtest run${bt.runId ? ` (<code>${ESC(bt.runId)}</code>)` : ""} — our engine vs the realised bookings over the trailing year.</p>
      <table style="border-collapse:collapse;width:100%;margin-bottom:24px;font-size:13px">
        <tr><th align="left" style="padding:6px;border-bottom:1px solid #ddd">Tenant</th>
            <th align="right" style="padding:6px;border-bottom:1px solid #ddd">Listings</th>
            <th align="right" style="padding:6px;border-bottom:1px solid #ddd">Nights</th>
            <th align="right" style="padding:6px;border-bottom:1px solid #ddd">Median |%error|</th>
            <th align="right" style="padding:6px;border-bottom:1px solid #ddd">Directional accuracy</th></tr>
        ${bt.tenants
          .map(
            (t) => `
        <tr>
          <td style="padding:6px;border-bottom:1px solid #f0f0f0">${ESC(t.tenantName)}</td>
          <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${t.listingsTested}</td>
          <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${t.nightsTested}</td>
          <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${PCT(t.medianAbsPctError)}</td>
          <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${PCT(t.directionalAccuracy)}</td>
        </tr>`
          )
          .join("")}
      </table>
    `);
  }

  // Per-tenant details
  for (const summary of summaries) {
    const rows = await prisma.pricingComparisonSnapshot.findMany({
      where: { tenantId: summary.tenantId, snapshotDate: new Date(`${summary.snapshotDate}T00:00:00Z`) },
      select: {
        listingId: true,
        targetDate: true,
        ourRate: true,
        hostawayRate: true,
        deltaPct: true,
        classification: true,
        windowDays: true,
        ourBreakdown: true,
        divergenceCause: true,
        ourLift: true,
        plLift: true,
        liftDelta: true,
        ourOccupancyMultiplier: true,
        rateWithoutOccupancy: true,
        keyDataForwardOcc: true,
        keyDataForwardAdr: true,
        keyDataForwardOccLy: true,
        keyDataForwardAdrLy: true
      }
    });
    const byBand = aggregateByBand(rows);
    const byDow = aggregateByDoW(rows);
    const top = topDivergences(rows, 20);
    const byCause = aggregateByDivergenceCause(rows);

    // Resolve listing names for the top-20 table so the report shows
    // "Embassy 12 (Belfast)" not "cmng21u4p…". Scoped to this tenant per
    // the multi-tenant rule.
    const listingIdsInTop = Array.from(new Set(top.map((r) => r.listingId)));
    const listingNameRows =
      listingIdsInTop.length === 0
        ? []
        : await prisma.listing.findMany({
            where: { tenantId: summary.tenantId, id: { in: listingIdsInTop } },
            select: { id: true, name: true }
          });
    const listingNameById = new Map(listingNameRows.map((r) => [r.id, r.name]));

    sections.push(`
      <h2 style="margin:32px 0 8px">${ESC(summary.tenantName)}</h2>
      <h3 style="margin:16px 0 8px">By window-out</h3>
      <table style="border-collapse:collapse;width:100%;margin-bottom:16px">
        <tr><th align="left" style="padding:4px;border-bottom:1px solid #ddd">Band</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd">N</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Agreement %</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Mean Δ</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Median |Δ|</th></tr>
        ${byBand
          .map(
            (b) => `
        <tr>
          <td style="padding:4px;border-bottom:1px solid #f0f0f0">${ESC(b.band)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${b.total}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${PCT(b.agreementPct)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${SIGNED_PCT(b.meanDelta)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${PCT(b.medianAbsDelta)}</td>
        </tr>`
          )
          .join("")}
      </table>

      <h3 style="margin:16px 0 8px">By day-of-week</h3>
      <table style="border-collapse:collapse;width:100%;margin-bottom:16px">
        <tr><th align="left" style="padding:4px;border-bottom:1px solid #ddd">Day</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd">N</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Agreement %</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Mean Δ</th></tr>
        ${byDow
          .map(
            (d) => `
        <tr>
          <td style="padding:4px;border-bottom:1px solid #f0f0f0">${ESC(d.dow)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${d.total}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${PCT(d.agreementPct)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${SIGNED_PCT(d.meanDelta)}</td>
        </tr>`
          )
          .join("")}
      </table>

      <h3 style="margin:16px 0 8px">Divergence root-cause for ${ESC(summary.tenantName)}</h3>
      <table style="border-collapse:collapse;width:100%;margin-bottom:16px;font-size:13px">
        <tr><th align="left" style="padding:4px;border-bottom:1px solid #ddd">Cause</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Count</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd">% of divergent</th></tr>
        <tr style="background:#f0f7ef">
          <td style="padding:4px;border-bottom:1px solid #f0f0f0;color:#1a8a3a"><strong>Demand spike caught</strong> <span style="font-weight:normal;color:#1a8a3a">(good)</span></td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${byCause.spikeCaught}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${PCT(byCause.spikeCaughtPct)}</td>
        </tr>
        <tr style="background:#fbe9e9">
          <td style="padding:4px;border-bottom:1px solid #f0f0f0;color:#b91c1c"><strong>Demand spike missed</strong> <span style="font-weight:normal;color:#b91c1c">(money on table)</span></td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${byCause.spikeMissed}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${PCT(byCause.spikeMissedPct)}</td>
        </tr>
        <tr style="background:#f0f7ef">
          <td style="padding:4px;border-bottom:1px solid #f0f0f0;color:#1a8a3a"><strong>Occupancy-driven</strong> <span style="font-weight:normal;color:#1a8a3a">(good sign)</span></td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${byCause.occupancy}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${PCT(byCause.occupancyPct)}</td>
        </tr>
        <tr>
          <td style="padding:4px;border-bottom:1px solid #f0f0f0">Demand-signal</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${byCause.demand}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${PCT(byCause.demandPct)}</td>
        </tr>
        <tr>
          <td style="padding:4px;border-bottom:1px solid #f0f0f0">Level/logic</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${byCause.level}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${PCT(byCause.levelPct)}</td>
        </tr>
        <tr>
          <td style="padding:4px;border-bottom:1px solid #f0f0f0">Mixed</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${byCause.mixed}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${PCT(byCause.mixedPct)}</td>
        </tr>
      </table>

      <h3 style="margin:16px 0 8px">Top 20 divergences (largest |Δ%|)</h3>
      <p style="color:#666;font-size:12px;margin:0 0 8px">Our lift / PL lift = each engine's % deviation from its own ±14-day median for this listing. Without occ lift = our rate stripped of the occupancy multiplier — when this lands near PL, the divergence is occupancy-driven (good). KD occ YoY / KD ADR YoY = market vs same date last year — a green 🔥 flag fires when BOTH clear +15pp/+15%, i.e. a verifiable demand spike.</p>
      <table style="border-collapse:collapse;width:100%;font-size:12px">
        <tr><th align="left" style="padding:4px;border-bottom:1px solid #ddd">Listing</th>
            <th align="left" style="padding:4px;border-bottom:1px solid #ddd">Date</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Win</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Our</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd">PL</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Δ%</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Without occ lift</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Our lift</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd">PL lift</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd">KD occ YoY</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd">KD ADR YoY</th>
            <th align="left" style="padding:4px;border-bottom:1px solid #ddd">Cause</th></tr>
        ${top
          .map(
            (r) => {
              const causeLabel = r.divergenceCause ?? attributeDivergence(r.ourBreakdown);
              const isSpikeCaught = r.divergenceCause === "demand_spike_caught";
              const isSpikeMissed = r.divergenceCause === "demand_spike_missed";
              const isOccDriven = r.divergenceCause === "occupancy_driven";
              const rowStyle = isSpikeCaught || isOccDriven
                ? ' style="background:#f0f7ef"'
                : isSpikeMissed
                  ? ' style="background:#fbe9e9"'
                  : "";
              const causeColor = isSpikeCaught || isOccDriven ? "#1a8a3a" : isSpikeMissed ? "#b91c1c" : null;
              const causeStyle = causeColor
                ? `padding:4px;border-bottom:1px solid #f0f0f0;color:${causeColor};font-weight:600`
                : "padding:4px;border-bottom:1px solid #f0f0f0";
              const listingLabel = listingNameById.get(r.listingId) ?? r.listingId;
              // Compute YoY signals for the table; show a 🔥 prefix when
              // BOTH thresholds are cleared (mirrors the classifier's
              // spike condition).
              const occYoYPp =
                r.keyDataForwardOcc !== null && r.keyDataForwardOccLy !== null
                  ? r.keyDataForwardOcc - r.keyDataForwardOccLy
                  : null;
              const adrYoYPct =
                r.keyDataForwardAdr !== null && r.keyDataForwardAdrLy !== null && r.keyDataForwardAdrLy > 0
                  ? (r.keyDataForwardAdr - r.keyDataForwardAdrLy) / r.keyDataForwardAdrLy
                  : null;
              const spikeFire = occYoYPp !== null && adrYoYPct !== null && occYoYPp >= 0.15 && adrYoYPct >= 0.15;
              const occCell = occYoYPp === null ? "—" : `${spikeFire ? "🔥 " : ""}${occYoYPp >= 0 ? "+" : ""}${(occYoYPp * 100).toFixed(1)}pp`;
              const adrCell = adrYoYPct === null ? "—" : `${spikeFire ? "🔥 " : ""}${SIGNED_PCT(adrYoYPct)}`;
              const yoYColor = spikeFire ? "color:#1a8a3a;font-weight:600;" : "";
              return `
        <tr${rowStyle}>
          <td style="padding:4px;border-bottom:1px solid #f0f0f0">${ESC(listingLabel)}</td>
          <td style="padding:4px;border-bottom:1px solid #f0f0f0">${r.targetDate.toISOString().slice(0, 10)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${r.windowDays}d</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${GBP(Number(r.ourRate))}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${GBP(r.hostawayRate ? Number(r.hostawayRate) : null)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0;color:${(r.deltaPct ?? 0) > 0 ? "#1a8a3a" : "#b91c1c"}">${r.deltaPct === null ? "—" : SIGNED_PCT(r.deltaPct)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${r.rateWithoutOccupancy === null ? "—" : GBP(Number(r.rateWithoutOccupancy))}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${r.ourLift === null ? "—" : SIGNED_PCT(r.ourLift)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${r.plLift === null ? "—" : SIGNED_PCT(r.plLift)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0;${yoYColor}">${occCell}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0;${yoYColor}">${adrCell}</td>
          <td style="${causeStyle}">${ESC(causeLabel)}</td>
        </tr>`;
            }
          )
          .join("")}
      </table>
    `);
  }

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>KeyData trial — Day ${options.trialDayNumber}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#222;line-height:1.5;max-width:1100px;margin:24px auto;padding:0 24px}h1{font-size:22px}h2{font-size:18px;border-bottom:1px solid #ddd;padding-bottom:4px}h3{font-size:14px;color:#444}</style>
</head><body>
${sections.join("\n")}
<hr style="margin:32px 0 12px;border:none;border-top:1px solid #ddd">
<p style="color:#888;font-size:12px">Generated by the Signals KeyData trial overnight build. See <code>BUILD-LOG.md</code> for context.</p>
</body></html>`;
}
