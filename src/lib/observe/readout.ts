/**
 * The day-30 readout (SIGNALS-OBSERVE-LEARN-SPEC.md §8 + §9).
 *
 * Assembles a client's learned strategy (its `ClientProfile`) plus its first
 * gated suggestions into a structured JSON + an HTML summary. Internal only,
 * never client-facing, and NEVER contains a key. The pure builders here are used
 * by both the day-30 email runner and the key-gated routes.
 */

import { prisma } from "@/lib/prisma";

import type { ClientProfileDoc } from "./client-profile";
import { defaultClientKey } from "./config";
import { readSuggestions } from "./suggestions";

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
    rows: Awaited<ReturnType<typeof readSuggestions>>;
  };
};

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
  const [tenant, window, profileRow, rows] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: args.tenantId }, select: { name: true } }),
    prisma.observationWindow.findUnique({
      where: { tenantId_clientKey: { tenantId: args.tenantId, clientKey } },
      select: { startedAt: true, daysObserved: true, status: true, graduatedAt: true, lastSuggestionRun: true }
    }),
    prisma.clientProfile.findUnique({
      where: { tenantId_clientKey: { tenantId: args.tenantId, clientKey } },
      select: { profile: true }
    }),
    readSuggestions({ tenantId: args.tenantId, clientKey, status: "pending", limit: 50 })
  ]);

  const profile = (profileRow?.profile as ClientProfileDoc | undefined) ?? null;

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

  return {
    client: tenant?.name ?? args.tenantId,
    slug: clientKey,
    engine: profile?.engine ?? null,
    generatedAt: new Date().toISOString(),
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
      count: rows.length,
      topRevenueAtRisk: rows[0]?.revenueAtRisk ?? null,
      blocked,
      rows
    }
  };
}

/** Render the readout as a self-contained HTML summary. Pure. No keys. */
export function renderReadoutHtml(data: ReadoutData): string {
  const rule = (r: { description: string }): string => `<li>${escapeHtml(r.description)}</li>`;
  const profile = data.profile;
  const rulesHtml = profile && profile.rules.length > 0
    ? `<ul>${profile.rules.map(rule).join("")}</ul>`
    : "<p><em>No divergence rules yet — this client tracks the global norm.</em></p>";

  const pricingPowerHtml = profile?.pricingPower
    ? `<ul>${Object.entries(profile.pricingPower)
        .map(([t, v]) => `<li>${escapeHtml(t)}: <b>${escapeHtml(v?.sensitivity)}</b> (occ ${(((v?.occupancy ?? 0) * 100)).toFixed(0)}%)</li>`)
        .join("")}</ul>`
    : "<p><em>n/a</em></p>";

  const suggestionRows = data.suggestions.rows
    .map(
      (s) =>
        `<tr><td>${escapeHtml(s.dateFrom)}</td><td>${escapeHtml(s.listingId ?? "")}</td>` +
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
th{background:#f7f7f7}.muted{color:#777}</style></head><body>
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
</body></html>`;
}
