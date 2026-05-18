/**
 * Day-14 summary runner. Renders the Day-14 HTML, writes it to disk, and
 * sends the email (once-per-trial guard via a marker file).
 *
 * Triggered by the pricing-comparison BullMQ worker on the trial end date,
 * after the morning daily report. Can also be invoked manually:
 *
 *   npx tsx scripts/run-day14-summary.ts                # uses KEYDATA_TRIAL_END
 *   npx tsx scripts/run-day14-summary.ts 2026-06-01     # explicit date
 *
 * Safe to re-run on the same date — the marker file blocks a double-send.
 */
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderDay14SummaryHtml } from "@/lib/agents/pricing-comparison/summary-email";
import { sendDailyReportEmail } from "@/lib/email/daily-report-email";

const TRIAL_REPORTS_DIR = "/Users/markmccracken/Documents/signals/trial-reports";

export type Day14RunnerInput = { reportDate: string; reason?: string };

export type Day14RunnerResult = {
  reportDate: string;
  htmlPath: string | null;
  jsonPath: string | null;
  emailMessageId: string | null;
  skipped: boolean;
  errors: string[];
};

export async function sendDay14Summary(input: Day14RunnerInput): Promise<Day14RunnerResult> {
  const errors: string[] = [];
  const { reportDate } = input;
  console.log(`[day14-summary] starting reportDate=${reportDate} reason=${input.reason ?? "manual"}`);

  let htmlPath: string | null = null;
  let jsonPath: string | null = null;
  let emailMessageId: string | null = null;
  let skipped = false;

  let html = "";
  let subject = "[Signals Trial] Day 14 — KeyData trial summary";
  let metrics: unknown = null;
  try {
    const rendered = await renderDay14SummaryHtml({ reportDate });
    html = rendered.html;
    subject = rendered.subject;
    metrics = rendered.metrics;
  } catch (err) {
    errors.push(`render failed: ${err instanceof Error ? err.message : String(err)}`);
    html = `<html><body><h1>Day 14 — render failed</h1><pre>${err instanceof Error ? err.stack ?? err.message : String(err)}</pre></body></html>`;
  }

  try {
    await mkdir(TRIAL_REPORTS_DIR, { recursive: true });
    htmlPath = path.join(TRIAL_REPORTS_DIR, `keydata-day14-summary-${reportDate}.html`);
    jsonPath = path.join(TRIAL_REPORTS_DIR, `keydata-day14-summary-${reportDate}.json`);
    await writeFile(htmlPath, html, "utf8");
    await writeFile(jsonPath, JSON.stringify({ reportDate, metrics, errors }, null, 2), "utf8");
  } catch (err) {
    errors.push(`write failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Once-per-trial guard. Same pattern as the daily pipeline.
  const sentMarker = path.join(TRIAL_REPORTS_DIR, `keydata-day14-summary-${reportDate}.email-sent`);
  let alreadySent = false;
  try {
    await access(sentMarker);
    alreadySent = true;
  } catch {
    alreadySent = false;
  }
  if (alreadySent) {
    console.log(`[day14-summary] guard: ${sentMarker} exists — skipping email send.`);
    skipped = true;
  } else {
    try {
      const result = await sendDailyReportEmail({ subject, html });
      emailMessageId = result.messageId;
      try {
        await writeFile(sentMarker, JSON.stringify({ messageId: emailMessageId, sentAt: new Date().toISOString() }, null, 2), "utf8");
      } catch (writeErr) {
        console.warn(`[day14-summary] could not write email-sent marker: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
      }
    } catch (err) {
      errors.push(`email failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { reportDate, htmlPath, jsonPath, emailMessageId, skipped, errors };
}
