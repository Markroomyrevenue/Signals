/**
 * Mine the historical rate-change record for drop dose-response
 * (reviews/observe-learn-2026-07/BUILD-PROMPTS/05-mine-historical-drop-outcomes.md;
 * measurement design in 02-causal-stats.md §7).
 *
 * READ-ONLY analysis job: collapses `rate_changes` price drops (>= 3% — the RMS
 * noise floor) into episodes, settles each episode-night against
 * `night_facts` + `calendar_rates`, compares against within-listing matched
 * un-dropped nights, and writes a JSON + markdown report under
 * `observe-reports/`. It performs NO writes to any database — prod or local —
 * and changes no live behaviour. All pure logic lives in
 * `src/lib/observe/drop-outcomes.ts` (unit-tested).
 *
 * Usage:
 *   npx tsx scripts/mine-drop-outcomes.ts                # local dev DB (DATABASE_URL)
 *   npx tsx scripts/mine-drop-outcomes.ts --prod         # prod, SELECT-only (DATABASE_PUBLIC_URL)
 *   npx tsx scripts/mine-drop-outcomes.ts --cap 200      # episode cap per listing (default 400)
 *
 * Never prints a connection string. Prod mode requires DATABASE_PUBLIC_URL in
 * the environment and emits report files only.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { PrismaClient } from "@prisma/client";

import { ensureEnvLoaded } from "@/lib/load-env";
import { addUtcDays, fromDateOnly, toDateOnly } from "@/lib/metrics/helpers";
import {
  aggregateDropOutcomes,
  analyseListingDrops,
  collapseDropEpisodes,
  stratifiedSampleEpisodes,
  DROP_NOISE_FLOOR,
  FILL_WINDOW_DAYS,
  MATCH_WINDOW_DAYS,
  MIN_REAL_REVENUE,
  type DropEpisode,
  type DropOutcomeCell,
  type NightRecord,
  type TreatedNightOutcome
} from "@/lib/observe/drop-outcomes";

const OBSERVE_REPORTS_DIR = process.env.OBSERVE_REPORTS_DIR ?? path.join(process.cwd(), "observe-reports");
const DEFAULT_EPISODE_CAP_PER_LISTING = 400;
/** Below this many matched treated nights a cell is flagged, not trusted. */
const MIN_MATCHED_FOR_SIGNAL = 20;

type TenantResult = {
  tenant: string;
  episodesFound: number;
  episodesSampled: number;
  listingsWithDrops: number;
  treatedNightsSettled: number;
  skippedUnsettled: number;
  skippedUnknownTerminal: number;
  skippedRepeatDrop: number;
  skippedNoRecord: number;
  cells: DropOutcomeCell[];
};

function parseArgs(argv: string[]): { prod: boolean; cap: number } {
  const prod = argv.includes("--prod");
  const capIdx = argv.indexOf("--cap");
  const cap = capIdx !== -1 && argv[capIdx + 1] ? Number(argv[capIdx + 1]) : DEFAULT_EPISODE_CAP_PER_LISTING;
  if (!Number.isFinite(cap) || cap < 1) throw new Error(`Invalid --cap value`);
  return { prod, cap };
}

async function analyseTenant(
  db: PrismaClient,
  tenant: { id: string; name: string },
  today: string,
  cap: number
): Promise<{ result: TenantResult; treated: TreatedNightOutcome[] }> {
  // 1. Every qualifying drop row for the tenant (tenant-scoped, house rule).
  const dropRows = await db.rateChange.findMany({
    where: { tenantId: tenant.id, lever: "price", changePct: { lte: -DROP_NOISE_FLOOR } },
    select: {
      id: true,
      listingId: true,
      scanId: true,
      date: true,
      detectedAt: true,
      changePct: true,
      oldValue: true,
      newValue: true
    }
  });

  const episodes = collapseDropEpisodes(
    dropRows.map((r) => ({
      id: r.id,
      listingId: r.listingId,
      scanId: r.scanId,
      date: toDateOnly(r.date),
      detectedAt: r.detectedAt,
      changePct: Number(r.changePct),
      oldValue: r.oldValue === null ? null : Number(r.oldValue),
      newValue: r.newValue === null ? null : Number(r.newValue)
    }))
  );
  const sampled = stratifiedSampleEpisodes(episodes, cap);

  const base: TenantResult = {
    tenant: tenant.name,
    episodesFound: episodes.length,
    episodesSampled: sampled.length,
    listingsWithDrops: new Set(episodes.map((e) => e.listingId)).size,
    treatedNightsSettled: 0,
    skippedUnsettled: 0,
    skippedUnknownTerminal: 0,
    skippedRepeatDrop: 0,
    skippedNoRecord: 0,
    cells: []
  };
  if (sampled.length === 0) return { result: base, treated: [] };

  const listingIds = [...new Set(sampled.map((e) => e.listingId))];
  const minDropDate = dropRows.reduce(
    (min, r) => (toDateOnly(r.date) < min ? toDateOnly(r.date) : min),
    toDateOnly(dropRows[0].date)
  );
  const rangeStart = fromDateOnly(toDateOnly(addUtcDays(fromDateOnly(minDropDate), -MATCH_WINDOW_DAYS)));
  const todayDate = fromDateOnly(today);

  // 2. Outcome + control inputs, tenant-scoped (house rule on every query).
  const [facts, calendar, brcRows] = await Promise.all([
    db.nightFact.findMany({
      where: { tenantId: tenant.id, listingId: { in: listingIds }, date: { gte: rangeStart, lt: todayDate } },
      select: {
        listingId: true,
        date: true,
        isOccupied: true,
        status: true,
        revenueAllocated: true,
        bookingCreatedAt: true,
        leadTimeDays: true
      }
    }),
    db.calendarRate.findMany({
      where: { tenantId: tenant.id, listingId: { in: listingIds }, date: { gte: rangeStart, lt: todayDate } },
      select: { listingId: true, date: true, available: true }
    }),
    db.bookingRateContext.findMany({
      where: { tenantId: tenant.id, listingId: { in: listingIds }, stayDate: { lt: todayDate } },
      select: { listingId: true, stayDate: true, rateChangeId: true }
    })
  ]);

  // Dates hit by ANY qualifying drop are never controls.
  const droppedDates = new Map<string, Set<string>>();
  for (const r of dropRows) {
    const set = droppedDates.get(r.listingId) ?? new Set<string>();
    set.add(toDateOnly(r.date));
    droppedDates.set(r.listingId, set);
  }

  // 3. Per-listing night records.
  const nightsByListing = new Map<string, Map<string, NightRecord>>();
  const nightFor = (listingId: string, date: string): NightRecord => {
    let nights = nightsByListing.get(listingId);
    if (!nights) {
      nights = new Map();
      nightsByListing.set(listingId, nights);
    }
    let night = nights.get(date);
    if (!night) {
      night = {
        date,
        occupiedBookings: [],
        cancelledBookings: [],
        openAtEnd: false,
        dropped: droppedDates.get(listingId)?.has(date) ?? false
      };
      nights.set(date, night);
    }
    return night;
  };
  for (const f of facts) {
    const night = nightFor(f.listingId, toDateOnly(f.date));
    const revenue = Number(f.revenueAllocated);
    if (f.status === "cancelled") {
      night.cancelledBookings.push({ bookingCreatedAt: f.bookingCreatedAt, leadTimeDays: f.leadTimeDays });
    } else if (f.isOccupied && f.status !== "ownerstay" && revenue > MIN_REAL_REVENUE) {
      night.occupiedBookings.push({ bookingCreatedAt: f.bookingCreatedAt, leadTimeDays: f.leadTimeDays, revenue });
    }
  }
  for (const c of calendar) {
    if (c.available) nightFor(c.listingId, toDateOnly(c.date)).openAtEnd = true;
  }
  const brcByListing = new Map<string, Map<string, Set<string>>>();
  for (const b of brcRows) {
    if (!b.rateChangeId) continue;
    const perDate = brcByListing.get(b.listingId) ?? new Map<string, Set<string>>();
    const key = toDateOnly(b.stayDate);
    const set = perDate.get(key) ?? new Set<string>();
    set.add(b.rateChangeId);
    perDate.set(key, set);
    brcByListing.set(b.listingId, perDate);
  }

  // 4. Analyse per listing (all pure from here).
  const episodesByListing = new Map<string, DropEpisode[]>();
  for (const ep of sampled) {
    const list = episodesByListing.get(ep.listingId) ?? [];
    list.push(ep);
    episodesByListing.set(ep.listingId, list);
  }
  const treated: TreatedNightOutcome[] = [];
  for (const [listingId, listingEpisodes] of episodesByListing) {
    const analysis = analyseListingDrops({
      listingId,
      episodes: listingEpisodes,
      nights: nightsByListing.get(listingId) ?? new Map(),
      brcChangeIdsByDate: brcByListing.get(listingId),
      today
    });
    treated.push(...analysis.treated);
    base.skippedUnsettled += analysis.skippedUnsettled;
    base.skippedUnknownTerminal += analysis.skippedUnknownTerminal;
    base.skippedRepeatDrop += analysis.skippedRepeatDrop;
    base.skippedNoRecord += analysis.skippedNoRecord;
  }
  base.treatedNightsSettled = treated.length;
  base.cells = aggregateDropOutcomes(treated);
  return { result: base, treated };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function pct(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function num(value: number | null, digits = 1): string {
  return value === null ? "—" : value.toFixed(digits);
}

function cellRows(cells: DropOutcomeCell[]): string[] {
  const rows: string[] = [];
  for (const c of cells) {
    const note = c.matchedTreatedNights < MIN_MATCHED_FOR_SIGNAL ? "insufficient matched controls" : "";
    rows.push(
      `| ${c.leadBucket} | ${c.dropBand} | ${c.dateType} | ${c.episodes} | ${c.treatedNights} | ${pct(c.treatedFillRate)} | ` +
        `${pct(c.controlFillRate)} (n=${c.matchedTreatedNights}/${c.controlNights}) | ${num(c.fillDeltaPp)} | ` +
        `${pct(c.realisedPctOfPreDrop.mean)} (n=${c.realisedPctOfPreDrop.n}) | ` +
        `${num(c.realisedRateRatio.mean, 2)} (n=${c.realisedRateRatio.n}) | ` +
        `${pct(c.cancellationRate.value)} (n=${c.cancellationRate.n}) | ${num(c.meanDaysToBook)} | ${note} |`
    );
  }
  return rows;
}

function renderMarkdown(args: {
  env: string;
  generatedAt: string;
  today: string;
  cap: number;
  tenants: TenantResult[];
  pooled: DropOutcomeCell[];
  pooledTreatedNights: number;
}): string {
  const lines: string[] = [];
  lines.push(`# Drop dose-response — retrospective mining of the rate-change record`);
  lines.push("");
  lines.push(
    `Generated ${args.generatedAt} against the **${args.env}** database (read-only). Settled nights only ` +
      `(stay date before ${args.today}). Noise floor ${DROP_NOISE_FLOOR * 100}%; fill window ${FILL_WINDOW_DAYS} days ` +
      `after detection; controls matched within ±${MATCH_WINDOW_DAYS} days, same listing, same day-of-week, still ` +
      `unbooked at the treated lead; episode cap ${args.cap}/listing (stratified across full history).`
  );
  lines.push("");
  lines.push(`## Read this first — caveats that bound every number below`);
  lines.push("");
  lines.push(
    `- **Observational, not causal.** Nobody randomised these drops. Every comparison inherits the decision rule ` +
      `that produced the drop.`
  );
  lines.push(
    `- **Selection on weakness.** Drops happen to nights that look weak (empty, behind pace). Matched controls of ` +
      `the same listing were, by construction, nights the engine/host chose NOT to cut — typically stronger. ` +
      `Uncorrected deltas are therefore biased AGAINST drops: a true drop benefit will look smaller than it is, ` +
      `and a negative delta does not prove drops hurt.`
  );
  lines.push(
    `- **Matching limits.** Same listing + day-of-week + ±${MATCH_WINDOW_DAYS}d + still-unbooked-at-lead kills ` +
      `between-listing selection and coarse seasonality only. It does not control within-listing time-varying ` +
      `demand (an event week vs a dead week three weeks apart), repeat cuts landing inside the 14-day window ` +
      `(dose contamination — repeat-dropped stay dates are attributed to their FIRST episode), multi-unit ` +
      `part-availability, or cancelled-then-rebooked control eligibility edge cases.`
  );
  lines.push(
    `- **Terminal state proxy.** An empty night counts only when the calendar visibly showed it still open ` +
      `(available) at last observation; nights that ended blocked or unobserved are excluded, not counted empty.`
  );
  lines.push(
    `- **Denominator mismatch.** "Realised % of pre-drop rate" divides realised net revenue per night ` +
      `(revenue_allocated) by the advertised pre-drop rate — channel fees and discounts sit in the numerator ` +
      `only, so the level is deflated; compare cells against each other, not against 100%.`
  );
  lines.push(
    `- **History depth.** The scanner has been recording since 2026-06-02; settled treated nights are ` +
      `short-lead by construction (a June drop for a December stay has not settled). Long-lead cells will stay ` +
      `thin until the record ages.`
  );
  lines.push("");

  const header =
    `| Lead (d) | Drop size | Date type | Episodes | Treated n | Treated fill 14d | Control fill 14d (matched/controls) | Δ fill pp | ` +
    `Realised % of pre-drop | Rate ratio vs controls | Cancel rate | Mean days to book | Note |`;
  const divider = `|---|---|---|---|---|---|---|---|---|---|---|---|---|`;

  lines.push(`## All clients pooled (${args.pooledTreatedNights} treated settled nights)`);
  lines.push("");
  lines.push(header);
  lines.push(divider);
  lines.push(...cellRows(args.pooled));
  lines.push("");

  for (const t of args.tenants) {
    lines.push(`## ${t.tenant}`);
    lines.push("");
    lines.push(
      `Episodes found: ${t.episodesFound} (sampled ${t.episodesSampled}) across ${t.listingsWithDrops} listings. ` +
        `Treated settled nights: ${t.treatedNightsSettled} (skipped — not yet settled: ${t.skippedUnsettled}, ` +
        `terminal state unknown/blocked: ${t.skippedUnknownTerminal}, repeat drops on an already-treated night: ` +
        `${t.skippedRepeatDrop}, no night record: ${t.skippedNoRecord}).`
    );
    lines.push("");
    if (t.cells.length === 0) {
      lines.push(`No settled treated nights yet — nothing to tabulate.`);
    } else {
      lines.push(header);
      lines.push(divider);
      lines.push(...cellRows(t.cells));
    }
    lines.push("");
  }
  lines.push(
    `_Cells with fewer than ${MIN_MATCHED_FOR_SIGNAL} matched treated nights are marked "insufficient matched ` +
      `controls" — read them as anecdotes, not signal. Produced by \`scripts/mine-drop-outcomes.ts\`; pure logic in ` +
      `\`src/lib/observe/drop-outcomes.ts\`._`
  );
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  ensureEnvLoaded();
  const { prod, cap } = parseArgs(process.argv.slice(2));
  const envName = prod ? "prod" : "local";
  const url = prod ? process.env.DATABASE_PUBLIC_URL : process.env.DATABASE_URL;
  if (!url) {
    throw new Error(prod ? "DATABASE_PUBLIC_URL is not set (prod read-only access)" : "DATABASE_URL is not set");
  }
  // SELECT-only by construction: this client is used exclusively for findMany.
  const db = new PrismaClient({ datasources: { db: { url } } });
  const today = toDateOnly(new Date());
  const generatedAt = new Date().toISOString();

  try {
    const tenants = await db.tenant.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } });
    const results: TenantResult[] = [];
    const pooledTreated: TreatedNightOutcome[] = [];
    for (const tenant of tenants) {
      const { result, treated } = await analyseTenant(db, tenant, today, cap);
      results.push(result);
      pooledTreated.push(...treated);
      console.log(
        `[drop-outcomes] ${tenant.name}: episodes=${result.episodesFound} sampled=${result.episodesSampled} ` +
          `treatedSettled=${result.treatedNightsSettled} unknownTerminal=${result.skippedUnknownTerminal}`
      );
    }
    const pooled = aggregateDropOutcomes(pooledTreated);

    await mkdir(OBSERVE_REPORTS_DIR, { recursive: true });
    const stem = path.join(OBSERVE_REPORTS_DIR, `drop-outcomes-${envName}-${today}`);
    const json = {
      generatedAt,
      env: envName,
      today,
      params: {
        noiseFloor: DROP_NOISE_FLOOR,
        fillWindowDays: FILL_WINDOW_DAYS,
        matchWindowDays: MATCH_WINDOW_DAYS,
        minRealRevenue: MIN_REAL_REVENUE,
        episodeCapPerListing: cap,
        minMatchedForSignal: MIN_MATCHED_FOR_SIGNAL
      },
      tenants: results,
      pooled: { treatedNights: pooledTreated.length, cells: pooled }
    };
    await writeFile(`${stem}.json`, JSON.stringify(json, null, 2), "utf8");
    await writeFile(
      `${stem}.md`,
      renderMarkdown({
        env: envName,
        generatedAt,
        today,
        cap,
        tenants: results,
        pooled,
        pooledTreatedNights: pooledTreated.length
      }),
      "utf8"
    );
    console.log(`[drop-outcomes] wrote ${stem}.json and ${stem}.md`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(`[drop-outcomes] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
