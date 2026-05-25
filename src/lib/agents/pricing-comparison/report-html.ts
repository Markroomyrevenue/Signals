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
import type { ListingCalibrationRow } from "@/lib/agents/pricing-comparison/listing-calibration";
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

function bandFor(windowDays: number): "0-7d" | "8-14d" | "15-30d" | "31-60d" | "61-90d" | "91-180d" | "181-270d" {
  if (windowDays <= 7) return "0-7d";
  if (windowDays <= 14) return "8-14d";
  if (windowDays <= 30) return "15-30d";
  if (windowDays <= 60) return "31-60d";
  if (windowDays <= 90) return "61-90d";
  if (windowDays <= 180) return "91-180d";
  return "181-270d";
}

function aggregateByBand(rows: RawSnapshot[]) {
  const bands = ["0-7d", "8-14d", "15-30d", "31-60d", "61-90d", "91-180d", "181-270d"] as const;
  return bands.map((band) => {
    const filtered = rows.filter((r) => bandFor(r.windowDays) === band);
    const withDelta = filtered.filter((r) => r.deltaPct !== null);
    const agree = filtered.filter((r) => r.classification === "agree").length;
    const meanDelta = withDelta.length > 0 ? withDelta.reduce((s, r) => s + (r.deltaPct ?? 0), 0) / withDelta.length : 0;
    const absVals = withDelta.map((r) => Math.abs(r.deltaPct ?? 0)).sort((a, b) => a - b);
    const medianAbs = absVals.length > 0 ? absVals[Math.floor(absVals.length / 2)] : 0;
    // Pre-occ agreement per band — uses rateWithoutOccupancy when present,
    // else falls back to ourRate × deltaPct logic (deltaPct already
    // computed on ourRate so this fallback inflates the pre-occ measure
    // for cells with no occupancy multiplier; that's a small share and
    // is documented in the agent header).
    let preOccWithin5 = 0;
    let preOccWithin10 = 0;
    let preOccRated = 0;
    for (const r of filtered) {
      if (r.hostawayRate === null || r.deltaPct === null) continue;
      const pl = Number(r.hostawayRate);
      if (!Number.isFinite(pl) || pl <= 0) continue;
      const compareRate = r.rateWithoutOccupancy !== null && Number(r.rateWithoutOccupancy) > 0
        ? Number(r.rateWithoutOccupancy)
        : Number(r.ourRate);
      const absPre = Math.abs((compareRate - pl) / pl);
      preOccRated += 1;
      if (absPre <= 0.05) preOccWithin5 += 1;
      if (absPre <= 0.10) preOccWithin10 += 1;
    }
    return {
      band,
      total: filtered.length,
      agree,
      agreementPct: filtered.length > 0 ? agree / filtered.length : 0,
      meanDelta,
      medianAbsDelta: medianAbs,
      preOccAgreement5: preOccRated > 0 ? preOccWithin5 / preOccRated : 0,
      preOccAgreement10: preOccRated > 0 ? preOccWithin10 / preOccRated : 0,
      preOccRated
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

/**
 * Find structural misses across all tenants for this snapshot: cells
 * where pre-occupancy |Δ| > 10% for 2+ consecutive snapshot dates ending
 * on today. We look back N=7 days; ≥2 consecutive misses ending today
 * counts. These are the tuning candidates — random one-day blips are
 * not interesting, sustained drift IS.
 *
 * Why "ending today": yesterday's miss that resolved today is no
 * longer a problem.
 */
async function renderStructuralMissesSection(sections: string[], summaries: ComparisonRunSummary[]): Promise<void> {
  if (summaries.length === 0) return;
  const snapshotDate = summaries[0].snapshotDate;
  const tenantIds = Array.from(new Set(summaries.map((s) => s.tenantId)));
  const lookbackDays = 7;
  const endIso = snapshotDate;
  const startMs = new Date(`${endIso}T00:00:00Z`).getTime() - (lookbackDays - 1) * 86400000;
  const startIso = new Date(startMs).toISOString().slice(0, 10);
  const rows = await prisma.pricingComparisonSnapshot.findMany({
    where: {
      tenantId: { in: tenantIds },
      snapshotDate: { gte: new Date(`${startIso}T00:00:00Z`), lte: new Date(`${endIso}T23:59:59Z`) }
    },
    select: {
      tenantId: true,
      listingId: true,
      snapshotDate: true,
      targetDate: true,
      ourRate: true,
      hostawayRate: true,
      rateWithoutOccupancy: true,
      windowDays: true
    }
  });
  // Group by (listingId, targetDate ISO). For each group, compute the
  // pre-occ delta on each snapshot date in the lookback window. Count
  // the trailing streak of consecutive misses ending on snapshotDate.
  type Key = string; // `${listingId}::${targetIso}`
  const groups = new Map<Key, Array<{ snapshotIso: string; preOccDelta: number; ourRate: number; pl: number; rateWithoutOccupancy: number | null; tenantId: string; listingId: string; targetIso: string; windowDays: number }>>();
  for (const r of rows) {
    if (r.hostawayRate === null) continue;
    const pl = Number(r.hostawayRate);
    if (!Number.isFinite(pl) || pl <= 0) continue;
    const compareRate =
      r.rateWithoutOccupancy !== null && Number(r.rateWithoutOccupancy) > 0
        ? Number(r.rateWithoutOccupancy)
        : Number(r.ourRate);
    const preOccDelta = (compareRate - pl) / pl;
    const k: Key = `${r.listingId}::${r.targetDate.toISOString().slice(0, 10)}`;
    const list = groups.get(k) ?? [];
    list.push({
      snapshotIso: r.snapshotDate.toISOString().slice(0, 10),
      preOccDelta,
      ourRate: Number(r.ourRate),
      pl,
      rateWithoutOccupancy: r.rateWithoutOccupancy !== null ? Number(r.rateWithoutOccupancy) : null,
      tenantId: r.tenantId,
      listingId: r.listingId,
      targetIso: r.targetDate.toISOString().slice(0, 10),
      windowDays: r.windowDays
    });
    groups.set(k, list);
  }
  type Streak = { tenantId: string; listingId: string; targetIso: string; windowDays: number; streakLen: number; medianAbsDelta: number; latestDelta: number; latestOur: number; latestPl: number; latestRateWithoutOcc: number | null };
  const streaks: Streak[] = [];
  for (const [, snapshots] of groups) {
    snapshots.sort((a, b) => a.snapshotIso.localeCompare(b.snapshotIso));
    const latest = snapshots[snapshots.length - 1];
    if (latest.snapshotIso !== endIso) continue;
    // Walk backwards from latest, counting consecutive snapshot-dates
    // with |preOccDelta| > 10%. Allow snapshot-date gaps (the run may
    // have missed a day) — we only stop the streak on a day that was
    // present in the DB AND had |delta| <= 10%.
    let streakLen = 0;
    const absVals: number[] = [];
    for (let i = snapshots.length - 1; i >= 0; i -= 1) {
      const s = snapshots[i];
      if (Math.abs(s.preOccDelta) > 0.10) {
        streakLen += 1;
        absVals.push(Math.abs(s.preOccDelta));
      } else {
        break;
      }
    }
    if (streakLen < 2) continue;
    const sortedAbs = [...absVals].sort((a, b) => a - b);
    const medianAbsDelta = sortedAbs[Math.floor(sortedAbs.length / 2)];
    streaks.push({
      tenantId: latest.tenantId,
      listingId: latest.listingId,
      targetIso: latest.targetIso,
      windowDays: latest.windowDays,
      streakLen,
      medianAbsDelta,
      latestDelta: latest.preOccDelta,
      latestOur: latest.ourRate,
      latestPl: latest.pl,
      latestRateWithoutOcc: latest.rateWithoutOccupancy
    });
  }
  // Sort: longest streak first, then largest median |Δ| as tiebreak.
  streaks.sort((a, b) => (b.streakLen - a.streakLen) || (b.medianAbsDelta - a.medianAbsDelta));
  const top = streaks.slice(0, 20);
  // Listing name lookup.
  const listingIds = Array.from(new Set(top.map((t) => t.listingId)));
  const listingNameRows =
    listingIds.length === 0
      ? []
      : await prisma.listing.findMany({
          where: { id: { in: listingIds } },
          select: { id: true, name: true }
        });
  const nameById = new Map(listingNameRows.map((r) => [r.id, r.name]));
  const tenantNameById = new Map(summaries.map((s) => [s.tenantId, s.tenantName]));
  sections.push(`
    <h2 style="margin:32px 0 8px">Structural misses (the tuning queue)</h2>
    <p style="color:#666;font-size:13px;margin:0 0 12px">Listing-dates where pre-occupancy |Δ| has stayed &gt; 10% on ${lookbackDays}-day lookback for at least 2 consecutive snapshot days ending today. These are model errors, not noise. Showing top 20 by streak length. ${streaks.length === 0 ? '<strong style="color:#1a8a3a">None today.</strong> ' : `<strong>${streaks.length} cells in streak today.</strong> `}</p>
    ${
      top.length === 0
        ? ""
        : `<table style="border-collapse:collapse;width:100%;font-size:12px;margin-bottom:16px">
      <tr><th align="left" style="padding:4px;border-bottom:1px solid #ddd">Tenant</th>
          <th align="left" style="padding:4px;border-bottom:1px solid #ddd">Listing</th>
          <th align="left" style="padding:4px;border-bottom:1px solid #ddd">Target date</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Window</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Streak (days)</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Our (no occ)</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd">PL</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Latest Δ%</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Median |Δ%|</th></tr>
      ${top
        .map((t) => `
      <tr>
        <td style="padding:4px;border-bottom:1px solid #f0f0f0">${ESC(tenantNameById.get(t.tenantId) ?? t.tenantId)}</td>
        <td style="padding:4px;border-bottom:1px solid #f0f0f0">${ESC(nameById.get(t.listingId) ?? t.listingId)}</td>
        <td style="padding:4px;border-bottom:1px solid #f0f0f0">${ESC(t.targetIso)}</td>
        <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${t.windowDays}d</td>
        <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0;font-weight:600">${t.streakLen}</td>
        <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${t.latestRateWithoutOcc !== null ? GBP(t.latestRateWithoutOcc) : GBP(t.latestOur)}</td>
        <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${GBP(t.latestPl)}</td>
        <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0;color:${t.latestDelta > 0 ? "#1a8a3a" : "#b91c1c"}">${SIGNED_PCT(t.latestDelta)}</td>
        <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${PCT(t.medianAbsDelta)}</td>
      </tr>`)
        .join("")}
    </table>`
    }
  `);
}

/**
 * "31-90 day trough — what's binding" section.
 *
 * For the booking-window band where pre-occupancy delta is worst
 * (2026-05-19 baseline: -20% at 31-60d, -29% at 61-90d), this section
 * reads the per-cell `troughDiagnostic` payload baked onto
 * `ourBreakdown` by the agent and aggregates ceiling/floor-hit rates
 * per multiplier. Tomorrow morning's email tells us exactly which knob
 * is binding without manual SQL.
 */
async function renderTroughDiagnosticSection(sections: string[], summaries: ComparisonRunSummary[]): Promise<void> {
  if (summaries.length === 0) return;
  const snapshotDate = summaries[0].snapshotDate;
  const tenantIds = Array.from(new Set(summaries.map((s) => s.tenantId)));
  const rows = await prisma.pricingComparisonSnapshot.findMany({
    where: {
      tenantId: { in: tenantIds },
      snapshotDate: new Date(`${snapshotDate}T00:00:00Z`),
      windowDays: { gte: 31, lte: 90 }
    },
    select: {
      listingId: true,
      targetDate: true,
      windowDays: true,
      ourRate: true,
      hostawayRate: true,
      deltaPct: true,
      ourBreakdown: true
    }
  });
  if (rows.length === 0) {
    sections.push(`
      <h2 style="margin:32px 0 8px">31-90 day trough — what's binding</h2>
      <p style="color:#666;font-size:13px;margin:0 0 16px">No cells in the 31-90d booking-window band today.</p>
    `);
    return;
  }
  type DiagRow = {
    listingId: string;
    targetIso: string;
    daysToCheckIn: number;
    ourRate: number;
    plRate: number | null;
    deltaPct: number | null;
    diag: {
      multipliers: {
        // `own`/`kd` were added to the troughDiagnostic payload on
        // 2026-05-20 so the report can show why seasonality is flat —
        // i.e. whether the own monthly index is genuinely ~1.0, the KD
        // index is, or the blend is squashing both toward 1.0.
        //
        // `ownSampleSize` / `ownSampleAboveGate` / `ownWeight` /
        // `marketWeight` were added on 2026-05-21 with the
        // portfolio-aggregated sample-gated own/KD blend — surfaces
        // which cells landed on the own-led 0.85/0.15 weights vs the
        // KD-heavy 0.40/0.60 fallback.
        seasonality: {
          ceilingHit: boolean;
          floorHit: boolean;
          blended: number;
          own: number | null;
          kd: number | null;
          // Optional — only populated on snapshot rows written 2026-05-21+
          // (sample-gated blend); pre-2026-05-21 rows in the same daily
          // partition may be missing these. Guard with `??` everywhere.
          ownSampleSize?: number | null;
          ownSampleAboveGate?: boolean;
          ownWeight?: number;
          marketWeight?: number;
        };
        dayOfWeek:   { ceilingHit: boolean; floorHit: boolean; blended: number };
        demand:      { ceilingHit: boolean; floorHit: boolean; finalMultiplier: number; dominantSignal: string };
        occupancy:   { multiplier: number; bucketLowPct: number; bucketHighPct: number };
        leadTimeFloor: { engaged: boolean };
        // Optional — only populated on snapshot rows written 2026-05-22+
        // (events lever wired). Pre-events rows in the same daily
        // partition won't have this; renderer falls back to no-event.
        events?: { multiplier: number; adjPct: number | null };
      };
    } | null;
  };
  const diagRows: DiagRow[] = rows
    .map((r) => {
      const breakdown = (r.ourBreakdown ?? {}) as { troughDiagnostic?: DiagRow["diag"] };
      return {
        listingId: r.listingId,
        targetIso: r.targetDate.toISOString().slice(0, 10),
        daysToCheckIn: r.windowDays,
        ourRate: Number(r.ourRate),
        plRate: r.hostawayRate !== null ? Number(r.hostawayRate) : null,
        deltaPct: r.deltaPct,
        diag: breakdown.troughDiagnostic ?? null
      };
    })
    .filter((r) => r.diag !== null);

  const totalCells = diagRows.length;
  const countAt = (predicate: (r: DiagRow) => boolean) => diagRows.filter(predicate).length;
  const pct = (n: number) => (totalCells === 0 ? 0 : n / totalCells);

  const seasonalityCeil = countAt((r) => r.diag!.multipliers.seasonality.ceilingHit);
  const seasonalityFloor = countAt((r) => r.diag!.multipliers.seasonality.floorHit);
  const dowCeil = countAt((r) => r.diag!.multipliers.dayOfWeek.ceilingHit);
  const dowFloor = countAt((r) => r.diag!.multipliers.dayOfWeek.floorHit);
  const demandCeil = countAt((r) => r.diag!.multipliers.demand.ceilingHit);
  const demandFloor = countAt((r) => r.diag!.multipliers.demand.floorHit);
  const demandCeilByLY = countAt((r) => r.diag!.multipliers.demand.ceilingHit && r.diag!.multipliers.demand.dominantSignal === "LY");
  const demandCeilByTrail = countAt((r) => r.diag!.multipliers.demand.ceilingHit && r.diag!.multipliers.demand.dominantSignal === "trail12mo");
  const ltfEngaged = countAt((r) => r.diag!.multipliers.leadTimeFloor.engaged);

  // Seasonality distribution across trough cells. Instrumentation only
  // (added 2026-05-20, extended 2026-05-21 with sample-gated blend
  // diagnostics) — tells us whether seasonality is flat because both
  // own and KD indices truly are ~1.0, because the blend is squashing
  // a non-flat input, or because the sample gate keeps the cell on
  // the KD-heavy fallback weights.
  const seasonalityStats = (() => {
    const own: number[] = [];
    const kd: number[] = [];
    const blended: number[] = [];
    const samples: number[] = [];
    let cellsOwnLed = 0;
    let cellsKdHeavy = 0;
    let cellsOwnOnly = 0;
    let cellsKdOnly = 0;
    let cellsNoSignal = 0;
    let cellsLegacyMissingWeights = 0;
    for (const r of diagRows) {
      const s = r.diag!.multipliers.seasonality;
      if (s.own !== null && s.own !== undefined && Number.isFinite(s.own)) own.push(s.own);
      if (s.kd !== null && s.kd !== undefined && Number.isFinite(s.kd)) kd.push(s.kd);
      if (Number.isFinite(s.blended)) blended.push(s.blended);
      if (typeof s.ownSampleSize === "number" && Number.isFinite(s.ownSampleSize)) samples.push(s.ownSampleSize);
      const hasOwn = s.own !== null && s.own !== undefined;
      const hasKd = s.kd !== null && s.kd !== undefined;
      // Pre-2026-05-21 snapshot rows don't carry ownSampleSize /
      // ownSampleAboveGate / ownWeight / marketWeight. They render in
      // the "legacy" bucket so the post-change cells are easy to read
      // separately on a transition-day report.
      const hasNewFields = typeof s.ownSampleAboveGate === "boolean" && typeof s.ownWeight === "number";
      if (!hasNewFields) {
        cellsLegacyMissingWeights += 1;
        continue;
      }
      if (hasOwn && hasKd) {
        if (s.ownSampleAboveGate) cellsOwnLed += 1;
        else cellsKdHeavy += 1;
      } else if (hasOwn) cellsOwnOnly += 1;
      else if (hasKd) cellsKdOnly += 1;
      else cellsNoSignal += 1;
    }
    const summarise = (arr: number[]) => {
      if (arr.length === 0) return { n: 0, mean: null as number | null, min: null as number | null, p50: null as number | null, max: null as number | null };
      const sorted = [...arr].sort((a, b) => a - b);
      const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
      return {
        n: sorted.length,
        mean,
        min: sorted[0],
        p50: sorted[Math.floor(sorted.length / 2)],
        max: sorted[sorted.length - 1]
      };
    };
    return {
      own: summarise(own),
      kd: summarise(kd),
      blended: summarise(blended),
      sample: summarise(samples),
      cellsOwnLed,
      cellsKdHeavy,
      cellsOwnOnly,
      cellsKdOnly,
      cellsNoSignal,
      cellsLegacyMissingWeights
    };
  })();
  const formatSeas = (v: number | null): string => (v === null ? "—" : v.toFixed(3));
  const formatSample = (v: number | null): string => (v === null ? "—" : Math.round(v).toString());

  // Top 10 cells by |delta| with attribution: which multiplier is at its
  // ceiling/floor (the strongest evidence of a binding constraint).
  const top10 = [...diagRows]
    .filter((r) => r.deltaPct !== null)
    .sort((a, b) => Math.abs(b.deltaPct ?? 0) - Math.abs(a.deltaPct ?? 0))
    .slice(0, 10);
  const attribute = (r: DiagRow): string => {
    const m = r.diag!.multipliers;
    const hits: string[] = [];
    if (m.demand.ceilingHit) hits.push(`demand ceiling (${m.demand.dominantSignal})`);
    if (m.demand.floorHit) hits.push("demand floor");
    if (m.seasonality.ceilingHit) hits.push("seasonality ceiling");
    if (m.seasonality.floorHit) hits.push("seasonality floor");
    if (m.dayOfWeek.ceilingHit) hits.push("DoW ceiling");
    if (m.dayOfWeek.floorHit) hits.push("DoW floor");
    if (m.leadTimeFloor.engaged) hits.push("lead-time floor engaged");
    return hits.length === 0 ? "no clamp binding" : hits.join(", ");
  };
  const listingIds = Array.from(new Set(top10.map((r) => r.listingId)));
  const listingNameRows =
    listingIds.length === 0
      ? []
      : await prisma.listing.findMany({
          where: { id: { in: listingIds } },
          select: { id: true, name: true }
        });
  const nameById = new Map(listingNameRows.map((l) => [l.id, l.name]));

  // Summary paragraph. Build as "preamble + fragments joined by commas"
  // so there's never a double-comma or trailing comma.
  const fragments: string[] = [];
  if (demandCeil > 0) fragments.push(`${demandCeil} (${PCT(pct(demandCeil))}) hit the demand ceiling`);
  if (demandFloor > 0) fragments.push(`${demandFloor} (${PCT(pct(demandFloor))}) hit the demand floor`);
  if (seasonalityCeil > 0) fragments.push(`${seasonalityCeil} (${PCT(pct(seasonalityCeil))}) hit the seasonality ceiling`);
  if (dowCeil > 0) fragments.push(`${dowCeil} (${PCT(pct(dowCeil))}) hit the day-of-week ceiling`);
  if (ltfEngaged > 0) fragments.push(`${ltfEngaged} (${PCT(pct(ltfEngaged))}) had the lead-time floor engaged`);
  const preamble = `Of ${totalCells} cells in the 31-90d trough today`;
  const summaryParagraph =
    fragments.length === 0
      ? `${preamble}, no clamps were binding — the trough is structural, not a clamping issue.`
      : `${preamble}, ${fragments.join(", ")}.`;

  // Events block — renders the Fleadh / events table (or empty section
  // if no event covers any trough cell). Surfaces per-cell event lift +
  // recommended vs PL before / after the event multiplier so Mark can
  // confirm no overshoot. New 2026-05-22 with the events lever wiring.
  const renderEventsBlock = (rows: DiagRow[]): string => {
    const eventCells = rows.filter((r) => {
      const ev = r.diag!.multipliers.events;
      return ev && typeof ev.adjPct === "number" && Number.isFinite(ev.adjPct);
    });
    if (eventCells.length === 0) {
      return `
    <h3 style="margin:16px 0 8px">Events lever — Fleadh / curated events</h3>
    <p style="color:#666;font-size:13px;margin:0 0 16px">No event covers any 31-90d trough cell today. (The Fleadh window is 2026-08-02 to 2026-08-09 — outside the 31-90d band on snapshots far from May.)</p>
  `;
    }
    // Sort by date so consecutive event-week cells appear together;
    // tie-break by listing for readability.
    eventCells.sort((a, b) => {
      if (a.targetIso !== b.targetIso) return a.targetIso < b.targetIso ? -1 : 1;
      return a.listingId < b.listingId ? -1 : 1;
    });
    // Aggregate stats. eventMult = 1 + adjPct/100.
    const deltas = eventCells.map((r) => r.deltaPct ?? 0);
    const meanDelta = deltas.reduce((s, v) => s + v, 0) / Math.max(1, deltas.length);
    const overshoot = eventCells.filter((r) => (r.deltaPct ?? 0) > 0.10).length;
    const undershoot = eventCells.filter((r) => (r.deltaPct ?? 0) < -0.10).length;
    const withinBand = eventCells.length - overshoot - undershoot;
    const minDate = eventCells[0].targetIso;
    const maxDate = eventCells[eventCells.length - 1].targetIso;
    // "Before-event" recommended rate = currentRate / eventMult; this is
    // a model-level reconstruction (the engine multiplied the base chain
    // by eventMult to land on currentRate). For each cell render
    // before/after so a reader can see the lift in £, not just %.
    const top10 = eventCells.slice().sort((a, b) => Math.abs(b.deltaPct ?? 0) - Math.abs(a.deltaPct ?? 0)).slice(0, 10);
    const listingIdsInEvents = Array.from(new Set(top10.map((r) => r.listingId)));
    return `
    <h3 style="margin:16px 0 8px">Events lever — Fleadh / curated events</h3>
    <p style="color:#444;font-size:13px;margin:0 0 8px"><strong>${eventCells.length} trough cells covered by an event</strong> (date range ${ESC(minDate)} → ${ESC(maxDate)}). Mean Δ vs PL on event cells: <strong>${SIGNED_PCT(meanDelta)}</strong>. Within ±10% of PL: ${withinBand} cells; overshoot (>+10%): ${overshoot}; undershoot (&lt;-10%): ${undershoot}.</p>
    <h4 style="margin:12px 0 6px;font-size:13px">Top 10 event cells by |Δ%| (after event applied)</h4>
    <table style="border-collapse:collapse;width:100%;font-size:12px">
      <tr><th align="left"  style="padding:4px;border-bottom:1px solid #ddd">Listing</th>
          <th align="left"  style="padding:4px;border-bottom:1px solid #ddd">Date</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Event +%</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Our (before event)</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Our (with event)</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd">PL</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Δ% after</th></tr>
      ${top10
        .map((r) => {
          const ev = r.diag!.multipliers.events!;
          const adjPct = ev.adjPct ?? 0;
          const mult = ev.multiplier;
          const beforeRate = mult > 0 ? r.ourRate / mult : r.ourRate;
          const deltaAfter = r.deltaPct ?? 0;
          const colour = deltaAfter > 0.10 || deltaAfter < -0.10 ? "#b91c1c" : "#1a8a3a";
          return `
      <tr>
        <td style="padding:4px;border-bottom:1px solid #f0f0f0">${ESC(nameById.get(r.listingId) ?? r.listingId)}</td>
        <td style="padding:4px;border-bottom:1px solid #f0f0f0">${ESC(r.targetIso)}</td>
        <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${adjPct > 0 ? "+" : ""}${adjPct.toFixed(0)}%</td>
        <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0;color:#666">${GBP(beforeRate)}</td>
        <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0;font-weight:600">${GBP(r.ourRate)}</td>
        <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${GBP(r.plRate)}</td>
        <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0;color:${colour};font-weight:600">${SIGNED_PCT(deltaAfter)}</td>
      </tr>`;
        })
        .join("")}
    </table>
  `;
    // listingIdsInEvents kept as a side-effect for the nameById lookup —
    // names are pre-loaded for the broader top10, which already includes
    // every trough listing.
    void listingIdsInEvents;
  };

  sections.push(`
    <h2 style="margin:32px 0 8px">31-90 day trough — what's binding</h2>
    <p style="color:#444;font-size:13px;margin:0 0 12px">${ESC(summaryParagraph)}</p>
    <table style="border-collapse:collapse;width:100%;margin-bottom:16px;font-size:12px">
      <tr><th align="left" style="padding:4px;border-bottom:1px solid #ddd">Multiplier</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Ceiling hit</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd">% of trough</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Floor hit</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd">% of trough</th></tr>
      <tr><td style="padding:4px;border-bottom:1px solid #f0f0f0">Demand</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${demandCeil}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${PCT(pct(demandCeil))}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${demandFloor}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${PCT(pct(demandFloor))}</td></tr>
      <tr><td style="padding:4px;border-bottom:1px solid #f0f0f0">Seasonality</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${seasonalityCeil}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${PCT(pct(seasonalityCeil))}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${seasonalityFloor}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${PCT(pct(seasonalityFloor))}</td></tr>
      <tr><td style="padding:4px;border-bottom:1px solid #f0f0f0">Day-of-week</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${dowCeil}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${PCT(pct(dowCeil))}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${dowFloor}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${PCT(pct(dowFloor))}</td></tr>
      <tr><td style="padding:4px;border-bottom:1px solid #f0f0f0">Lead-time floor engaged</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0" colspan="2">${ltfEngaged} (${PCT(pct(ltfEngaged))})</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0;color:#888" colspan="2">n/a</td></tr>
    </table>
    <p style="color:#666;font-size:12px;margin:0 0 4px"><strong>Demand ceiling breakdown by dominant signal</strong> — ${demandCeilByLY} cells hit ceiling via LY-same-week, ${demandCeilByTrail} cells via trailing-12mo. (Tells us whether the new pass-through is firing on event-driven dates or structurally hot markets.)</p>
    <h3 style="margin:16px 0 8px">Seasonality across trough cells (instrumentation)</h3>
    <p style="color:#444;font-size:12px;margin:0 0 8px">Why isn't seasonality lifting summer dates? Compare the own-history monthly index (portfolio-aggregated per tenant, 2026-05-21+), the KeyData-derived monthly index, and the blended result. If all three sit near 1.0, the underlying seasonality really is flat for the trough months. If own is non-flat but the blended value isn't, check the per-cell own/KD weights — a sample-gated blend uses 0.85/0.15 (own-led) when the month has ≥30 booked nights portfolio-wide and 0.40/0.60 (KD-heavy fallback) below the gate.</p>
    <p style="color:#444;font-size:12px;margin:0 0 8px"><strong>Blend mix across the trough:</strong> ${seasonalityStats.cellsOwnLed} cells on own-led 0.85/0.15 weights, ${seasonalityStats.cellsKdHeavy} on KD-heavy 0.40/0.60 fallback, ${seasonalityStats.cellsOwnOnly} on own-only (no KD), ${seasonalityStats.cellsKdOnly} on KD-only (no own), ${seasonalityStats.cellsNoSignal} with no signal either way${seasonalityStats.cellsLegacyMissingWeights > 0 ? `, ${seasonalityStats.cellsLegacyMissingWeights} legacy rows from a pre-2026-05-21 run (no weights field, expected on a transition-day report)` : ""}.</p>
    <table style="border-collapse:collapse;width:100%;margin-bottom:16px;font-size:12px">
      <tr><th align="left" style="padding:4px;border-bottom:1px solid #ddd">Source</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd">n with data</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd">mean</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd">min</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd">median</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd">max</th></tr>
      <tr><td style="padding:4px;border-bottom:1px solid #f0f0f0">Own monthly index (portfolio)</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${seasonalityStats.own.n}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${formatSeas(seasonalityStats.own.mean)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${formatSeas(seasonalityStats.own.min)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${formatSeas(seasonalityStats.own.p50)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${formatSeas(seasonalityStats.own.max)}</td></tr>
      <tr><td style="padding:4px;border-bottom:1px solid #f0f0f0">Own sample (booked nights / month)</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${seasonalityStats.sample.n}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${formatSample(seasonalityStats.sample.mean)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${formatSample(seasonalityStats.sample.min)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${formatSample(seasonalityStats.sample.p50)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${formatSample(seasonalityStats.sample.max)}</td></tr>
      <tr><td style="padding:4px;border-bottom:1px solid #f0f0f0">KeyData monthly index</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${seasonalityStats.kd.n}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${formatSeas(seasonalityStats.kd.mean)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${formatSeas(seasonalityStats.kd.min)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${formatSeas(seasonalityStats.kd.p50)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${formatSeas(seasonalityStats.kd.max)}</td></tr>
      <tr><td style="padding:4px;border-bottom:1px solid #f0f0f0">Blended (applied)</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${seasonalityStats.blended.n}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${formatSeas(seasonalityStats.blended.mean)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${formatSeas(seasonalityStats.blended.min)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${formatSeas(seasonalityStats.blended.p50)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${formatSeas(seasonalityStats.blended.max)}</td></tr>
    </table>
    ${renderEventsBlock(diagRows)}
    <h3 style="margin:16px 0 8px">Top 10 trough cells by |Δ%|</h3>
    <table style="border-collapse:collapse;width:100%;font-size:12px">
      <tr><th align="left" style="padding:4px;border-bottom:1px solid #ddd">Listing</th>
          <th align="left" style="padding:4px;border-bottom:1px solid #ddd">Date</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Days out</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Our</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd">PL</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Δ%</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Seas own</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Own n</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Seas KD</th>
          <th align="left"  style="padding:4px;border-bottom:1px solid #ddd">Weights (own/kd)</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Seas blend</th>
          <th align="center" style="padding:4px;border-bottom:1px solid #ddd">Clip</th>
          <th align="left"  style="padding:4px;border-bottom:1px solid #ddd">Binding clamp(s)</th></tr>
      ${top10
        .map((r) => {
          const s = r.diag!.multipliers.seasonality;
          // Pre-2026-05-21 snapshot rows lack the weights; render "—".
          const weights =
            typeof s.ownWeight === "number" && typeof s.marketWeight === "number"
              ? `${s.ownWeight.toFixed(2)}/${s.marketWeight.toFixed(2)}`
              : "—";
          const sampleCell = typeof s.ownSampleSize === "number" ? s.ownSampleSize : (s.ownSampleSize ?? null);
          const clipMark = s.ceilingHit ? "↑" : s.floorHit ? "↓" : "";
          return `
      <tr>
        <td style="padding:4px;border-bottom:1px solid #f0f0f0">${ESC(nameById.get(r.listingId) ?? r.listingId)}</td>
        <td style="padding:4px;border-bottom:1px solid #f0f0f0">${ESC(r.targetIso)}</td>
        <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${r.daysToCheckIn}d</td>
        <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${GBP(r.ourRate)}</td>
        <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${GBP(r.plRate)}</td>
        <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0;color:${(r.deltaPct ?? 0) > 0 ? "#1a8a3a" : "#b91c1c"};font-weight:600">${r.deltaPct === null ? "—" : SIGNED_PCT(r.deltaPct)}</td>
        <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${formatSeas(s.own)}</td>
        <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${formatSample(sampleCell)}</td>
        <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${formatSeas(s.kd)}</td>
        <td style="padding:4px;border-bottom:1px solid #f0f0f0">${weights}</td>
        <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${formatSeas(s.blended)}</td>
        <td align="center" style="padding:4px;border-bottom:1px solid #f0f0f0;color:${clipMark === "↑" ? "#b91c1c" : clipMark === "↓" ? "#b91c1c" : "#888"};font-weight:600">${clipMark || "—"}</td>
        <td style="padding:4px;border-bottom:1px solid #f0f0f0">${ESC(attribute(r))}</td>
      </tr>`;
        })
        .join("")}
    </table>
  `);
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
    /**
     * Per-tenant per-listing calibration data (KeyData trailing 12mo vs
     * our NightFact aggregates). When a tenant has no entry we skip the
     * calibration section for that tenant gracefully.
     */
    listingCalibrationByTenant?: Record<string, ListingCalibrationRow[]>;
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
  // Pre-occupancy agreement — owner's headline target. We weight per-tenant
  // by `preOccCellsRated` so a tenant with fewer rated cells doesn't drag
  // the average. Cells where the classifier produced no result (e.g. PL
  // had no live rate) are excluded from the denominator.
  const allPreOccRated = summaries.reduce((s, r) => s + r.preOccCellsRated, 0);
  const overallPreOcc5 =
    allPreOccRated > 0
      ? summaries.reduce((s, r) => s + r.preOccAgreementWithin5Pct * r.preOccCellsRated, 0) / allPreOccRated
      : 0;
  const overallPreOcc10 =
    allPreOccRated > 0
      ? summaries.reduce((s, r) => s + r.preOccAgreementWithin10Pct * r.preOccCellsRated, 0) / allPreOccRated
      : 0;
  // Color the headline based on owner's target: ≥90% green, 80-89% amber,
  // <80% red. Matches the trial-success threshold.
  const headlineColor = overallPreOcc10 >= 0.9 ? "#1a8a3a" : overallPreOcc10 >= 0.8 ? "#bf7f00" : "#b91c1c";

  const cappedDayNumber = Math.min(14, Math.max(1, options.trialDayNumber));
  const trialWindowLabel = options.trialWindow
    ? `Trial window ${ESC(options.trialWindow.start)} → ${ESC(options.trialWindow.end)}`
    : "Trial window unset";
  const allUnavailable = summaries.reduce((s, r) => s + (r.unavailableCellsExcluded ?? 0), 0);
  sections.push(`
    <h1 style="margin:0 0 4px">KeyData trial — Day ${cappedDayNumber} of 14</h1>
    <p style="color:#444;margin:0 0 4px;font-size:13px">${trialWindowLabel} · KeyData vs PriceLabs daily report.</p>
    <p style="color:#666;margin:0 0 16px;font-size:13px">Snapshot ${ESC(options.snapshotDate)} · ${summaries.length} tenant${summaries.length === 1 ? "" : "s"} · ${allListings} listings · ${allCells} listing-dates compared <strong>(available nights only)</strong>${allUnavailable > 0 ? ` · ${allUnavailable} blocked/unavailable cells excluded` : ""}</p>
    <div style="border:2px solid ${headlineColor};background:#fff;padding:14px 16px;margin:0 0 24px;border-radius:6px">
      <p style="margin:0 0 4px;color:#666;font-size:12px;text-transform:uppercase;letter-spacing:0.5px">Trial KPI — pre-occupancy agreement vs PriceLabs</p>
      <p style="margin:0 0 6px;font-size:24px;font-weight:700;color:${headlineColor}">${PCT(overallPreOcc10)} <span style="font-size:14px;font-weight:400;color:#666">within ±10%</span></p>
      <p style="margin:0 0 8px;color:#444;font-size:13px"><strong>${PCT(overallPreOcc5)}</strong> within ±5% (stretch). Target: <strong>≥ 90% within ±10%</strong> by Day 14 (2026-06-01). Measured on our recommendation stripped of the occupancy multiplier — the base level our model is trying to land near PL.</p>
      ${(() => {
        // Banded agreement distribution (2026-05-25). Aggregates the
        // per-tenant within10/15/20/25 + beyond25/beyond50 weighted by
        // preOccCellsRated. The ±10% headline above is the trial pass
        // mark; this distribution shows the SHAPE — how many cells are
        // reasonably close vs how many are genuinely broken.
        const totalRated = summaries.reduce((s, r) => s + r.preOccCellsRated, 0);
        if (totalRated === 0) return "";
        const w = (sel: (r: ComparisonRunSummary) => number) =>
          summaries.reduce((s, r) => s + sel(r) * r.preOccCellsRated, 0) / totalRated;
        const w10 = w((r) => r.preOccBands.within10);
        const w15 = w((r) => r.preOccBands.within15);
        const w20 = w((r) => r.preOccBands.within20);
        const w25 = w((r) => r.preOccBands.within25);
        const b25 = w((r) => r.preOccBands.beyond25);
        const b50 = w((r) => r.preOccBands.beyond50);
        return `
        <p style="margin:10px 0 4px;color:#666;font-size:12px"><strong>Full agreement distribution</strong> — the shape of the curve, not just the pass mark:</p>
        <table style="border-collapse:collapse;font-size:12px;width:100%;max-width:540px">
          <tr>
            <td style="padding:2px 12px 2px 0;color:#666">within ±10%</td>
            <td style="padding:2px 12px 2px 0;color:${w10 >= 0.90 ? "#1a8a3a" : w10 >= 0.80 ? "#bf7f00" : "#b91c1c"};font-weight:600;text-align:right">${PCT(w10)}</td>
            <td style="padding:2px 0;color:#888;font-size:11px">pass mark (≥ 90%)</td>
          </tr>
          <tr>
            <td style="padding:2px 12px 2px 0;color:#666">within ±15%</td>
            <td style="padding:2px 12px 2px 0;color:#444;font-weight:600;text-align:right">${PCT(w15)}</td>
            <td style="padding:2px 0;color:#888;font-size:11px">explainable margin</td>
          </tr>
          <tr>
            <td style="padding:2px 12px 2px 0;color:#666">within ±20%</td>
            <td style="padding:2px 12px 2px 0;color:#444;font-weight:600;text-align:right">${PCT(w20)}</td>
            <td style="padding:2px 0;color:#888;font-size:11px"></td>
          </tr>
          <tr>
            <td style="padding:2px 12px 2px 0;color:#666">within ±25%</td>
            <td style="padding:2px 12px 2px 0;color:#444;font-weight:600;text-align:right">${PCT(w25)}</td>
            <td style="padding:2px 0;color:#888;font-size:11px"></td>
          </tr>
          <tr>
            <td style="padding:2px 12px 2px 0;color:#666">beyond ±25%</td>
            <td style="padding:2px 12px 2px 0;color:${b25 > 0.10 ? "#bf7f00" : "#444"};font-weight:600;text-align:right">${PCT(b25)}</td>
            <td style="padding:2px 0;color:#888;font-size:11px">"off"</td>
          </tr>
          <tr>
            <td style="padding:2px 12px 2px 0;color:#666">beyond ±50%</td>
            <td style="padding:2px 12px 2px 0;color:${b50 > 0.05 ? "#b91c1c" : "#444"};font-weight:600;text-align:right">${PCT(b50)}</td>
            <td style="padding:2px 0;color:#888;font-size:11px">"genuinely broken"</td>
          </tr>
        </table>`;
      })()}
      <p style="margin:8px 0 4px;color:#666;font-size:12px"><strong>Mean signed delta vs PL per booking window</strong> (negative = we under PL; positive = we over):</p>
      <table style="border-collapse:collapse;font-size:12px">
        ${(() => {
          const bands = ["0-7d", "8-14d", "15-30d", "31-60d", "61-90d", "91-180d", "181-270d"] as const;
          // Aggregate weighted mean across tenants per band.
          const sums: Record<string, number> = {};
          const counts: Record<string, number> = {};
          for (const s of summaries) {
            for (const band of bands) {
              const cnt = s.preOccBandCounts[band] ?? 0;
              if (cnt === 0) continue;
              const mean = s.preOccMeanDeltaByBand[band] ?? 0;
              sums[band] = (sums[band] ?? 0) + mean * cnt;
              counts[band] = (counts[band] ?? 0) + cnt;
            }
          }
          return bands
            .map((band) => {
              const cnt = counts[band] ?? 0;
              const mean = cnt > 0 ? sums[band] / cnt : 0;
              const cellColor = Math.abs(mean) <= 0.1 ? "#1a8a3a" : Math.abs(mean) <= 0.2 ? "#bf7f00" : "#b91c1c";
              return `<tr>
                <td style="padding:2px 12px 2px 0;color:#666">${band}</td>
                <td style="padding:2px 12px 2px 0;color:${cellColor};font-weight:600;text-align:right">${cnt === 0 ? "—" : SIGNED_PCT(mean)}</td>
                <td style="padding:2px 0;color:#888;font-size:11px">${cnt === 0 ? "" : `n=${cnt}`}</td>
              </tr>`;
            })
            .join("");
        })()}
      </table>
    </div>
    <table style="border-collapse:collapse;width:100%;margin-bottom:24px">
      <tr><th align="left" style="padding:6px;border-bottom:1px solid #ddd">Tenant</th>
          <th align="right" style="padding:6px;border-bottom:1px solid #ddd">Listings</th>
          <th align="right" style="padding:6px;border-bottom:1px solid #ddd">Cells</th>
          <th align="right" style="padding:6px;border-bottom:1px solid #ddd;color:${headlineColor}">Pre-occ ±10%</th>
          <th align="right" style="padding:6px;border-bottom:1px solid #ddd">Pre-occ ±5%</th>
          <th align="right" style="padding:6px;border-bottom:1px solid #ddd">Final-rate agree</th>
          <th align="right" style="padding:6px;border-bottom:1px solid #ddd">Mean Δ</th>
          <th align="right" style="padding:6px;border-bottom:1px solid #ddd">Median |Δ|</th>
          <th align="right" style="padding:6px;border-bottom:1px solid #ddd">Big div.</th></tr>
      ${summaries
        .map(
          (s) => {
            const tenantPreOccColor = s.preOccAgreementWithin10Pct >= 0.9 ? "#1a8a3a" : s.preOccAgreementWithin10Pct >= 0.8 ? "#bf7f00" : "#b91c1c";
            return `
      <tr>
        <td style="padding:6px;border-bottom:1px solid #f0f0f0">${ESC(s.tenantName)}</td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${s.listingsProcessed}</td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${s.cellsCompared}</td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0;color:${tenantPreOccColor};font-weight:600">${PCT(s.preOccAgreementWithin10Pct)}</td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${PCT(s.preOccAgreementWithin5Pct)}</td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${PCT(s.agreement)}</td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${SIGNED_PCT(s.meanDeltaPct)}</td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${PCT(s.medianAbsDeltaPct)}</td>
        <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${s.largeDivergenceCount}</td>
      </tr>`;
          }
        )
        .join("")}
      <tr style="font-weight:600">
        <td style="padding:6px;border-top:2px solid #888">All</td>
        <td align="right" style="padding:6px;border-top:2px solid #888">${allListings}</td>
        <td align="right" style="padding:6px;border-top:2px solid #888">${allCells}</td>
        <td align="right" style="padding:6px;border-top:2px solid #888;color:${headlineColor}">${PCT(overallPreOcc10)}</td>
        <td align="right" style="padding:6px;border-top:2px solid #888">${PCT(overallPreOcc5)}</td>
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

  // Structural misses — cells (listing × target date) where pre-occ |Δ|
  // has been > 10% for 2+ consecutive snapshot dates. These are the
  // tuning targets: random one-day misses are noise; sustained misses
  // are model errors. Surfaced once across all tenants since each
  // listing only belongs to one tenant.
  await renderStructuralMissesSection(sections, summaries);
  await renderTroughDiagnosticSection(sections, summaries);

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
      <h3 style="margin:16px 0 8px">By window-out (pre-occupancy agreement is the trial KPI)</h3>
      <table style="border-collapse:collapse;width:100%;margin-bottom:16px">
        <tr><th align="left" style="padding:4px;border-bottom:1px solid #ddd">Band</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd">N</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd;color:#1a8a3a">Pre-occ ±10%</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Pre-occ ±5%</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Final agree</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Mean Δ</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Median |Δ|</th></tr>
        ${byBand
          .map(
            (b) => {
              const bandColor = b.preOccAgreement10 >= 0.9 ? "#1a8a3a" : b.preOccAgreement10 >= 0.8 ? "#bf7f00" : "#b91c1c";
              return `
        <tr>
          <td style="padding:4px;border-bottom:1px solid #f0f0f0">${ESC(b.band)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${b.total}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0;color:${bandColor};font-weight:600">${PCT(b.preOccAgreement10)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${PCT(b.preOccAgreement5)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${PCT(b.agreementPct)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${SIGNED_PCT(b.meanDelta)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${PCT(b.medianAbsDelta)}</td>
        </tr>`;
            }
          )
          .join("")}
      </table>

      <h3 style="margin:16px 0 8px">Banded agreement distribution by booking window (2026-05-25)</h3>
      <p style="color:#666;font-size:12px;margin:0 0 8px">Per-band shape — within X% bands are cumulative (within10 ≤ within15 ≤ within25). "Beyond ±50%" is the strictly-broken tail. Distinguishes cells off by an explainable margin from cells off because the engine is wrong.</p>
      <table style="border-collapse:collapse;width:100%;margin-bottom:16px;font-size:12px">
        <tr>
          <th align="left" style="padding:4px;border-bottom:1px solid #ddd">Band</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd">N</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd;color:#1a8a3a">±10%</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd">±15%</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd">±20%</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd">±25%</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd;color:#bf7f00">&gt; ±25%</th>
          <th align="right" style="padding:4px;border-bottom:1px solid #ddd;color:#b91c1c">&gt; ±50%</th>
        </tr>
        ${(() => {
          const bands = ["0-7d", "8-14d", "15-30d", "31-60d", "61-90d", "91-180d", "181-270d"] as const;
          return bands
            .map((band) => {
              const b = summary.preOccBandsByBookingWindow[band];
              if (!b || b.count === 0) {
                return `<tr><td style="padding:4px;border-bottom:1px solid #f0f0f0">${band}</td><td colspan="7" align="right" style="padding:4px;border-bottom:1px solid #f0f0f0;color:#999">—</td></tr>`;
              }
              const w10Color = b.within10 >= 0.9 ? "#1a8a3a" : b.within10 >= 0.8 ? "#bf7f00" : "#b91c1c";
              const b25Color = b.beyond25 > 0.10 ? "#bf7f00" : "#444";
              const b50Color = b.beyond50 > 0.05 ? "#b91c1c" : "#444";
              return `
        <tr>
          <td style="padding:4px;border-bottom:1px solid #f0f0f0">${band}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${b.count}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0;color:${w10Color};font-weight:600">${PCT(b.within10)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${PCT(b.within15)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${PCT(b.within20)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${PCT(b.within25)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0;color:${b25Color};font-weight:600">${PCT(b.beyond25)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0;color:${b50Color};font-weight:600">${PCT(b.beyond50)}</td>
        </tr>`;
            })
            .join("");
        })()}
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

    // Per-tenant calibration check (KeyData vs our NightFact trailing
    // 12mo aggregates). KeyData's ADR INCLUDES the cleaning fee; our
    // model + PL price the nightly rate EXCLUDING it. We strip an
    // estimated per-night cleaning fee from KD's ADR before computing
    // the delta so the comparison is apples-to-apples.
    const calibrationRows = options.listingCalibrationByTenant?.[summary.tenantId] ?? [];
    const calibrationCovered = calibrationRows.filter((r) => r.kdCoverage);
    if (calibrationCovered.length > 0) {
      const sorted = [...calibrationCovered].sort((a, b) => Math.abs(b.adrDeltaPct ?? 0) - Math.abs(a.adrDeltaPct ?? 0));
      const totalListings = calibrationRows.length;
      const coveredCount = calibrationCovered.length;
      const within10AdrCount = calibrationCovered.filter((r) => r.adrDeltaPct !== null && Math.abs(r.adrDeltaPct) <= 0.10).length;
      sections.push(`
      <h3 style="margin:16px 0 8px">KeyData scraped view vs our booked truth (informational — trailing 12 months)</h3>
      <p style="color:#666;font-size:12px;margin:0 0 8px"><strong>This is informational, not a calibration error.</strong> Our NightFact aggregates come direct from the Hostaway PMS (revenue we actually billed and got paid for, ownerstays + long stays + cleaning fees excluded). That's the booked truth. KeyData's OTA endpoints — what we have access to — are <em>scraped + inferred</em> data from public Airbnb pages, not confirmed PMS data (KD's confirmed-PMS feed is restricted to reporting partners only). So big deltas here typically point at KD's scraping noise (mis-matched listing IDs, calendar-availability inference, no visibility into VRBO / direct bookings), not at problems with our internal data. KeyData reports gross ADR (cleaning fee included), so we estimate per-night cleaning impact as <code>cleaningFee / kdAvgStayLength</code> and subtract it for an apples-to-apples view. Coverage: ${coveredCount}/${totalListings} listings tracked by KeyData. ${within10AdrCount}/${coveredCount} (${PCT(coveredCount > 0 ? within10AdrCount/coveredCount : 0)}) within ±10% after the cleaning-fee adjustment. ${totalListings - coveredCount === 0 ? "" : `<em>${totalListings - coveredCount} listing${totalListings - coveredCount === 1 ? "" : "s"} not tracked by KeyData — typically older Airbnb IDs.</em>`} ${sorted.some((r) => r.cleaningFeeSource === "portfolio_median") ? '<br><em>* Cleaning fee not set on Listing — falling back to portfolio median.</em>' : ""}</p>
      <table style="border-collapse:collapse;width:100%;font-size:12px;margin-bottom:16px">
        <tr><th align="left" style="padding:4px;border-bottom:1px solid #ddd">Listing</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Our ADR</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd">KD ADR (raw)</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd">KD clean/night</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd">KD ADR (excl. clean)</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd">ADR Δ% (adj.)</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Raw Δ%</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Our occ</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd">KD occ</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd">Occ Δpp</th>
            <th align="right" style="padding:4px;border-bottom:1px solid #ddd">KD m.</th></tr>
        ${sorted
          .map((r) => {
            const stayLenLabel = r.kdAvgStayLength === null ? "" : ` <span style="color:#888">(stay ${r.kdAvgStayLength.toFixed(1)}n)</span>`;
            // Annotate with * when we fell back to portfolio median.
            const cleaningSourceMark = r.cleaningFeeSource === "portfolio_median" ? "*" : "";
            const cleaningCellLabel =
              r.perNightCleaningFee === null
                ? "—"
                : `${GBP(r.perNightCleaningFee)}${cleaningSourceMark}${stayLenLabel}`;
            // No row-level red highlight here — a big delta against KD's
            // scraped data is informational only, not a sign that our
            // booked NightFact data is wrong.
            return `
        <tr>
          <td style="padding:4px;border-bottom:1px solid #f0f0f0">${ESC(r.listingName)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${r.ourAdr === null ? "—" : GBP(r.ourAdr)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0;color:#888">${r.kdAdrRaw === null ? "—" : GBP(r.kdAdrRaw)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0;color:#888">${cleaningCellLabel}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${r.kdAdrExclCleaning === null ? "—" : GBP(r.kdAdrExclCleaning)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0;color:#888">${r.adrDeltaPct === null ? "—" : SIGNED_PCT(r.adrDeltaPct)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0;color:#888">${r.adrDeltaPctRaw === null ? "—" : SIGNED_PCT(r.adrDeltaPctRaw)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${r.ourOccupancy === null ? "—" : PCT(r.ourOccupancy)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${r.kdOccupancy === null ? "—" : PCT(r.kdOccupancy)}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0">${r.occDeltaPp === null ? "—" : `${r.occDeltaPp >= 0 ? "+" : ""}${(r.occDeltaPp * 100).toFixed(1)}pp`}</td>
          <td align="right" style="padding:4px;border-bottom:1px solid #f0f0f0;color:#888">${r.kdSampleMonths}</td>
        </tr>`;
          })
          .join("")}
      </table>
    `);
    }
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
