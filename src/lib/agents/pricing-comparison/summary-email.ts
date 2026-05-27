/**
 * Day-14 KeyData trial summary email.
 *
 * Aggregates every PricingComparisonSnapshot and PricingDefensibilityAudit
 * within the trial window (KEYDATA_TRIAL_START → KEYDATA_TRIAL_END
 * inclusive) and renders one HTML email summarising the 14-day result.
 *
 * Sections:
 *   1. Overall agreement % across the trial
 *   2. Divergence root-cause split (aggregate)
 *   3. Per-tenant breakdown
 *   4. Window-out heatmap (band × trial-day, agreement %)
 *   5. Top 10 always-divergent listing-dates
 *   6. Backtest snapshot (latest run)
 *   7. Defensibility profile (sum of audits over the trial)
 *   8. Recommended action paragraph (auto-generated)
 *
 * The email subject is "[Signals Trial] Day 14 — KeyData trial summary".
 *
 * All Prisma queries scope to `tenantId` per the multi-tenant rule.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Prisma as PrismaTypes } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { listTrialTenants, trialDateWindow } from "@/lib/pricing/trial-tenants";
import { dedupSnapshotRows } from "@/lib/agents/pricing-comparison/snapshot-dedup";

const TRIAL_REPORTS_DIR = "/Users/markmccracken/Documents/signals/trial-reports";
const AGREEMENT_THRESHOLD_PCT = 0.05;

const ESC = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

const PCT = (n: number): string => `${(n * 100).toFixed(1)}%`;

function bandFor(windowDays: number): "0-7d" | "8-14d" | "15-30d" | "31-60d" | "61-90d" {
  if (windowDays <= 7) return "0-7d";
  if (windowDays <= 14) return "8-14d";
  if (windowDays <= 30) return "15-30d";
  if (windowDays <= 60) return "31-60d";
  return "61-90d";
}

type SnapshotRow = {
  tenantId: string;
  listingId: string;
  snapshotDate: Date;
  targetDate: Date;
  ourRate: PrismaTypes.Decimal;
  hostawayRate: PrismaTypes.Decimal | null;
  deltaPct: number | null;
  classification: string;
  windowDays: number;
  divergenceCause: string | null;
  createdAt: Date;
};

async function loadAllSnapshots(tenantIds: string[], start: string, end: string): Promise<SnapshotRow[]> {
  if (tenantIds.length === 0) return [];
  const rawRows = await prisma.pricingComparisonSnapshot.findMany({
    where: {
      tenantId: { in: tenantIds },
      snapshotDate: { gte: new Date(`${start}T00:00:00Z`), lte: new Date(`${end}T23:59:59Z`) }
    },
    select: {
      tenantId: true,
      listingId: true,
      snapshotDate: true,
      targetDate: true,
      ourRate: true,
      hostawayRate: true,
      deltaPct: true,
      classification: true,
      windowDays: true,
      divergenceCause: true,
      // 2026-05-27 PM trial-report fix: dedup by latest createdAt per
      // (tenant, listing, target, snapshot) so same-day manual reruns
      // don't blend stale rows into the trial-summary metrics.
      createdAt: true
    }
  });
  return dedupSnapshotRows(rawRows);
}

async function loadAllAudits(tenantIds: string[], start: string, end: string) {
  if (tenantIds.length === 0) return [];
  return prisma.pricingDefensibilityAudit.findMany({
    where: {
      tenantId: { in: tenantIds },
      snapshotDate: { gte: new Date(`${start}T00:00:00Z`), lte: new Date(`${end}T23:59:59Z`) }
    },
    select: { tenantId: true, verdict: true, snapshotDate: true }
  });
}

async function loadListingNames(listingIds: string[]): Promise<Map<string, string>> {
  if (listingIds.length === 0) return new Map();
  const rows = await prisma.listing.findMany({
    where: { id: { in: listingIds } },
    select: { id: true, name: true }
  });
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function loadLatestBacktest(): Promise<{
  runId?: string;
  tenants: Array<{
    tenantName: string;
    listingsTested: number;
    nightsTested: number;
    medianAbsPctError: number;
    directionalAccuracy: number;
  }>;
} | null> {
  try {
    const entries = await readdir(TRIAL_REPORTS_DIR);
    const candidates = entries
      .filter((f) => /^keydata-backtest-\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort()
      .reverse();
    if (candidates.length === 0) return null;
    const raw = await readFile(path.join(TRIAL_REPORTS_DIR, candidates[0]), "utf8");
    return JSON.parse(raw) as Awaited<ReturnType<typeof loadLatestBacktest>>;
  } catch {
    return null;
  }
}

function recommendedAction(input: {
  overallAgreement: number;
  /** Agreement % + "good" divergences (occupancy_driven + demand_spike_caught count as our model working). */
  effectiveAgreement: number;
  divergenceCauseDemand: number;
  divergenceCauseOccupancy: number;
  divergenceCauseSpikeCaught: number;
  divergenceCauseSpikeMissed: number;
  divergenceCauseTotal: number;
  defensibleShare: number;
  medianAbsBacktestError: number | null;
}): string {
  const trueDisagreementTotal = Math.max(
    0,
    input.divergenceCauseTotal - input.divergenceCauseOccupancy - input.divergenceCauseSpikeCaught
  );
  const demandShare = trueDisagreementTotal > 0 ? input.divergenceCauseDemand / trueDisagreementTotal : 0;
  const occupancyShare = input.divergenceCauseTotal > 0 ? input.divergenceCauseOccupancy / input.divergenceCauseTotal : 0;
  const spikeCaughtShare = input.divergenceCauseTotal > 0 ? input.divergenceCauseSpikeCaught / input.divergenceCauseTotal : 0;
  const spikeMissedShare = input.divergenceCauseTotal > 0 ? input.divergenceCauseSpikeMissed / input.divergenceCauseTotal : 0;
  const headlineParts: string[] = [];

  // Use effectiveAgreement (true agreement + occupancy-driven + spike-
  // caught "good" divergences) for the headline verdict — all three are
  // our model adapting correctly, not actual disagreements with PL.
  if (input.effectiveAgreement >= 0.6) {
    headlineParts.push("Recommend SUBSCRIBE to KeyData (or a substitute market-data feed)");
  } else if (input.effectiveAgreement >= 0.4) {
    headlineParts.push("Borderline — consider a tighter follow-on trial before subscribing");
  } else {
    headlineParts.push("Recommend HOLD — own-history-only pricing diverges materially from PriceLabs");
  }

  if (spikeCaughtShare >= 0.1) {
    headlineParts.push(`${(spikeCaughtShare * 100).toFixed(0)}% of divergences are demand spikes we caught and PL didn't (good — event-driven dates where our engine is right)`);
  }
  if (spikeMissedShare >= 0.05) {
    headlineParts.push(`${(spikeMissedShare * 100).toFixed(0)}% of divergences are demand spikes we MISSED (PL priced up, we didn't — money on the table; fix before promoting)`);
  }
  if (occupancyShare >= 0.2) {
    headlineParts.push(`${(occupancyShare * 100).toFixed(0)}% of divergences are explained by our occupancy multiplier (good sign — our model is reacting to demand pressure)`);
  }

  if (demandShare >= 0.6) {
    headlineParts.push("most remaining disagreements come from how each engine reads demand — KeyData (or a similar feed) would mostly fix it");
  } else if (demandShare <= 0.2) {
    headlineParts.push("most remaining disagreements are level/logic differences — feed alone won't close them; revisit base/floor calibration");
  } else {
    headlineParts.push("remaining disagreement is mixed (demand + level) — feed helps but won't fully close the gap");
  }

  if (input.defensibleShare < 0.5) {
    headlineParts.push(`only ${(input.defensibleShare * 100).toFixed(0)}% of recommendations were graded "defensible" by the audit — fix logic gaps before promoting`);
  }

  if (input.medianAbsBacktestError !== null) {
    headlineParts.push(`backtest median |%error| is ${(input.medianAbsBacktestError * 100).toFixed(2)}% on realised bookings`);
  }

  return headlineParts.join("; ") + ".";
}

export type Day14SummaryRenderInput = {
  /** Snapshot date this Day-14 email is anchored to (typically end of window). */
  reportDate: string;
};

export async function renderDay14SummaryHtml(input: Day14SummaryRenderInput): Promise<{ html: string; subject: string; metrics: object }> {
  const trialWindow = trialDateWindow();
  const tenants = await listTrialTenants();
  const tenantIds = tenants.map((t) => t.id);
  const tenantNameById = new Map(tenants.map((t) => [t.id, t.name]));

  const [snapshots, audits, backtest] = await Promise.all([
    loadAllSnapshots(tenantIds, trialWindow.start, trialWindow.end),
    loadAllAudits(tenantIds, trialWindow.start, trialWindow.end),
    loadLatestBacktest()
  ]);

  const total = snapshots.length;
  const totalAgreed = snapshots.filter((r) => {
    if (r.deltaPct === null) return false;
    return Math.abs(r.deltaPct) <= AGREEMENT_THRESHOLD_PCT;
  }).length;
  const totalWithRate = snapshots.filter((r) => r.deltaPct !== null).length;
  const overallAgreement = totalWithRate > 0 ? totalAgreed / totalWithRate : 0;

  // Divergence-cause aggregate. The `occupancy_driven` bucket is a
  // "good sign" — surfaced distinctly so it doesn't pollute the
  // demand/level/mixed counts that suggest the engines actually disagree.
  let demand = 0;
  let level = 0;
  let mixed = 0;
  let occupancy = 0;
  let spikeCaught = 0;
  let spikeMissed = 0;
  for (const r of snapshots) {
    if (r.divergenceCause === "demand_disagreement") demand += 1;
    else if (r.divergenceCause === "level_disagreement") level += 1;
    else if (r.divergenceCause === "mixed") mixed += 1;
    else if (r.divergenceCause === "occupancy_driven") occupancy += 1;
    else if (r.divergenceCause === "demand_spike_caught") spikeCaught += 1;
    else if (r.divergenceCause === "demand_spike_missed") spikeMissed += 1;
  }
  const divergenceTotal = demand + level + mixed + occupancy + spikeCaught + spikeMissed;

  // Per-tenant breakdown
  const byTenant = tenants.map((t) => {
    const rows = snapshots.filter((r) => r.tenantId === t.id);
    const rated = rows.filter((r) => r.deltaPct !== null);
    const agreed = rated.filter((r) => Math.abs(r.deltaPct ?? 0) <= AGREEMENT_THRESHOLD_PCT).length;
    const tenantDemand = rows.filter((r) => r.divergenceCause === "demand_disagreement").length;
    const tenantLevel = rows.filter((r) => r.divergenceCause === "level_disagreement").length;
    const tenantMixed = rows.filter((r) => r.divergenceCause === "mixed").length;
    const tenantOccupancy = rows.filter((r) => r.divergenceCause === "occupancy_driven").length;
    const tenantSpikeCaught = rows.filter((r) => r.divergenceCause === "demand_spike_caught").length;
    const tenantSpikeMissed = rows.filter((r) => r.divergenceCause === "demand_spike_missed").length;
    return {
      tenantName: t.name,
      cells: rows.length,
      cellsRated: rated.length,
      agreementPct: rated.length > 0 ? agreed / rated.length : 0,
      spikeCaught: tenantSpikeCaught,
      spikeMissed: tenantSpikeMissed,
      occupancy: tenantOccupancy,
      demand: tenantDemand,
      level: tenantLevel,
      mixed: tenantMixed
    };
  });

  // Window-out × trial-day heatmap. Trial-day = days since trial start + 1.
  const bandList = ["0-7d", "8-14d", "15-30d", "31-60d", "61-90d"] as const;
  const startMs = new Date(`${trialWindow.start}T00:00:00Z`).getTime();
  const heatmapBuckets = new Map<string, { agreed: number; total: number }>();
  for (const r of snapshots) {
    if (r.deltaPct === null) continue;
    const band = bandFor(r.windowDays);
    const trialDay = Math.max(1, Math.round((r.snapshotDate.getTime() - startMs) / 86400000) + 1);
    const key = `${band}::${trialDay}`;
    const cur = heatmapBuckets.get(key) ?? { agreed: 0, total: 0 };
    cur.total += 1;
    if (Math.abs(r.deltaPct) <= AGREEMENT_THRESHOLD_PCT) cur.agreed += 1;
    heatmapBuckets.set(key, cur);
  }
  // Day-of-trial columns: every snapshot date that actually has data.
  const dayCols = Array.from(
    new Set(
      snapshots.map((r) => Math.max(1, Math.round((r.snapshotDate.getTime() - startMs) / 86400000) + 1))
    )
  ).sort((a, b) => a - b);

  // Top 10 always-divergent listing-dates: group by (listingId, targetDate)
  // and count how many snapshot dates this cell was divergent (|Δ| > 5%).
  // The longer it stayed divergent, the more interesting it is.
  const divergenceFrequency = new Map<string, { listingId: string; targetDate: Date; tenantId: string; divergentDays: number; totalDays: number; medianAbsDelta: number; latestDelta: number | null }>();
  for (const r of snapshots) {
    if (r.deltaPct === null) continue;
    const key = `${r.listingId}::${r.targetDate.toISOString().slice(0, 10)}`;
    const cur = divergenceFrequency.get(key) ?? {
      listingId: r.listingId,
      targetDate: r.targetDate,
      tenantId: r.tenantId,
      divergentDays: 0,
      totalDays: 0,
      medianAbsDelta: 0,
      latestDelta: null as number | null
    };
    cur.totalDays += 1;
    if (Math.abs(r.deltaPct) > AGREEMENT_THRESHOLD_PCT) cur.divergentDays += 1;
    cur.latestDelta = r.deltaPct;
    divergenceFrequency.set(key, cur);
  }
  // Compute median abs delta per cell in a second pass for stability.
  for (const [k, v] of divergenceFrequency) {
    const cellRows = snapshots.filter(
      (r) => r.listingId === v.listingId && r.targetDate.toISOString().slice(0, 10) === v.targetDate.toISOString().slice(0, 10) && r.deltaPct !== null
    );
    const abs = cellRows.map((r) => Math.abs(r.deltaPct ?? 0)).sort((a, b) => a - b);
    v.medianAbsDelta = abs.length === 0 ? 0 : abs[Math.floor(abs.length / 2)];
    divergenceFrequency.set(k, v);
  }
  const topDivergent = Array.from(divergenceFrequency.values())
    .filter((v) => v.divergentDays >= 2) // ignore one-day blips
    .sort((a, b) => (b.divergentDays - a.divergentDays) || (b.medianAbsDelta - a.medianAbsDelta))
    .slice(0, 10);
  const listingNames = await loadListingNames(topDivergent.map((d) => d.listingId));

  // Defensibility profile
  let defensible = 0;
  let borderline = 0;
  let questionable = 0;
  for (const a of audits) {
    if (a.verdict === "defensible") defensible += 1;
    else if (a.verdict === "borderline") borderline += 1;
    else if (a.verdict === "questionable") questionable += 1;
  }
  const auditTotal = defensible + borderline + questionable;
  const defensibleShare = auditTotal > 0 ? defensible / auditTotal : 0;

  const medianAbsBacktest =
    backtest && backtest.tenants.length > 0
      ? backtest.tenants.map((t) => t.medianAbsPctError).sort((a, b) => a - b)[Math.floor(backtest.tenants.length / 2)]
      : null;

  // "Effective" agreement = raw agreement + occupancy-driven divergences
  // + demand-spike-caught divergences (all three are our model working,
  // not genuine disagreements). Spike-missed is NOT counted here — those
  // are real disagreements where PL is right and we're not. The headline
  // action uses effectiveAgreement so a strong occupancy/spike-catch
  // story nudges toward SUBSCRIBE rather than HOLD.
  const effectiveAgreement = totalWithRate > 0 ? (totalAgreed + occupancy + spikeCaught) / totalWithRate : 0;
  const action = recommendedAction({
    overallAgreement,
    effectiveAgreement,
    divergenceCauseDemand: demand,
    divergenceCauseOccupancy: occupancy,
    divergenceCauseSpikeCaught: spikeCaught,
    divergenceCauseSpikeMissed: spikeMissed,
    divergenceCauseTotal: divergenceTotal,
    defensibleShare,
    medianAbsBacktestError: medianAbsBacktest
  });

  // Build the HTML
  const sections: string[] = [];
  sections.push(`
    <h1 style="margin:0 0 4px">KeyData trial — Day 14 summary</h1>
    <p style="color:#444;margin:0 0 4px;font-size:13px">Trial window ${ESC(trialWindow.start)} → ${ESC(trialWindow.end)} · ${tenants.length} tenant${tenants.length === 1 ? "" : "s"} · ${total} listing-dates compared across ${dayCols.length} snapshot day${dayCols.length === 1 ? "" : "s"}</p>
    <p style="margin:16px 0 8px;font-size:14px"><strong>Headline:</strong> Overall agreement <strong>${PCT(overallAgreement)}</strong> across the trial. Effective agreement (incl. occupancy-driven "good" divergences): <strong>${PCT(effectiveAgreement)}</strong>.</p>
    <p style="margin:0 0 16px;font-size:13px;color:#444"><strong>Recommended action:</strong> ${ESC(action)}</p>
  `);

  sections.push(`
    <h2 style="margin:24px 0 8px">Divergence root-cause split (trial total)</h2>
    <table style="border-collapse:collapse;width:100%;margin-bottom:16px;font-size:13px">
      <tr><th align="left" style="padding:6px;border-bottom:1px solid #ddd">Cause</th>
          <th align="right" style="padding:6px;border-bottom:1px solid #ddd">Count</th>
          <th align="right" style="padding:6px;border-bottom:1px solid #ddd">% of divergent</th></tr>
      <tr style="background:#f0f7ef">
          <td style="padding:6px;border-bottom:1px solid #f0f0f0;color:#1a8a3a"><strong>Demand spike caught</strong> <span style="font-weight:normal">(good)</span></td>
          <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${spikeCaught}</td>
          <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${PCT(divergenceTotal > 0 ? spikeCaught / divergenceTotal : 0)}</td></tr>
      <tr style="background:#fbe9e9">
          <td style="padding:6px;border-bottom:1px solid #f0f0f0;color:#b91c1c"><strong>Demand spike missed</strong> <span style="font-weight:normal">(money on table)</span></td>
          <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${spikeMissed}</td>
          <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${PCT(divergenceTotal > 0 ? spikeMissed / divergenceTotal : 0)}</td></tr>
      <tr style="background:#f0f7ef">
          <td style="padding:6px;border-bottom:1px solid #f0f0f0;color:#1a8a3a"><strong>Occupancy-driven</strong> <span style="font-weight:normal">(good sign)</span></td>
          <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${occupancy}</td>
          <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${PCT(divergenceTotal > 0 ? occupancy / divergenceTotal : 0)}</td></tr>
      <tr><td style="padding:6px;border-bottom:1px solid #f0f0f0">Demand-signal</td>
          <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${demand}</td>
          <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${PCT(divergenceTotal > 0 ? demand / divergenceTotal : 0)}</td></tr>
      <tr><td style="padding:6px;border-bottom:1px solid #f0f0f0">Level/logic</td>
          <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${level}</td>
          <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${PCT(divergenceTotal > 0 ? level / divergenceTotal : 0)}</td></tr>
      <tr><td style="padding:6px;border-bottom:1px solid #f0f0f0">Mixed</td>
          <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${mixed}</td>
          <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${PCT(divergenceTotal > 0 ? mixed / divergenceTotal : 0)}</td></tr>
    </table>
  `);

  sections.push(`
    <h2 style="margin:24px 0 8px">Per-tenant breakdown</h2>
    <table style="border-collapse:collapse;width:100%;margin-bottom:16px;font-size:13px">
      <tr><th align="left" style="padding:6px;border-bottom:1px solid #ddd">Tenant</th>
          <th align="right" style="padding:6px;border-bottom:1px solid #ddd">Cells</th>
          <th align="right" style="padding:6px;border-bottom:1px solid #ddd">Agreement %</th>
          <th align="right" style="padding:6px;border-bottom:1px solid #ddd;color:#1a8a3a">Spike caught</th>
          <th align="right" style="padding:6px;border-bottom:1px solid #ddd;color:#b91c1c">Spike missed</th>
          <th align="right" style="padding:6px;border-bottom:1px solid #ddd;color:#1a8a3a">Occupancy</th>
          <th align="right" style="padding:6px;border-bottom:1px solid #ddd">Demand</th>
          <th align="right" style="padding:6px;border-bottom:1px solid #ddd">Level</th>
          <th align="right" style="padding:6px;border-bottom:1px solid #ddd">Mixed</th></tr>
      ${byTenant
        .map(
          (t) => `
      <tr>
        <td style="padding:6px;border-bottom:1px solid #f0f0f0">${ESC(t.tenantName)}</td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${t.cells}</td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${PCT(t.agreementPct)}</td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0;color:#1a8a3a">${t.spikeCaught}</td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0;color:#b91c1c">${t.spikeMissed}</td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0;color:#1a8a3a">${t.occupancy}</td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${t.demand}</td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${t.level}</td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${t.mixed}</td>
      </tr>`
        )
        .join("")}
    </table>
  `);

  sections.push(`
    <h2 style="margin:24px 0 8px">Window-out heatmap (agreement % by band × trial-day)</h2>
    <p style="color:#666;font-size:12px;margin:0 0 8px">Each cell shows the agreement % for that band, that day of the trial.</p>
    <table style="border-collapse:collapse;width:100%;margin-bottom:16px;font-size:12px">
      <tr><th align="left" style="padding:4px;border-bottom:1px solid #ddd">Band</th>
          ${dayCols.map((d) => `<th align="right" style="padding:4px;border-bottom:1px solid #ddd">D${d}</th>`).join("")}
      </tr>
      ${bandList
        .map((band) => {
          const cells = dayCols
            .map((d) => {
              const b = heatmapBuckets.get(`${band}::${d}`);
              if (!b || b.total === 0) return `<td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0;color:#bbb">—</td>`;
              const pct = b.agreed / b.total;
              const bg = pct >= 0.7 ? "#e6f4ea" : pct >= 0.4 ? "#fff7e0" : "#fde7e7";
              return `<td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0;background:${bg}">${PCT(pct)}</td>`;
            })
            .join("");
          return `<tr><td style="padding:4px;border-bottom:1px solid #f0f0f0"><strong>${band}</strong></td>${cells}</tr>`;
        })
        .join("")}
    </table>
  `);

  sections.push(`
    <h2 style="margin:24px 0 8px">Top 10 always-divergent listing-dates</h2>
    <p style="color:#666;font-size:12px;margin:0 0 8px">Cells (listing × target date) that were divergent on the most snapshot dates across the 14-day trial. These are the "structural" disagreements with PriceLabs, not blips.</p>
    <table style="border-collapse:collapse;width:100%;margin-bottom:16px;font-size:12px">
      <tr><th align="left" style="padding:4px;border-bottom:1px solid #ddd">Tenant</th>
          <th align="left" style="padding:4px;border-bottom:1px solid #ddd">Listing</th>
          <th align="left" style="padding:4px;border-bottom:1px solid #ddd">Target date</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Divergent days</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Total days</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Median |Δ%|</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Latest Δ%</th></tr>
      ${topDivergent
        .map(
          (d) => `
      <tr>
        <td style="padding:4px;border-bottom:1px solid #f0f0f0">${ESC(tenantNameById.get(d.tenantId) ?? d.tenantId)}</td>
        <td style="padding:4px;border-bottom:1px solid #f0f0f0">${ESC(listingNames.get(d.listingId) ?? d.listingId)}</td>
        <td style="padding:4px;border-bottom:1px solid #f0f0f0">${d.targetDate.toISOString().slice(0, 10)}</td>
        <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${d.divergentDays}</td>
        <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${d.totalDays}</td>
        <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${PCT(d.medianAbsDelta)}</td>
        <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${d.latestDelta === null ? "—" : (d.latestDelta >= 0 ? "+" : "") + (d.latestDelta * 100).toFixed(1) + "%"}</td>
      </tr>`
        )
        .join("")}
    </table>
  `);

  if (backtest) {
    sections.push(`
      <h2 style="margin:24px 0 8px">Backtest snapshot (final)</h2>
      <p style="color:#666;font-size:13px;margin:0 0 8px">Our engine vs realised bookings across the trailing year — most recent run.</p>
      <table style="border-collapse:collapse;width:100%;margin-bottom:16px;font-size:13px">
        <tr><th align="left" style="padding:6px;border-bottom:1px solid #ddd">Tenant</th>
            <th align="right" style="padding:6px;border-bottom:1px solid #ddd">Listings</th>
            <th align="right" style="padding:6px;border-bottom:1px solid #ddd">Nights</th>
            <th align="right" style="padding:6px;border-bottom:1px solid #ddd">Median |%error|</th>
            <th align="right" style="padding:6px;border-bottom:1px solid #ddd">Directional accuracy</th></tr>
        ${backtest.tenants
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

  sections.push(`
    <h2 style="margin:24px 0 8px">Defensibility profile (trial total)</h2>
    <p style="margin:0 0 16px;font-size:13px">${auditTotal} listing-dates graded by Claude across the trial:
      <strong style="color:#1a8a3a">${defensible} defensible (${PCT(defensibleShare)})</strong> ·
      <strong style="color:#bf7f00">${borderline} borderline</strong> ·
      <strong style="color:#b91c1c">${questionable} questionable</strong>.</p>
  `);

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>KeyData trial — Day 14 summary</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#222;line-height:1.5;max-width:1100px;margin:24px auto;padding:0 24px}h1{font-size:22px}h2{font-size:18px;border-bottom:1px solid #ddd;padding-bottom:4px}h3{font-size:14px;color:#444}</style>
</head><body>
${sections.join("\n")}
<hr style="margin:32px 0 12px;border:none;border-top:1px solid #ddd">
<p style="color:#888;font-size:12px">Generated by the Signals KeyData trial Day-14 summary job. See <code>BUILD-LOG.md</code> for context.</p>
</body></html>`;

  return {
    html,
    subject: "[Signals Trial] Day 14 — KeyData trial summary",
    metrics: {
      reportDate: input.reportDate,
      window: trialWindow,
      tenants: tenants.length,
      totalCells: total,
      overallAgreement,
      divergence: { spikeCaught, spikeMissed, occupancy, demand, level, mixed, total: divergenceTotal },
      effectiveAgreement,
      audits: { defensible, borderline, questionable, total: auditTotal },
      backtest,
      topDivergent: topDivergent.map((d) => ({
        tenantName: tenantNameById.get(d.tenantId) ?? d.tenantId,
        listingId: d.listingId,
        listingName: listingNames.get(d.listingId) ?? null,
        targetDate: d.targetDate.toISOString().slice(0, 10),
        divergentDays: d.divergentDays,
        totalDays: d.totalDays,
        medianAbsDelta: d.medianAbsDelta,
        latestDelta: d.latestDelta
      })),
      action
    }
  };
}
