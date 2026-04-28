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

export async function renderDailyComparisonHtml(
  summaries: ComparisonRunSummary[],
  options: { snapshotDate: string; trialDayNumber: number; defensibilityVerdicts?: { defensible: number; borderline: number; questionable: number } }
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

  sections.push(`
    <h1 style="margin:0 0 8px">KeyData trial — Day ${options.trialDayNumber}</h1>
    <p style="color:#666;margin:0 0 24px">Snapshot ${ESC(options.snapshotDate)} · ${summaries.length} tenant${summaries.length === 1 ? "" : "s"} · ${allListings} listings · ${allCells} listing-dates compared</p>
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
        ourBreakdown: true
      }
    });
    const byBand = aggregateByBand(rows);
    const byDow = aggregateByDoW(rows);
    const top = topDivergences(rows, 20);

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

      <h3 style="margin:16px 0 8px">Top 20 divergences (largest |Δ%|)</h3>
      <table style="border-collapse:collapse;width:100%;font-size:13px">
        <tr><th align="left" style="padding:4px;border-bottom:1px solid #ddd">Listing</th>
            <th align="left" style="padding:4px;border-bottom:1px solid #ddd">Date</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Window</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Our</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Hostaway</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Δ%</th>
            <th align="left" style="padding:4px;border-bottom:1px solid #ddd">Likely driver</th></tr>
        ${top
          .map(
            (r) => `
        <tr>
          <td style="padding:4px;border-bottom:1px solid #f0f0f0;font-family:monospace;font-size:11px">${ESC(r.listingId)}</td>
          <td style="padding:4px;border-bottom:1px solid #f0f0f0">${r.targetDate.toISOString().slice(0, 10)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${r.windowDays}d</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${GBP(Number(r.ourRate))}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${GBP(r.hostawayRate ? Number(r.hostawayRate) : null)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0;color:${(r.deltaPct ?? 0) > 0 ? "#1a8a3a" : "#b91c1c"}">${r.deltaPct === null ? "—" : SIGNED_PCT(r.deltaPct)}</td>
          <td style="padding:4px;border-bottom:1px solid #f0f0f0">${ESC(attributeDivergence(r.ourBreakdown))}</td>
        </tr>`
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
