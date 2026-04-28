/**
 * Sends Mark a "trial build complete" email at the end of the overnight build.
 * Subject: [Signals Trial] Day 1 — overnight build complete
 *
 * The body has: branch, summary of what landed, the 30-second morning
 * checklist, and BUILD-LOG.md inlined at the bottom.
 */
import { ensureEnvLoaded } from "@/lib/load-env";
ensureEnvLoaded();

import { readFile } from "node:fs/promises";
import { sendDailyReportEmail } from "@/lib/email/daily-report-email";

const REPO_ROOT = "/Users/markmccracken/Documents/signals/.claude/worktrees/strange-spence-7704a8";

async function main(): Promise<void> {
  const buildLog = await readFile(`${REPO_ROOT}/BUILD-LOG.md`, "utf8").catch(() => "(BUILD-LOG.md not found)");

  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#222;line-height:1.5;max-width:900px;margin:24px auto;padding:0 24px">
  <h1 style="margin:0 0 8px">[Signals Trial] Day 1 — overnight build complete</h1>
  <p style="color:#666;margin:0 0 16px">Branch <code>keydata-trial-overnight-2026-04-28</code> · ready for your morning review.</p>

  <h2>30-second summary</h2>
  <ul>
    <li>5 new DB tables migrated and applied locally.</li>
    <li>KeyData provider built (OTA-only per Tyler's email) with TTL cache + sample-size guards.</li>
    <li>Trial pricing module (§3.1–3.5) implemented as pure functions.</li>
    <li>Daily comparison agent + 06:00 Europe/London BullMQ scheduler + admin <code>POST /api/pricing/comparison/run-now</code>.</li>
    <li>Defensibility audit agent calling Claude (model claude-sonnet-4-6).</li>
    <li>Resend email delivery (currently from <code>onboarding@resend.dev</code> — see flag below).</li>
    <li>Backtest harness ran once: ~4,615 historical nights tested across both tenants.</li>
    <li>First live comparison pipeline ran: 4,950 listing-dates compared, 24 defensibility audits.</li>
    <li>The first daily report email already landed in your inbox separately.</li>
  </ul>

  <h2>What you need to do this morning (in order)</h2>
  <ol>
    <li><strong>Open Tyler's email</strong> and click the "API Documentation" link. Paste the link/URL into a Claude Code message — every documented OTA endpoint at <code>https://api.keydatadashboard.com</code> currently returns 404 with the trial key, so I suspect his docs use a different path scheme. Until that's resolved, all KeyData calls return null and the model degrades to "own ADR + quality tier" only. <em>This is the single biggest blocker.</em></li>
    <li><strong>Verify the Resend domain.</strong> Go to <a href="https://resend.com/domains">https://resend.com/domains</a>, add <code>signals.roomyrevenue.com</code>, complete DNS verification. Then update <code>TRIAL_REPORT_EMAIL_FROM</code> in <code>.env</code> to a verified address. Until then, emails arrive from <code>onboarding@resend.dev</code> (check spam if you don't see the first one).</li>
    <li><strong>Read <code>BUILD-LOG.md</code></strong> (inlined at the bottom of this email). Every autonomous decision I made on your behalf is documented there.</li>
    <li><strong>Open the comparison report</strong> at <code>/Users/markmccracken/Documents/signals/trial-reports/keydata-comparison-2026-04-29.html</code> — the headline numbers will look quiet (mostly "no_hostaway_rate" classifications) until KeyData is fixed AND we have fresh Hostaway sync data for the next 90 days.</li>
    <li><strong>Open <code>/dashboard/trial</code></strong> in the running app to see the read-only viewer.</li>
    <li><strong>Verify <code>hostawayPushEnabled</code> is OFF for every listing</strong> in both trial tenants (it is by default — but visually confirm before doing anything else).</li>
    <li><strong>Don't turn on Hostaway push yet.</strong> Wait until you've reviewed at least one report with real KeyData data flowing.</li>
  </ol>

  <h2>Open flags (full detail in BUILD-LOG)</h2>
  <ul>
    <li><strong>🔴 D-6</strong> — KeyData API path scheme unresolved. Documented Postman paths return 404. Need Tyler's actual API doc URL.</li>
    <li><strong>🟡 D-2</strong> — Confirmed OTA-only access (was an OPEN; now closed via Tyler's email).</li>
    <li><strong>🟡 D-7</strong> — Settings-page UI read-only blocks deferred (lower priority than the daily reports).</li>
    <li><strong>🟡 D-9</strong> — Shell <code>ANTHROPIC_API_KEY=</code> conflict worked around in code; a clean fix is to <code>unset ANTHROPIC_API_KEY</code> in your shell.</li>
    <li><strong>🟡 D-10</strong> — Resend domain verification (point 2 above).</li>
  </ul>

  <h2>Manual triggers (if you want to re-run)</h2>
  <pre style="background:#fafafa;padding:12px;border:1px solid #eee;font-size:12px">
# Re-run the full daily pipeline (comparison + audit + report + email):
npx tsx scripts/run-comparison.ts                # today's date
npx tsx scripts/run-comparison.ts 2026-04-29     # specific snapshot date

# Re-run the backtest:
npx tsx scripts/run-backtest.ts

# Smoke-test the KeyData provider:
npx tsx scripts/keydata-smoke.ts

# Start the BullMQ worker (registers the 06:00 daily schedule):
npx tsx src/workers/pricing-comparison-worker.ts</pre>

  <h2>Files created/modified this session</h2>
  <p>See the branch diff: <code>git log --stat keydata-trial-overnight-2026-04-28..main</code> — wait, sorry, the other way: <code>git log --stat main..keydata-trial-overnight-2026-04-28</code>.</p>

  <hr style="margin:32px 0 12px;border:none;border-top:1px solid #ddd">
  <h2>BUILD-LOG.md (every decision I made on your behalf)</h2>
  <pre style="white-space:pre-wrap;background:#fafafa;padding:12px;border:1px solid #eee;font-size:12px;font-family:monospace">${buildLog
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")}</pre>
</body></html>`;

  const result = await sendDailyReportEmail({
    subject: "[Signals Trial] Day 1 — overnight build complete",
    html,
    includeBuildLog: false // already inlined above
  });
  console.log(`[build-complete-email] sent: ${result.messageId}`);
}

main().catch((err) => {
  console.error("[build-complete-email] FAILED:", err);
  process.exit(1);
});
