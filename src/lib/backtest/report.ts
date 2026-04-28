/**
 * Backtest report HTML rendering. Single-page, scannable, with the
 * "current-KeyData-as-proxy" caveat called out at the top.
 */
import type { BacktestRunSummary } from "@/lib/backtest/runner";

const ESC = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

export function renderBacktestHtml(summary: BacktestRunSummary): string {
  const tenantRows = summary.tenants
    .map(
      (t) => `
    <tr>
      <td style="padding:6px;border-bottom:1px solid #f0f0f0">${ESC(t.tenantName)}</td>
      <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${t.listingsTested}</td>
      <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${t.nightsTested.toLocaleString()}</td>
      <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">£${t.meanAbsError.toFixed(2)}</td>
      <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">£${t.medianAbsError.toFixed(2)}</td>
      <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">£${t.rmse.toFixed(2)}</td>
      <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${(t.medianAbsPctError * 100).toFixed(1)}%</td>
      <td align="right" style="padding:6px;border-bottom:1px solid #f0f0f0">${(t.directionalAccuracy * 100).toFixed(0)}%</td>
    </tr>`
    )
    .join("");

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>KeyData trial — Backtest summary</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#222;line-height:1.5;max-width:1100px;margin:24px auto;padding:0 24px}.caveat{background:#fffbe6;border:1px solid #f0d670;padding:12px;border-radius:4px;margin:16px 0}</style>
</head><body>
<h1>KeyData trial — Backtest summary</h1>
<p>Run id: <code>${ESC(summary.runId)}</code></p>

<div class="caveat">
  <strong>Caveat (read first):</strong> we don't keep historical KeyData snapshots,
  so this backtest uses CURRENT KeyData values as a proxy for what the market
  signal would have been on each historical booking date. This biases the results
  slightly OPTIMISTIC — KeyData would not have been live a year ago. Read the
  numbers as a baseline of "is the model in the right ballpark", not as a precise
  forecast.
</div>

<table style="border-collapse:collapse;width:100%;margin-top:16px">
  <tr>
    <th align="left" style="padding:6px;border-bottom:1px solid #888">Tenant</th>
    <th align="right" style="padding:6px;border-bottom:1px solid #888">Listings</th>
    <th align="right" style="padding:6px;border-bottom:1px solid #888">Nights tested</th>
    <th align="right" style="padding:6px;border-bottom:1px solid #888">Mean abs error</th>
    <th align="right" style="padding:6px;border-bottom:1px solid #888">Median abs error</th>
    <th align="right" style="padding:6px;border-bottom:1px solid #888">RMSE</th>
    <th align="right" style="padding:6px;border-bottom:1px solid #888">Median abs %</th>
    <th align="right" style="padding:6px;border-bottom:1px solid #888">Directional acc</th>
  </tr>
  ${tenantRows}
</table>

<p style="margin-top:24px;color:#666;font-size:12px">
  Median abs error in £ is the most stable headline metric — it tells you the
  typical disagreement between our recommendation and what actually booked.
  Directional accuracy = % of cases where we and the booked rate moved the same
  way relative to the listing's median (i.e. both above-median or both below-median
  on a given date).
</p>
</body></html>`;
}
