/**
 * UI audit (Agent 4/5/6) — render a REAL business-review PDF from live Little
 * Feather data and write it to scripts/audit/out/business-review-sample.pdf so
 * the auditor can inspect pagination / overflow / number-formatting defects.
 *
 * It faithfully replicates the layout logic of src/lib/business-review.ts
 * (jsPDF + jspdf-autotable, A4 landscape, one section per page) but writes the
 * buffer to disk instead of calling doc.save() (which only works in a browser).
 *
 * READ-ONLY against prod. Run via:
 *   bash scripts/audit/run.sh scripts/audit/ui-business-review.ts
 */
import { writeFileSync } from "node:fs";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { prisma, getLiveTenants } from "./lib/ctx";
import {
  buildSalesReport,
  buildBookWindowReport,
  buildPropertyDeepDiveReport
} from "@/lib/reports/service";

// ---- formatting helpers (copied verbatim from revenue-dashboard.tsx) --------
const fmtInt = (v: number) => new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 }).format(Math.round(v));
const fmtCur = (v: number, c: string) => new Intl.NumberFormat("en-GB", { style: "currency", currency: c, maximumFractionDigits: 2 }).format(v);
const fmtPct = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)}%`);
const fmtSignedPct = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`);
const fmtSignedPts = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)} pts`;

type Table = { title: string; headers: string[]; rows: string[][] };
type Section = { id: string; title: string; subtitle: string; filters: string[]; tables: Table[] };

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function fitWithinBox(p: { width: number; height: number; maxWidth: number; maxHeight: number }) {
  const r = Math.min(p.maxWidth / Math.max(1, p.width), p.maxHeight / Math.max(1, p.height), 1);
  return { width: p.width * r, height: p.height * r };
}

// ---- renderer: faithful port of exportBusinessReviewPdf ---------------------
function renderPdf(clientName: string, sections: Section[], generatedAtLabel: string): Buffer {
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4", compress: true });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const left = 36;
  const right = pageWidth - 36;
  const maxChartWidth = right - left;

  function drawFooter() {
    const footerY = pageHeight - 22;
    doc.setDrawColor(226);
    doc.line(36, pageHeight - 36, pageWidth - 36, pageHeight - 36);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(105);
    doc.text(`Generated ${generatedAtLabel}`, 36, footerY);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(36);
    const brand = "Roomy Revenue";
    doc.text(brand, pageWidth - 36 - doc.getTextWidth(brand), footerY);
  }

  sections.forEach((section, sectionIndex) => {
    if (sectionIndex > 0) doc.addPage("a4", "landscape");

    doc.setFont("helvetica", "bold");
    doc.setFontSize(20);
    doc.setTextColor(22);
    doc.text(section.title, left, 42);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(95);
    const subtitleLines = doc.splitTextToSize(section.subtitle, maxChartWidth);
    doc.text(subtitleLines, left, 60);
    let cursorY = 60 + subtitleLines.length * 12 + 10;

    if (section.filters.length > 0) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.setTextColor(36);
      doc.text("Filters", left, cursorY);
      cursorY += 12;
      doc.setFont("helvetica", "normal");
      doc.setTextColor(95);
      const filterLines = doc.splitTextToSize(section.filters.join(" • "), maxChartWidth);
      doc.text(filterLines, left, cursorY);
      cursorY += filterLines.length * 11 + 10;
    }

    section.tables.forEach((table, tableIndex) => {
      const tableStartY = cursorY;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.setTextColor(36);
      doc.text(table.title, pageWidth / 2, tableStartY, { align: "center" });

      autoTable(doc, {
        startY: tableStartY + 8,
        head: [table.headers],
        body: table.rows,
        margin: { left, right: 36, bottom: 46 },
        styles: { font: "helvetica", fontSize: 9, textColor: 36, cellPadding: 6, lineColor: 226, lineWidth: 0.5 },
        headStyles: { fillColor: [31, 122, 77], textColor: 255, fontStyle: "bold" },
        alternateRowStyles: { fillColor: [249, 246, 240] },
        didDrawPage: () => drawFooter()
      });

      const last = (doc as any).lastAutoTable;
      cursorY = (last?.finalY ?? tableStartY + 28) + (tableIndex === section.tables.length - 1 ? 0 : 18);
      if (cursorY > pageHeight - 120 && tableIndex < section.tables.length - 1) {
        doc.addPage("a4", "landscape");
        cursorY = 42;
      }
    });

    if (section.tables.length === 0) drawFooter();
  });

  return Buffer.from(doc.output("arraybuffer"));
}

async function main() {
  const tenants = await getLiveTenants();
  const lf = tenants.find((t) => /little feather/i.test(t.name));
  if (!lf) throw new Error("Little Feather tenant not found");
  const cur = "GBP";

  const today = new Date();
  const to = dateOnly(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())));
  const from = dateOnly(new Date(Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), today.getUTCDate())));

  const sections: Section[] = [];

  // 1) STAYED (sales) — monthly buckets, 7 cols
  const sales = await buildSalesReport({
    tenantId: lf.id,
    request: { stayDateFrom: from, stayDateTo: to, granularity: "month", listingIds: [], channels: [], statuses: [], includeFees: true, includeVat: true, barMetric: "revenue", compareMode: "yoy_otb" } as any,
    displayCurrency: cur
  });
  {
    const buckets: string[] = sales.buckets ?? [];
    const rows = buckets.map((label, i) => [
      label,
      fmtInt(sales.current.nights[i] ?? 0),
      fmtInt(sales.lastYear.nights[i] ?? 0),
      fmtCur(sales.current.revenue[i] ?? 0, cur),
      fmtCur(sales.lastYear.revenue[i] ?? 0, cur),
      fmtCur(sales.current.adr[i] ?? 0, cur),
      fmtCur(sales.lastYear.adr[i] ?? 0, cur)
    ]);
    sections.push({
      id: "sales", title: "Stayed report — Little Feather Management",
      subtitle: `Stay window ${from} to ${to} · monthly buckets · revenue incl. fees & VAT · ${rows.length} rows`,
      filters: ["All properties", "All channels", "All statuses", "Currency: GBP"],
      tables: [{ title: "Detailed view", headers: ["Bucket", "Roomnights this year", "Roomnights last year", "Revenue this year", "Revenue last year", "ADR", "ADR previous year"], rows }]
    });
  }

  // 2) BOOKING WINDOWS — 8 cols
  const bw = await buildBookWindowReport({
    tenantId: lf.id,
    request: { mode: "booked", lookbackDays: 365, listingIds: [], channels: [], statuses: [] } as any,
    displayCurrency: cur
  });
  {
    const rows = bw.buckets.map((b) => [
      b.label, fmtInt(b.nights), `${b.nightsPct.toFixed(1)}%`, fmtInt(b.reservations),
      fmtInt(b.cancelledReservations), `${b.cancellationPct.toFixed(1)}%`, fmtCur(b.adr, cur), b.avgLos.toFixed(2)
    ]);
    sections.push({
      id: "bw", title: "Booking Windows report — Little Feather Management",
      subtitle: `Last 365 days booked · lead-time buckets · ${rows.length} rows`,
      filters: ["All properties", "All channels", "All statuses", "Currency: GBP"],
      tables: [{ title: "Detailed view", headers: ["Book Window", "Nights", "Nights %", "Reservations", "Cancelled", "Cancellation %", "ADR", "Avg LOS"], rows }]
    });
  }

  // 3) PROPERTY DRILLDOWN — 9 cols, one row per listing (the overflow stress case)
  const monthStart = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const dd = await buildPropertyDeepDiveReport({
    tenantId: lf.id,
    request: { granularity: "month", compareMode: "yoy_otb", selectedPeriodStart: monthStart, listingIds: [], channels: [], statuses: [], includeFees: true, includeVat: true } as any,
    displayCurrency: cur
  });
  {
    const rows = dd.rows.map((r) => [
      r.listingName,
      r.health === "behind" ? "Behind" : r.health === "ahead" ? "Ahead" : "On pace",
      fmtCur(r.current.revenue, cur), fmtSignedPct(r.delta.revenuePct),
      fmtCur(r.current.adr, cur), fmtSignedPct(r.delta.adrPct),
      fmtPct(r.current.occupancy), fmtSignedPts(r.delta.occupancyPts),
      r.liveRate !== null ? fmtCur(r.liveRate, cur) : "—"
    ]);
    sections.push({
      id: "dd", title: "Property Drilldown report — Little Feather Management",
      subtitle: `${dd.period?.label ?? monthStart} · per-property · ${rows.length} properties`,
      filters: ["All properties", "All channels", "All statuses", "Compare: Same date last year", "Currency: GBP"],
      tables: [{ title: `Detailed view${dd.period?.label ? ` · ${dd.period.label}` : ""}`, headers: ["Property", "Pace Status", "Revenue", "Revenue vs LY", "ADR", "ADR vs LY", "Occupancy", "Occupancy vs LY", "Live Rate"], rows }]
    });
  }

  const pdf = renderPdf("Little Feather Management", sections, "29 Jun 2026, 16:00");
  const outPath = "/Users/markmccracken/Documents/signals/scripts/audit/out/business-review-sample.pdf";
  writeFileSync(outPath, pdf);

  console.log(`\nWrote ${pdf.length} bytes -> ${outPath}`);
  console.log("Sections rendered:");
  sections.forEach((s, i) => console.log(`  [${i + 1}] ${s.title} — ${s.tables[0].rows.length} rows × ${s.tables[0].headers.length} cols`));
  console.log("\nLongest header strings (overflow candidates):");
  sections.forEach((s) => s.tables[0].headers.forEach((h) => { if (h.length > 16) console.log(`  "${h}" (${h.length} chars) in ${s.id}`); }));
  await prisma.$disconnect();
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
