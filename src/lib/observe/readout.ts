/**
 * The day-30 readout (SIGNALS-OBSERVE-LEARN-SPEC.md §8 + §9).
 *
 * Assembles a client's learned strategy (its `ClientProfile`) plus its first
 * gated suggestions into a structured JSON + an HTML summary. Internal only,
 * never client-facing, and NEVER contains a key. The pure builders here are used
 * by both the day-30 email runner and the key-gated routes.
 */

import { prisma } from "@/lib/prisma";

import { addUtcDays, fromDateOnly, toDateOnly } from "@/lib/metrics/helpers";

import type { ClientProfileDoc, ClientRule } from "./client-profile";
import { defaultClientKey } from "./config";
import { LEARNING_KEYS, type LearningKey } from "./learnings";
import {
  assembleCalibration,
  summariseScoredSuggestion,
  type CalibrationBucket,
  type CalibrationReport
} from "./suggestion-scoring";
import { readSuggestions } from "./suggestions";

/** A tenant with no completed observe run in this many hours gets a warning. */
export const ESTATE_STALE_RUN_HOURS = 48;

/** The calibration section covers the most recent N scored suggestions. */
export const CALIBRATION_MAX_SCORED = 200;

/** Method agreement compares flagged vs dropped nights over this stay-date window. */
export const AGREEMENT_WINDOW_DAYS = 90;
/** Price drops smaller than this (|changePct|) are skipped as RMS noise. */
export const AGREEMENT_MIN_DROP_PCT = 0.03;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** One estate row: a tenant's observe health, built from `tenants` (never from
 * `observation_windows` alone — an absent tenant must be VISIBLE, not missing). */
export type EstateTenantHealth = {
  tenantId: string;
  name: string;
  lastSuccessfulRunAt: string | null;
  daysObserved: number | null;
  status: string | null;
  /** Set when the tenant has no window at all or no completed run in 48h. */
  warning: string | null;
};

/** One starvation row: per learning, whole days since the last NON-null value
 * for this tenant (null = never produced a value). */
export type StarvationRow = {
  tenantId: string;
  name: string;
  daysSinceNonNull: Record<LearningKey, number | null>;
};

export type ReadoutData = {
  client: string;
  slug: string;
  engine: string | null;
  generatedAt: string;
  window: {
    startedAt: string | null;
    daysObserved: number;
    status: string;
    graduatedAt: string | null;
  } | null;
  profile: ClientProfileDoc | null;
  suggestions: {
    count: number;
    topRevenueAtRisk: number | null;
    /** Latest generation's safety-gate counts (trust metric); null before the first run. */
    blocked: { total: number; byReason: Record<string, number> } | null;
    rows: Array<Awaited<ReturnType<typeof readSuggestions>>[number] & { listingName: string | null }>;
  };
  /** Ghost-scoring calibration over the last N scored suggestions; null until
   * the weekly scorer has settled at least one night. */
  calibration: CalibrationReport | null;
  /** Method agreement (experimental): flagged vs actually-dropped nights. */
  methodAgreement: MethodAgreement;
  /** Estate-wide system health — every tenant, whether observed or not. */
  estate: {
    tenants: EstateTenantHealth[];
    starvation: StarvationRow[];
  };
};

/**
 * Assemble per-tenant estate health from the FULL tenant list plus their
 * observation windows. Pure. A tenant with no window (created after the last
 * worker boot, or never observed) gets an explicit warning — the 2026-07-03
 * failure was invisible precisely because the readout only showed tenants that
 * HAD windows.
 */
export function assembleEstateHealth(args: {
  tenants: Array<{ id: string; name: string }>;
  windows: Array<{ tenantId: string; lastRunAt: Date | null; daysObserved: number; status: string }>;
  now: Date;
}): EstateTenantHealth[] {
  const windowsByTenant = new Map<string, (typeof args.windows)[number]>();
  for (const w of args.windows) {
    const prev = windowsByTenant.get(w.tenantId);
    if (!prev || (w.lastRunAt?.getTime() ?? 0) > (prev.lastRunAt?.getTime() ?? 0)) {
      windowsByTenant.set(w.tenantId, w);
    }
  }

  return args.tenants.map((t) => {
    const w = windowsByTenant.get(t.id);
    if (!w) {
      return {
        tenantId: t.id,
        name: t.name,
        lastSuccessfulRunAt: null,
        daysObserved: null,
        status: null,
        warning: "no observation window — this tenant has never been observed"
      };
    }
    let warning: string | null = null;
    if (!w.lastRunAt) {
      warning = "no completed run yet";
    } else if (args.now.getTime() - w.lastRunAt.getTime() > ESTATE_STALE_RUN_HOURS * HOUR_MS) {
      warning = `no completed run in ${ESTATE_STALE_RUN_HOURS}h (last ${w.lastRunAt.toISOString()})`;
    }
    return {
      tenantId: t.id,
      name: t.name,
      lastSuccessfulRunAt: w.lastRunAt?.toISOString() ?? null,
      daysObserved: w.daysObserved,
      status: w.status,
      warning
    };
  });
}

/**
 * Assemble the starvation matrix — per tenant per learning (#1-#7), whole days
 * since the last NON-null ledger value; null means the learning has never
 * produced a value for that tenant. Pure.
 */
export function assembleStarvationMatrix(args: {
  tenants: Array<{ id: string; name: string }>;
  latestNonNull: Array<{ tenantId: string; learning: string; runAt: Date }>;
  now: Date;
}): StarvationRow[] {
  const latest = new Map<string, Date>();
  for (const row of args.latestNonNull) {
    const key = `${row.tenantId}|${row.learning}`;
    const prev = latest.get(key);
    if (!prev || row.runAt.getTime() > prev.getTime()) latest.set(key, row.runAt);
  }

  return args.tenants.map((t) => {
    const daysSinceNonNull = {} as Record<LearningKey, number | null>;
    for (const learning of LEARNING_KEYS) {
      const runAt = latest.get(`${t.id}|${learning}`);
      daysSinceNonNull[learning] = runAt
        ? Math.max(0, Math.floor((args.now.getTime() - runAt.getTime()) / DAY_MS))
        : null;
    }
    return { tenantId: t.id, name: t.name, daysSinceNonNull };
  });
}

/**
 * Method agreement (experimental): per client, over the trailing stay-date
 * window, how the system's flags line up with the price drops that actually
 * happened (Mark / the incumbent RMS). Attribution of WHO moved a price is not
 * solved — this is observational only, never a score.
 */
export type MethodAgreement = {
  windowDays: number;
  /** Nights where a >=3% price drop happened AND the system flagged the night. */
  droppedAndFlagged: number;
  /** Nights the system flagged but nobody dropped. */
  flaggedNotDropped: number;
  /** Nights somebody dropped but the system never flagged. */
  droppedNotFlagged: number;
};

/**
 * Assemble the agreement counts from night keys (`listingId|YYYY-MM-DD`).
 * Pure set arithmetic; duplicate keys collapse to one night.
 */
export function assembleMethodAgreement(args: {
  flaggedNights: Iterable<string>;
  droppedNights: Iterable<string>;
  windowDays: number;
}): MethodAgreement {
  const flagged = new Set(args.flaggedNights);
  const dropped = new Set(args.droppedNights);
  let droppedAndFlagged = 0;
  for (const night of dropped) if (flagged.has(night)) droppedAndFlagged += 1;
  return {
    windowDays: args.windowDays,
    droppedAndFlagged,
    flaggedNotDropped: flagged.size - droppedAndFlagged,
    droppedNotFlagged: dropped.size - droppedAndFlagged
  };
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Assemble the readout data for a client. Tenant-scoped, read-only, key-free. */
export async function buildReadout(args: {
  tenantId: string;
  clientKey?: string;
}): Promise<ReadoutData> {
  const clientKey = args.clientKey ?? defaultClientKey(args.tenantId);
  const now = new Date();
  // The estate queries are deliberately cross-tenant: this readout is the
  // internal system-state tool, and per-tenant health must come from the FULL
  // tenant table — a tenant missing from observation_windows is exactly the
  // failure it exists to show. Never client-facing.
  const today = fromDateOnly(toDateOnly(now));
  const agreementStart = addUtcDays(today, -AGREEMENT_WINDOW_DAYS);
  const [
    tenant,
    window,
    profileRow,
    rows,
    allTenants,
    allWindows,
    latestNonNullLedger,
    scoredCandidates,
    droppedNightRows,
    flaggedNightRows
  ] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: args.tenantId }, select: { name: true } }),
    prisma.observationWindow.findUnique({
      where: { tenantId_clientKey: { tenantId: args.tenantId, clientKey } },
      select: { startedAt: true, daysObserved: true, status: true, graduatedAt: true, lastSuggestionRun: true }
    }),
    prisma.clientProfile.findUnique({
      where: { tenantId_clientKey: { tenantId: args.tenantId, clientKey } },
      select: { profile: true }
    }),
    readSuggestions({ tenantId: args.tenantId, clientKey, status: "pending", limit: 50 }),
    prisma.tenant.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.observationWindow.findMany({
      select: { tenantId: true, lastRunAt: true, daysObserved: true, status: true }
    }),
    prisma.observeLearningLedger.groupBy({
      by: ["tenantId", "learning"],
      where: { nullReason: null },
      _max: { runAt: true }
    }),
    // Past-dated suggestions for the calibration section (scores live in
    // detail JSON, so the score filter happens in JS below). Tenant-scoped.
    prisma.suggestion.findMany({
      where: {
        tenantId: args.tenantId,
        clientKey,
        lever: "price",
        dateTo: { lt: today }
      },
      orderBy: { dateFrom: "desc" },
      take: CALIBRATION_MAX_SCORED * 3,
      select: { oldValue: true, proposedValue: true, dateFrom: true, createdAt: true, detail: true }
    }),
    // Method agreement (experimental): real price DROPS >= 3% (skipping RMS
    // noise) on settled stay dates, vs the nights the system flagged (any
    // machine status — pending/shadow/superseded — plus human-actioned ones).
    prisma.rateChange.findMany({
      where: {
        tenantId: args.tenantId,
        lever: "price",
        changePct: { lte: -AGREEMENT_MIN_DROP_PCT },
        date: { gte: agreementStart, lt: today }
      },
      select: { listingId: true, date: true }
    }),
    prisma.suggestion.findMany({
      where: {
        tenantId: args.tenantId,
        clientKey,
        lever: "price",
        listingId: { not: null },
        dateFrom: { gte: agreementStart, lt: today }
      },
      select: { listingId: true, dateFrom: true }
    })
  ]);

  const methodAgreement = assembleMethodAgreement({
    droppedNights: droppedNightRows.map((r) => `${r.listingId}|${toDateOnly(r.date)}`),
    flaggedNights: flaggedNightRows.map((r) => `${r.listingId}|${toDateOnly(r.dateFrom)}`),
    windowDays: AGREEMENT_WINDOW_DAYS
  });

  const calibration = assembleCalibration(
    scoredCandidates
      .map((r) =>
        summariseScoredSuggestion({
          oldValue: r.oldValue === null ? null : Number(r.oldValue),
          proposedValue: r.proposedValue === null ? null : Number(r.proposedValue),
          dateFrom: r.dateFrom,
          createdAt: r.createdAt,
          detail: r.detail
        })
      )
      .filter((s): s is NonNullable<typeof s> => s !== null)
      .slice(0, CALIBRATION_MAX_SCORED)
  );

  const profile = (profileRow?.profile as ClientProfileDoc | undefined) ?? null;

  // Join listing names so the readout table is readable (internal ids mean
  // nothing to a reviewer). Tenant-filtered per the multi-tenant rule.
  const listingIds = [...new Set(rows.map((r) => r.listingId).filter((id): id is string => typeof id === "string"))];
  const listings = listingIds.length
    ? await prisma.listing.findMany({
        where: { tenantId: args.tenantId, id: { in: listingIds } },
        select: { id: true, name: true }
      })
    : [];
  const nameByListingId = new Map(listings.map((l) => [l.id, l.name]));
  const namedRows = rows.map((r) => ({
    ...r,
    listingName: r.listingId ? (nameByListingId.get(r.listingId) ?? null) : null
  }));

  // Blocked-suggestion counts from the latest generation (persisted by
  // generateSuggestionsForClient on the observation window).
  let blocked: { total: number; byReason: Record<string, number> } | null = null;
  const lastRun = window?.lastSuggestionRun;
  if (lastRun && typeof lastRun === "object" && !Array.isArray(lastRun)) {
    const run = lastRun as { blocked?: unknown; blockedTotal?: unknown };
    const byReason: Record<string, number> = {};
    if (run.blocked && typeof run.blocked === "object" && !Array.isArray(run.blocked)) {
      for (const [reason, count] of Object.entries(run.blocked as Record<string, unknown>)) {
        if (typeof count === "number" && count > 0) byReason[reason] = count;
      }
    }
    blocked = {
      total: typeof run.blockedTotal === "number" ? run.blockedTotal : Object.values(byReason).reduce((s, n) => s + n, 0),
      byReason
    };
  }

  const estate = {
    tenants: assembleEstateHealth({ tenants: allTenants, windows: allWindows, now }),
    starvation: assembleStarvationMatrix({
      tenants: allTenants,
      latestNonNull: latestNonNullLedger
        .filter((r): r is typeof r & { _max: { runAt: Date } } => r._max.runAt !== null)
        .map((r) => ({ tenantId: r.tenantId, learning: r.learning, runAt: r._max.runAt })),
      now
    })
  };

  return {
    client: tenant?.name ?? args.tenantId,
    slug: clientKey,
    engine: profile?.engine ?? null,
    generatedAt: now.toISOString(),
    window: window
      ? {
          startedAt: window.startedAt.toISOString(),
          daysObserved: window.daysObserved,
          status: window.status,
          graduatedAt: window.graduatedAt?.toISOString() ?? null
        }
      : null,
    profile,
    suggestions: {
      count: namedRows.length,
      topRevenueAtRisk: namedRows[0]?.revenueAtRisk ?? null,
      blocked,
      rows: namedRows
    },
    calibration,
    methodAgreement,
    estate
  };
}

/**
 * Render one divergence rule with its evidence (`n` + window) when the rule
 * carries them — a rule without visible sample evidence reads as a fact. Pure.
 */
function renderRuleHtml(r: ClientRule): string {
  const params = r.params ?? {};
  const parts: string[] = [];
  if (typeof params.n === "number") parts.push(`n=${params.n}`);
  if (typeof params.windowDays === "number") parts.push(`window ${params.windowDays}d`);
  else if (typeof params.window === "string") parts.push(`window: ${escapeHtml(params.window)}`);
  const suffix = parts.length > 0 ? ` <span class="muted">(${parts.join(", ")})</span>` : "";
  return `<li>${escapeHtml(r.description)}${suffix}</li>`;
}

/**
 * Render the regret block: each figure as {value, n, window} with an explicit
 * "insufficient data" state — never a silent 0 or a pinned 100%. Pure.
 */
function renderRegretHtml(regret: ClientProfileDoc["regret"]): string {
  const heading = `<h3>Regret (settled nights only)</h3>`;
  if (!regret) {
    return `${heading}<p><em>Insufficient data — no settled nights in the window yet.</em></p>`;
  }
  // Defensive reads: profiles written before the settled-regret rewrite lack
  // the window/baseline fields until their next daily recompute.
  const pct = (v: number): string => `${(v * 100).toFixed(0)}%`;
  const windowLabel = typeof regret.windowDays === "number" ? `${regret.windowDays}d` : "unknown";
  const evidence = `n=${regret.total}, window ${windowLabel}`;
  const expectedLabel =
    typeof regret.expectedEmpties === "number" ? `~${regret.expectedEmpties.toFixed(0)} expected` : "no expectation";
  const high =
    `held too high (expired empty beyond the seasonal expectation): <b>${pct(regret.heldTooHighPct)}</b> ` +
    `<span class="muted">(${evidence}, baseline ${escapeHtml(regret.baselineSource ?? "unknown")}: ` +
    `${regret.emptyNights ?? "?"} empties vs ${expectedLabel})</span>`;
  const low =
    regret.heldTooLowPct === null
      ? `held too low: <b>insufficient data</b> <span class="muted">(no engine min data for this client — unmeasurable, not zero)</span>`
      : `held too low (sold at/below min unusually early): <b>${pct(regret.heldTooLowPct)}</b> <span class="muted">(${evidence})</span>`;
  return `${heading}<p>${high}<br>${low}</p>`;
}

/** Render the readout as a self-contained HTML summary. Pure. No keys. */
export function renderReadoutHtml(data: ReadoutData): string {
  const profile = data.profile;
  const rulesHtml = profile && profile.rules.length > 0
    ? `<ul>${profile.rules.map(renderRuleHtml).join("")}</ul>`
    : "<p><em>No divergence rules yet — this client tracks the global norm.</em></p>";

  const pricingPowerHtml = profile?.pricingPower
    ? `<ul>${Object.entries(profile.pricingPower)
        .map(([t, v]) => `<li>${escapeHtml(t)}: <b>${escapeHtml(v?.sensitivity)}</b> (occ ${(((v?.occupancy ?? 0) * 100)).toFixed(0)}%)</li>`)
        .join("")}</ul>`
    : "<p><em>n/a</em></p>";

  const suggestionRows = data.suggestions.rows
    .map(
      (s) =>
        `<tr><td>${escapeHtml(s.dateFrom)}</td><td>${escapeHtml(s.listingName ?? s.listingId ?? "")}</td>` +
        `<td>${escapeHtml(s.lever)} / ${escapeHtml(s.type)}</td>` +
        `<td>${s.oldValue ?? ""} → ${s.proposedValue ?? ""}</td>` +
        `<td>${s.revenueAtRisk?.toFixed(0) ?? ""}</td>` +
        `<td>${((s.confidence ?? 0) * 100).toFixed(0)}%</td>` +
        `<td>${escapeHtml(s.reason)}</td></tr>`
    )
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>Observe & Learn — Day-30 readout: ${escapeHtml(
    data.client
  )}</title>
<style>body{font:14px/1.5 -apple-system,system-ui,sans-serif;max-width:980px;margin:24px auto;padding:0 16px;color:#1a1a1a}
h1{font-size:20px}h2{font-size:16px;margin-top:24px;border-bottom:1px solid #eee;padding-bottom:4px}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #e3e3e3;padding:6px 8px;text-align:left}
th{background:#f7f7f7}.muted{color:#777}.warn{color:#b00020;font-weight:600}</style></head><body>
<h1>Observe &amp; Learn — Day-30 readout</h1>
<p><b>${escapeHtml(data.client)}</b> · engine <b>${escapeHtml(data.engine ?? "—")}</b> · status <b>${escapeHtml(
    data.window?.status ?? "—"
  )}</b> · day ${data.window?.daysObserved ?? "—"}/30 · generated ${escapeHtml(data.generatedAt)}</p>
<h2>Learned strategy (this client)</h2>
<p>Median lead time: <b>${profile?.leadTime?.medianLeadDays ?? "—"}</b> days · fee drag: <b>${
    profile?.feeDragPct !== null && profile?.feeDragPct !== undefined ? (profile.feeDragPct * 100).toFixed(1) + "%" : "—"
  }</b> · cancellation: <b>${escapeHtml(profile?.cancellationSignal ?? "—")}</b> · engine reaction: <b>${escapeHtml(
    profile?.engineReaction.dominant ?? (profile?.engineReaction.available ? "mixed" : "n/a")
  )}</b></p>
${renderRegretHtml(profile?.regret ?? null)}
<h3>Pricing power by date type</h3>${pricingPowerHtml}
<h3>Divergence rules</h3>${rulesHtml}
<h2>Gated suggestions — ordered by revenue at risk (${data.suggestions.count}, all pending)</h2>
<p class="muted">Nothing is applied. Each is judged against the expected booking curve for its lead time.</p>
${
    data.suggestions.blocked
      ? `<p>Blocked by safety gates: <b>${data.suggestions.blocked.total}</b>${
          Object.keys(data.suggestions.blocked.byReason).length > 0
            ? ` (${Object.entries(data.suggestions.blocked.byReason)
                .map(([reason, count]) => `${escapeHtml(reason)} ${count}`)
                .join(" · ")})`
            : ""
        }</p>`
      : ""
  }
${
    data.suggestions.count > 0
      ? `<table><thead><tr><th>Date</th><th>Listing</th><th>Lever/Type</th><th>Old → Proposed</th><th>Rev at risk</th><th>Conf.</th><th>Reason</th></tr></thead><tbody>${suggestionRows}</tbody></table>`
      : "<p><em>No suggestions — no forward nights are behind their booking curve.</em></p>"
  }
${renderCalibrationHtml(data.calibration)}
${renderMethodAgreementHtml(data.methodAgreement)}
${renderEstateHealthHtml(data.estate)}
</body></html>`;
}

/**
 * Render the method-agreement section. Explicitly labelled experimental and
 * observational — attribution of who moved a price is not solved, so these
 * counts describe overlap, not accuracy. Pure. No keys.
 */
function renderMethodAgreementHtml(agreement: MethodAgreement): string {
  const total = agreement.droppedAndFlagged + agreement.flaggedNotDropped + agreement.droppedNotFlagged;
  const body =
    total === 0
      ? `<p class="muted">No qualifying nights in the window — no price drops ≥ ${(AGREEMENT_MIN_DROP_PCT * 100).toFixed(0)}% and no flagged nights yet.</p>`
      : `<table><thead><tr><th>Overlap (last ${agreement.windowDays} days of stay dates)</th><th>Nights</th></tr></thead><tbody>
<tr><td>Dropped (Mark / RMS) AND flagged by the system</td><td>${agreement.droppedAndFlagged}</td></tr>
<tr><td>Flagged by the system, nobody dropped</td><td>${agreement.flaggedNotDropped}</td></tr>
<tr><td>Dropped, but the system never flagged</td><td>${agreement.droppedNotFlagged}</td></tr>
</tbody></table>`;
  return `<h2>Method agreement (experimental)</h2>
<p class="muted">Observational only: price drops ≥ ${(AGREEMENT_MIN_DROP_PCT * 100).toFixed(0)}% seen on the calendar vs nights the system flagged. WHO moved a price is not attributed, so overlap is not a hit rate.</p>
${body}`;
}

/**
 * Render the ghost-scoring calibration section: what actually happened to the
 * nights the system flagged. This is the graduation evidence — a reviewer sees
 * how often the method's drops were needed, not a leap of faith. Pure. No keys.
 */
function renderCalibrationHtml(calibration: CalibrationReport | null): string {
  const heading = `<h2>Calibration — what actually happened to flagged nights (ghost scoring)</h2>`;
  if (!calibration) {
    return `${heading}
<p class="muted">No scored suggestions yet. The weekly ghost scorer settles each flagged night ~2 days after its stay date; this section fills in as shadow history accrues.</p>`;
  }
  const pct = (v: number): string => `${(v * 100).toFixed(0)}%`;
  const bookedShare = calibration.scored > 0 ? calibration.booked / calibration.scored : 0;
  const avg = calibration.avgRealisedVsProposed;
  const headline =
    `Of <b>${calibration.scored}</b> nights the system would have dropped, ` +
    `<b>${calibration.booked}</b> (${pct(bookedShare)}) booked anyway with no drop applied` +
    (calibration.booked > 0 && calibration.bookedNoRateMove !== calibration.booked
      ? ` (${calibration.bookedNoRateMove} with no rate move by anyone)`
      : "") +
    (calibration.bookedHeavyPromo > 0
      ? ` (${calibration.bookedHeavyPromo} won by a heavy promo/discount for their channel — not full-rate wins)`
      : "") +
    (avg !== null ? `, at an average of <b>${pct(avg)}</b> of the price the system proposed dropping to` : "") +
    `. ${calibration.expiredEmpty} expired empty; ${calibration.cancelledAfterBooking} booked then cancelled.`;

  const bucketTable = (title: string, buckets: CalibrationBucket[]): string => {
    if (buckets.length === 0) return "";
    const rows = buckets
      .map(
        (b) =>
          `<tr><td>${escapeHtml(b.label)}</td><td>${b.n}</td>` +
          `<td>${b.booked} (${pct(b.bookedPct)})</td>` +
          `<td>${b.avgRealisedVsProposed !== null ? pct(b.avgRealisedVsProposed) : "—"}</td></tr>`
      )
      .join("");
    return `<h3>${escapeHtml(title)}</h3>
<table><thead><tr><th>Bucket</th><th>n</th><th>Booked anyway</th><th>Avg realised vs proposed</th></tr></thead><tbody>${rows}</tbody></table>`;
  };

  return `${heading}
<p>${headline}</p>
<p class="muted">"Booked anyway" = the night filled with no drop ever applied — evidence the drop was unnecessary. Realised vs proposed above 100% means it booked ABOVE the price the system would have cut to.</p>
${bucketTable("By suggested drop size", calibration.byDropSize)}
${bucketTable("By lead time at suggestion", calibration.byLeadTime)}`;
}

/** Learning-key column order + short labels for the starvation matrix. */
const LEARNING_LABELS: Record<LearningKey, string> = {
  pickup_velocity: "#1 pickup",
  lead_time: "#2 lead time",
  regret: "#3 regret",
  pricing_power: "#4 pricing power",
  engine_reaction: "#5 engine react",
  net_realised: "#6 net realised",
  cancellation: "#7 cancellation",
  promo_gap: "#8 promo gap"
};

/**
 * Render the estate-health section: every tenant's last successful run (with a
 * visible warning for absent/stale tenants) plus the learning-starvation
 * matrix (days since the last non-null value per learning). Pure. No keys.
 */
function renderEstateHealthHtml(estate: ReadoutData["estate"]): string {
  const healthRows = estate.tenants
    .map(
      (t) =>
        `<tr><td>${escapeHtml(t.name)}</td>` +
        `<td>${escapeHtml(t.lastSuccessfulRunAt ?? "never")}</td>` +
        `<td>${t.daysObserved ?? "—"}${t.status ? ` / ${escapeHtml(t.status)}` : ""}</td>` +
        `<td>${t.warning ? `<span class="warn">⚠ ${escapeHtml(t.warning)}</span>` : "ok"}</td></tr>`
    )
    .join("");

  const learningKeys = Object.keys(LEARNING_LABELS) as LearningKey[];
  const starvationHeader = learningKeys.map((k) => `<th>${escapeHtml(LEARNING_LABELS[k])}</th>`).join("");
  const starvationRows = estate.starvation
    .map((row) => {
      const cells = learningKeys
        .map((k) => {
          const days = row.daysSinceNonNull[k];
          if (days === null) return `<td class="warn">never</td>`;
          return days > 7 ? `<td class="warn">${days}d</td>` : `<td>${days}d</td>`;
        })
        .join("");
      return `<tr><td>${escapeHtml(row.name)}</td>${cells}</tr>`;
    })
    .join("");

  return `<h2>Estate health — every tenant, whether observed or not</h2>
<p class="muted">Built from the tenant table, not observation windows — a tenant the observe loop has lost is listed with a warning, not silently absent.</p>
<table><thead><tr><th>Tenant</th><th>Last successful run</th><th>Day/status</th><th>Health</th></tr></thead><tbody>${healthRows}</tbody></table>
<h3>Learning starvation — days since the last non-null value</h3>
<p class="muted">"never" = that learning has never produced a value for that client; red = starved (&gt;7 days or never). Reasons live in <code>observe_learning_ledger.null_reason</code>.</p>
<table><thead><tr><th>Tenant</th>${starvationHeader}</tr></thead><tbody>${starvationRows}</tbody></table>`;
}
