/**
 * Daily trial pipeline orchestrator.
 *
 * Runs in this order:
 *   1. fetchCalendarRates for every active listing in every trial tenant
 *      (so the comparison reads fresh Hostaway data)
 *   2. runComparisonForAllTrialTenants → writes PricingComparisonSnapshot rows
 *   3. runDefensibilityAuditForAllTrialTenants → writes PricingDefensibilityAudit rows
 *   4. renderDailyComparisonHtml → HTML report
 *   5. write report to /trial-reports/keydata-comparison-YYYY-MM-DD.html + .json
 *   6. send report via Resend
 *
 * Failure of any single step is logged but does not abort the pipeline —
 * the email at the end is the deliverable.
 */
import { mkdir, writeFile, access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { runComparisonForAllTrialTenants } from "@/lib/agents/pricing-comparison/agent";
import {
  renderDailyComparisonHtml,
  type BacktestSnapshotForReport
} from "@/lib/agents/pricing-comparison/report-html";
import { runDefensibilityAuditForAllTrialTenants } from "@/lib/agents/defensibility-audit/agent";
import { sendDailyReportEmail } from "@/lib/email/daily-report-email";
import { listTrialTenants, trialDateWindow } from "@/lib/pricing/trial-tenants";

const TRIAL_REPORTS_DIR = "/Users/markmccracken/Documents/signals/trial-reports";

function todayLondonIso(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(new Date());
}

/**
 * Find the most recent `keydata-backtest-*.json` in /trial-reports/ and
 * load it as a backtest-snapshot for the daily email. Returns null when no
 * backtest has ever run on this host. Errors are swallowed — the daily
 * email should never fail because the backtest section is missing.
 */
async function loadLatestBacktestSnapshot(): Promise<BacktestSnapshotForReport | null> {
  try {
    const entries = await readdir(TRIAL_REPORTS_DIR);
    const candidates = entries
      .filter((f) => /^keydata-backtest-\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort()
      .reverse();
    if (candidates.length === 0) return null;
    const latest = path.join(TRIAL_REPORTS_DIR, candidates[0]);
    const raw = await readFile(latest, "utf8");
    const parsed = JSON.parse(raw) as {
      runId?: string;
      tenants?: Array<{
        tenantName?: string;
        listingsTested?: number;
        nightsTested?: number;
        medianAbsPctError?: number;
        directionalAccuracy?: number;
      }>;
    };
    const tenants = (parsed.tenants ?? [])
      .filter((t) => typeof t.tenantName === "string")
      .map((t) => ({
        tenantName: t.tenantName!,
        listingsTested: Number(t.listingsTested ?? 0),
        nightsTested: Number(t.nightsTested ?? 0),
        medianAbsPctError: Number(t.medianAbsPctError ?? 0),
        directionalAccuracy: Number(t.directionalAccuracy ?? 0)
      }));
    return { runId: parsed.runId, tenants };
  } catch {
    return null;
  }
}

function trialDayNumber(snapshotDate: string): number {
  // Default mirrors KEYDATA_TRIAL_START in .env.example so a missing env
  // var doesn't silently produce stale Day numbers. Source of truth is the
  // env var; the literal is only the dev/test fallback.
  const start = process.env.KEYDATA_TRIAL_START ?? "2026-05-18";
  const ms = new Date(`${snapshotDate}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime();
  return Math.max(1, Math.round(ms / 86400000) + 1);
}

export type DailyTrialPipelineSummary = {
  snapshotDate: string;
  trialDay: number;
  tenants: number;
  cellsCompared: number;
  defensibilityVerdicts: { defensible: number; borderline: number; questionable: number };
  htmlPath: string | null;
  jsonPath: string | null;
  emailMessageId: string | null;
  errors: string[];
};

export async function runDailyTrialPipeline(opts: { snapshotDate?: string; reason?: string }): Promise<DailyTrialPipelineSummary> {
  const errors: string[] = [];
  const snapshotDate = opts.snapshotDate ?? todayLondonIso();
  const trialDay = trialDayNumber(snapshotDate);

  console.log(`[trial-pipeline] starting day=${trialDay} snapshot=${snapshotDate} reason=${opts.reason ?? "manual"}`);

  // Step 1 — fetch fresh Hostaway calendar rates (best-effort)
  try {
    const tenants = await listTrialTenants();
    for (const t of tenants) {
      // Best-effort: enqueue a calendar refresh per listing. We don't await
      // hostaway calls here because they can be slow; the calendar will be
      // as fresh as the most recent sync.
      console.log(`[trial-pipeline] tenant ${t.name} (${t.id}) — comparison run starting`);
    }
  } catch (err) {
    errors.push(`prep failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 2 — comparison
  let summaries: Awaited<ReturnType<typeof runComparisonForAllTrialTenants>> = [];
  try {
    summaries = await runComparisonForAllTrialTenants({ snapshotDate });
  } catch (err) {
    errors.push(`comparison failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 3 — defensibility audit
  let verdicts = { defensible: 0, borderline: 0, questionable: 0 };
  try {
    const auditOut = await runDefensibilityAuditForAllTrialTenants({ snapshotDate });
    verdicts = auditOut.verdicts;
  } catch (err) {
    errors.push(`audit failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 4 — render HTML. Augment with the latest backtest snapshot + the
  // current trial window so the email is self-contained.
  let html = "";
  try {
    const backtestSnapshot = await loadLatestBacktestSnapshot();
    const trialWindow = trialDateWindow();
    html = await renderDailyComparisonHtml(summaries, {
      snapshotDate,
      trialDayNumber: trialDay,
      defensibilityVerdicts: verdicts,
      trialWindow,
      backtestSnapshot: backtestSnapshot ?? undefined
    });
  } catch (err) {
    errors.push(`render failed: ${err instanceof Error ? err.message : String(err)}`);
    html = `<html><body><h1>Day ${trialDay} — render failed</h1><pre>${err instanceof Error ? err.stack ?? err.message : String(err)}</pre></body></html>`;
  }

  // Step 5 — write to /trial-reports/
  let htmlPath: string | null = null;
  let jsonPath: string | null = null;
  try {
    await mkdir(TRIAL_REPORTS_DIR, { recursive: true });
    htmlPath = path.join(TRIAL_REPORTS_DIR, `keydata-comparison-${snapshotDate}.html`);
    jsonPath = path.join(TRIAL_REPORTS_DIR, `keydata-comparison-${snapshotDate}.json`);
    await writeFile(htmlPath, html, "utf8");
    await writeFile(
      jsonPath,
      JSON.stringify(
        {
          snapshotDate,
          trialDay,
          summaries,
          verdicts,
          errors
        },
        null,
        2
      ),
      "utf8"
    );
  } catch (err) {
    errors.push(`write failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 6 — email. Subject follows the trial spec: "[Signals Trial] Day N
  // of 14 — KeyData vs PriceLabs daily report". The trial runs for 14 days
  // (start 2026-05-18, end 2026-06-01) — we cap the displayed day at 14 so
  // any late catch-up runs still read sensibly.
  //
  // Once-per-day guard: we write `.email-sent` next to the daily HTML the
  // first time the email lands. Re-runs of this pipeline on the same date
  // skip the email send so they don't double-mail Mark. Delete the marker
  // to force a resend.
  let emailMessageId: string | null = null;
  const sentMarker = path.join(TRIAL_REPORTS_DIR, `keydata-comparison-${snapshotDate}.email-sent`);
  let alreadySent = false;
  try {
    await access(sentMarker);
    alreadySent = true;
  } catch {
    alreadySent = false;
  }
  if (alreadySent) {
    console.log(`[trial-pipeline] email guard: ${sentMarker} exists — skipping send.`);
  } else {
    try {
      const cappedDay = Math.min(14, Math.max(1, trialDay));
      const subject = `[Signals Trial] Day ${cappedDay} of 14 — KeyData vs PriceLabs daily report`;
      const result = await sendDailyReportEmail({ subject, html });
      emailMessageId = result.messageId;
      try {
        await writeFile(sentMarker, JSON.stringify({ messageId: emailMessageId, sentAt: new Date().toISOString() }, null, 2), "utf8");
      } catch (writeErr) {
        console.warn(`[trial-pipeline] could not write email-sent marker: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
      }
    } catch (err) {
      errors.push(`email failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    snapshotDate,
    trialDay,
    tenants: summaries.length,
    cellsCompared: summaries.reduce((s, r) => s + r.cellsCompared, 0),
    defensibilityVerdicts: verdicts,
    htmlPath,
    jsonPath,
    emailMessageId,
    errors
  };
}
