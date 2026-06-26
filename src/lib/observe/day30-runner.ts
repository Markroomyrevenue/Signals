/**
 * Day-30 readout runner (SIGNALS-OBSERVE-LEARN-SPEC.md §8/§9; mirrors
 * `agents/pricing-comparison/day14-runner.ts`).
 *
 * Renders a graduated client's readout HTML, writes HTML + JSON to the reports
 * dir, and sends the email — once per (client, date) via an `.email-sent` marker
 * guard. Fired by the observe worker on the day a client graduates, and runnable
 * by hand:
 *
 *   npx tsx scripts/observe-day30.ts <tenantId>            # today's date
 *   npx tsx scripts/observe-day30.ts <tenantId> 2026-07-26 # explicit date
 *
 * Safe to re-run — the marker blocks a double-send. Never logs or emails a key.
 */

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { sendDailyReportEmail } from "@/lib/email/daily-report-email";

import { buildReadout, renderReadoutHtml } from "./readout";
import { defaultClientKey } from "./config";
import { observeSlug } from "./registry";

const OBSERVE_REPORTS_DIR = process.env.OBSERVE_REPORTS_DIR ?? path.join(process.cwd(), "observe-reports");

export type Day30RunnerInput = { tenantId: string; clientKey?: string; reportDate?: string; reason?: string };

export type Day30RunnerResult = {
  tenantId: string;
  reportDate: string;
  htmlPath: string | null;
  jsonPath: string | null;
  emailMessageId: string | null;
  skipped: boolean;
  errors: string[];
};

export async function sendDay30Readout(input: Day30RunnerInput): Promise<Day30RunnerResult> {
  const errors: string[] = [];
  const clientKey = input.clientKey ?? defaultClientKey(input.tenantId);
  const reportDate = input.reportDate ?? new Date().toISOString().slice(0, 10);
  console.log(`[observe-day30] starting tenant=${input.tenantId} date=${reportDate} reason=${input.reason ?? "manual"}`);

  let htmlPath: string | null = null;
  let jsonPath: string | null = null;
  let emailMessageId: string | null = null;
  let skipped = false;

  let html = "";
  let subject = "[Signals] Observe & Learn — Day-30 readout";
  let json = "{}";
  let slug = observeSlug(input.tenantId);
  try {
    const data = await buildReadout({ tenantId: input.tenantId, clientKey });
    slug = observeSlug(data.client);
    html = renderReadoutHtml(data);
    subject = `[Signals] Observe & Learn — Day-30 readout: ${data.client}`;
    json = JSON.stringify(data, null, 2);
  } catch (err) {
    errors.push(`render failed: ${err instanceof Error ? err.message : String(err)}`);
    html = `<html><body><h1>Day-30 readout — render failed</h1><pre>${
      err instanceof Error ? err.stack ?? err.message : String(err)
    }</pre></body></html>`;
  }

  const base = `observe-day30-${slug}-${reportDate}`;
  try {
    await mkdir(OBSERVE_REPORTS_DIR, { recursive: true });
    htmlPath = path.join(OBSERVE_REPORTS_DIR, `${base}.html`);
    jsonPath = path.join(OBSERVE_REPORTS_DIR, `${base}.json`);
    await writeFile(htmlPath, html, "utf8");
    await writeFile(jsonPath, json, "utf8");
  } catch (err) {
    errors.push(`write failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Once-per-(client,date) guard — same pattern as the day-14 runner.
  const sentMarker = path.join(OBSERVE_REPORTS_DIR, `${base}.email-sent`);
  let alreadySent = false;
  try {
    await access(sentMarker);
    alreadySent = true;
  } catch {
    alreadySent = false;
  }
  if (alreadySent) {
    console.log(`[observe-day30] guard: ${sentMarker} exists — skipping email send.`);
    skipped = true;
  } else {
    try {
      const result = await sendDailyReportEmail({ subject, html });
      emailMessageId = result.messageId;
      try {
        await writeFile(
          sentMarker,
          JSON.stringify({ messageId: emailMessageId, sentAt: new Date().toISOString() }, null, 2),
          "utf8"
        );
      } catch (writeErr) {
        console.warn(
          `[observe-day30] could not write email-sent marker: ${
            writeErr instanceof Error ? writeErr.message : String(writeErr)
          }`
        );
      }
    } catch (err) {
      errors.push(`email failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { tenantId: input.tenantId, reportDate, htmlPath, jsonPath, emailMessageId, skipped, errors };
}
