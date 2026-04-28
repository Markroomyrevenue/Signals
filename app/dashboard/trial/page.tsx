/**
 * Read-only viewer for the KeyData trial daily reports. Lists the most recent
 * comparison and backtest reports from /trial-reports/ and links each one for
 * inline viewing. Admin-only.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth";

const TRIAL_REPORTS_DIR = "/Users/markmccracken/Documents/signals/trial-reports";

type ReportEntry = { name: string; mtime: number; type: "comparison" | "backtest" | "decision" | "audit" | "other" };

async function listReports(): Promise<ReportEntry[]> {
  try {
    const files = await readdir(TRIAL_REPORTS_DIR);
    const entries: ReportEntry[] = [];
    for (const f of files) {
      if (!f.endsWith(".html") && !f.endsWith(".json")) continue;
      const s = await stat(path.join(TRIAL_REPORTS_DIR, f));
      const type = f.startsWith("keydata-comparison")
        ? "comparison"
        : f.startsWith("keydata-backtest")
          ? "backtest"
          : f.startsWith("keydata-decision")
            ? "decision"
            : f.startsWith("keydata-audit")
              ? "audit"
              : "other";
      entries.push({ name: f, mtime: s.mtime.getTime(), type });
    }
    return entries.sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

async function loadLatestComparisonHtml(): Promise<string | null> {
  const list = await listReports();
  const latest = list.find((e) => e.type === "comparison" && e.name.endsWith(".html"));
  if (!latest) return null;
  try {
    return await readFile(path.join(TRIAL_REPORTS_DIR, latest.name), "utf8");
  } catch {
    return null;
  }
}

export default async function TrialDashboardPage() {
  const auth = await getAuthContext();
  if (!auth) redirect("/login");
  if (auth.role !== "admin") redirect("/dashboard");

  const reports = await listReports();
  const latestHtml = await loadLatestComparisonHtml();

  return (
    <main style={{ maxWidth: 1100, margin: "32px auto", padding: "0 24px", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
      <h1>KeyData trial dashboard</h1>
      <p style={{ color: "#666" }}>
        Read-only viewer for the daily comparison reports. Reports are also emailed to{" "}
        <code>{process.env.TRIAL_REPORT_EMAIL_TO ?? "mark@roomyrevenue.com"}</code> at 06:00 Europe/London daily.
      </p>

      <section style={{ marginTop: 32 }}>
        <h2>Recent reports ({reports.length})</h2>
        {reports.length === 0 ? (
          <p style={{ color: "#888" }}>No reports yet — waiting for the first run.</p>
        ) : (
          <ul style={{ fontFamily: "monospace", fontSize: 13, lineHeight: 1.8 }}>
            {reports.slice(0, 30).map((r) => (
              <li key={r.name}>
                <span style={{ color: "#888", marginRight: 12 }}>{new Date(r.mtime).toISOString().slice(0, 16).replace("T", " ")}</span>
                <span style={{ display: "inline-block", minWidth: 100, color: "#444" }}>[{r.type}]</span>
                {r.name}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={{ marginTop: 48 }}>
        <h2>Latest comparison report (inline)</h2>
        {latestHtml ? (
          <iframe
            srcDoc={latestHtml}
            style={{ width: "100%", height: "1200px", border: "1px solid #ddd", borderRadius: 4 }}
            title="latest-comparison"
          />
        ) : (
          <p style={{ color: "#888" }}>No comparison report has been produced yet.</p>
        )}
      </section>
    </main>
  );
}
