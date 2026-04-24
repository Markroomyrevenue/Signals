"use client";

export type BusinessReviewTable = {
  title: string;
  headers: string[];
  rows: string[][];
};

export type BusinessReviewSection = {
  id: string;
  title: string;
  subtitle: string;
  filters: string[];
  chartImageDataUrl?: string | null;
  tables: BusinessReviewTable[];
};

function fitWithinBox(params: {
  width: number;
  height: number;
  maxWidth: number;
  maxHeight: number;
}): { width: number; height: number } {
  const widthRatio = params.maxWidth / Math.max(1, params.width);
  const heightRatio = params.maxHeight / Math.max(1, params.height);
  const ratio = Math.min(widthRatio, heightRatio, 1);
  return {
    width: params.width * ratio,
    height: params.height * ratio
  };
}

function buildFileName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "business-review";
}

function drawFooter(params: {
  doc: {
    addImage: (imageData: string, format: string, x: number, y: number, width: number, height: number) => void;
    getTextWidth: (value: string) => number;
    internal: {
      pageSize: {
        getWidth: () => number;
        getHeight: () => number;
      };
    };
    line: (x1: number, y1: number, x2: number, y2: number) => void;
    setDrawColor: (value: number) => void;
    setFont: (fontName: string, fontStyle?: string) => void;
    setFontSize: (size: number) => void;
    setTextColor: (value: number) => void;
    text: (value: string, x: number, y: number) => void;
  };
  brandImageDataUrl?: string | null;
  generatedAtLabel: string;
}) {
  const { doc, brandImageDataUrl, generatedAtLabel } = params;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const footerY = pageHeight - 22;

  doc.setDrawColor(226);
  doc.line(36, pageHeight - 36, pageWidth - 36, pageHeight - 36);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(105);
  doc.text(`Generated ${generatedAtLabel}`, 36, footerY);

  const brandLabel = "Roomy Revenue";
  const brandTextWidth = doc.getTextWidth(brandLabel);
  const brandX = pageWidth - 36 - brandTextWidth;
  if (brandImageDataUrl) {
    doc.addImage(brandImageDataUrl, "JPEG", brandX - 24, pageHeight - 32, 18, 18);
  }
  doc.setFont("helvetica", "bold");
  doc.setTextColor(36);
  doc.text(brandLabel, brandX, footerY);
}

export async function urlToDataUrl(url: string): Promise<string> {
  const response = await fetch(url, { cache: "force-cache" });
  if (!response.ok) {
    throw new Error(`Failed to fetch asset: ${response.status}`);
  }

  const blob = await response.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read asset"));
    reader.onloadend = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Failed to convert asset"));
        return;
      }
      resolve(reader.result);
    };
    reader.readAsDataURL(blob);
  });
}

export async function exportBusinessReviewPdf(params: {
  clientName: string;
  sections: BusinessReviewSection[];
  generatedAtLabel: string;
  brandImageDataUrl?: string | null;
  filename?: string;
}) {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);

  const doc = new jsPDF({
    orientation: "landscape",
    unit: "pt",
    format: "a4",
    compress: true
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const left = 36;
  const right = pageWidth - 36;
  const maxChartWidth = right - left;
  const maxChartHeight = 250;

  params.sections.forEach((section, sectionIndex) => {
    if (sectionIndex > 0) {
      doc.addPage("a4", "landscape");
    }

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

    if (section.chartImageDataUrl) {
      const imageProps = doc.getImageProperties(section.chartImageDataUrl);
      const fitted = fitWithinBox({
        width: imageProps.width,
        height: imageProps.height,
        maxWidth: maxChartWidth,
        maxHeight: maxChartHeight
      });
      doc.addImage(section.chartImageDataUrl, "PNG", left, cursorY, fitted.width, fitted.height);
      cursorY += fitted.height + 18;
    }

    section.tables.forEach((table, tableIndex) => {
      const tableStartY = cursorY;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.setTextColor(36);
      doc.text(table.title, left, tableStartY);

      autoTable(doc, {
        startY: tableStartY + 8,
        head: [table.headers],
        body: table.rows,
        margin: { left, right: 36, bottom: 46 },
        styles: {
          font: "helvetica",
          fontSize: 9,
          textColor: 36,
          cellPadding: 6,
          lineColor: 226,
          lineWidth: 0.5
        },
        headStyles: {
          fillColor: [31, 122, 77],
          textColor: 255,
          fontStyle: "bold"
        },
        alternateRowStyles: {
          fillColor: [249, 246, 240]
        },
        didDrawPage: () => {
          drawFooter({
            doc,
            brandImageDataUrl: params.brandImageDataUrl,
            generatedAtLabel: params.generatedAtLabel
          });
        }
      });

      const lastAutoTable = (doc as typeof doc & { lastAutoTable?: { finalY: number } }).lastAutoTable;
      cursorY = (lastAutoTable?.finalY ?? tableStartY + 28) + (tableIndex === section.tables.length - 1 ? 0 : 18);
      if (cursorY > pageHeight - 120 && tableIndex < section.tables.length - 1) {
        doc.addPage("a4", "landscape");
        cursorY = 42;
      }
    });

    if (section.tables.length === 0) {
      drawFooter({
        doc,
        brandImageDataUrl: params.brandImageDataUrl,
        generatedAtLabel: params.generatedAtLabel
      });
    }
  });

  doc.save(`${buildFileName(params.filename ?? `${params.clientName} business review`)}.pdf`);
}

export function downloadCsv(params: {
  filename: string;
  headers: string[];
  rows: Array<Array<string | number | null | undefined>>;
}) {
  const escapeCell = (value: string | number | null | undefined) => {
    const normalized = value === null || value === undefined ? "" : String(value);
    if (/[",\n]/.test(normalized)) {
      return `"${normalized.replace(/"/g, "\"\"")}"`;
    }
    return normalized;
  };

  const csv = [params.headers, ...params.rows].map((row) => row.map(escapeCell).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = `${buildFileName(params.filename)}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}
