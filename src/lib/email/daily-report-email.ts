/**
 * Sends the daily trial HTML report via Resend. Embeds the BUILD-LOG.md (if
 * present) at the bottom of the email body so Mark can read autonomous-decision
 * notes without opening the file.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { resendSend } from "@/lib/email/resend-client";

export type DailyReportEmailInput = {
  subject: string;
  html: string;
  /** Override the To addresses; defaults to TRIAL_REPORT_EMAIL_TO. */
  to?: string | string[];
  /** Whether to inline BUILD-LOG.md at the bottom of the email body. Default true. */
  includeBuildLog?: boolean;
};

const REPO_ROOT = "/Users/markmccracken/Documents/signals/.claude/worktrees/strange-spence-7704a8";

async function loadBuildLog(): Promise<string | null> {
  try {
    return await readFile(path.join(REPO_ROOT, "BUILD-LOG.md"), "utf8");
  } catch {
    return null;
  }
}

export async function sendDailyReportEmail(input: DailyReportEmailInput): Promise<{ messageId: string }> {
  // Resend requires a verified domain or the special `onboarding@resend.dev`
  // address. Until Mark verifies signals.roomyrevenue.com on Resend, we fall
  // back to onboarding@resend.dev so the morning email actually lands.
  const configuredFrom = process.env.TRIAL_REPORT_EMAIL_FROM;
  const from =
    configuredFrom && configuredFrom !== "trial-reports@signals.roomyrevenue.com"
      ? configuredFrom
      : "onboarding@resend.dev";
  const to = input.to ?? process.env.TRIAL_REPORT_EMAIL_TO ?? "mark@roomyrevenue.com";
  const includeBuildLog = input.includeBuildLog !== false;
  let html = input.html;
  if (includeBuildLog) {
    const log = await loadBuildLog();
    if (log) {
      html += `\n<hr><h2>BUILD-LOG.md (autonomous build notes)</h2><pre style="white-space:pre-wrap;background:#fafafa;padding:12px;border:1px solid #eee;font-size:12px;font-family:monospace">${log
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")}</pre>`;
    }
  }
  return resendSend({ from, to, subject: input.subject, html });
}
