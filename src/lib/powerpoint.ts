export type PowerPointChecklistItem = {
  id: string;
  text: string;
  done: boolean;
};

export type PowerPointKeyStat = {
  label: string;
  value: string;
};

export type PowerPointSlide = {
  id: string;
  title: string;
  subtitle: string;
  summary: string;
  filters: string[];
  legend: string[];
  keyStats: PowerPointKeyStat[];
  imageDataUrl: string;
};

type ExportDeckParams = {
  clientName: string;
  generatedAtLabel: string;
  checklist: PowerPointChecklistItem[];
  slides: PowerPointSlide[];
  brandImageDataUrl?: string | null;
  fileName?: string;
  libraryUrl: string;
};

type PptxSlide = {
  background?: { color: string };
  addShape: (shapeType: string, options: Record<string, unknown>) => void;
  addImage: (options: Record<string, unknown>) => void;
  addText: (text: string | Array<Record<string, unknown>>, options: Record<string, unknown>) => void;
};

type PptxPresentation = {
  layout: string;
  author: string;
  company: string;
  subject: string;
  title: string;
  lang?: string;
  theme?: Record<string, unknown>;
  ShapeType: {
    roundRect: string;
    rect: string;
  };
  addSlide: () => PptxSlide;
  write: (options?: { outputType?: string; compression?: boolean }) => Promise<unknown>;
  writeFile: (options?: { fileName?: string; compression?: boolean }) => Promise<string>;
};

declare global {
  interface Window {
    PptxGenJS?: new () => PptxPresentation;
    __roomyPptxLoader?: Promise<void>;
  }
}

const SLIDE_WIDTH = 13.333;
const SLIDE_HEIGHT = 7.5;
const COLORS = {
  cream: "F4EEDF",
  paper: "FBF8F1",
  greenDark: "164733",
  greenMid: "2E6550",
  gold: "B07A19",
  goldSoft: "F2E6C8",
  ink: "21352D",
  muted: "6B776F",
  border: "D4D8CD",
  white: "FFFFFF"
} as const;

function safeFileName(value: string): string {
  return value
    .trim()
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function addBranding(slide: PptxSlide, pptx: PptxPresentation, brandImageDataUrl?: string | null) {
  slide.addShape(pptx.ShapeType.roundRect, {
    x: 10.58,
    y: 6.76,
    w: 2.18,
    h: 0.46,
    fill: { color: COLORS.greenDark, transparency: 4 },
    line: { color: COLORS.greenDark, transparency: 100 }
  });

  if (brandImageDataUrl) {
    slide.addImage({
      data: brandImageDataUrl,
      x: 10.72,
      y: 6.82,
      w: 0.3,
      h: 0.3
    });
  }

  slide.addText("Roomy Revenue", {
    x: 11.08,
    y: 6.84,
    w: 1.36,
    h: 0.18,
    fontFace: "Aptos",
    fontSize: 9,
    color: COLORS.white,
    bold: true,
    margin: 0
  });
}

function addBulletList(slide: PptxSlide, title: string, items: string[], box: { x: number; y: number; w: number; h: number }) {
  slide.addText(title, {
    x: box.x,
    y: box.y,
    w: box.w,
    h: 0.22,
    fontFace: "Aptos",
    fontSize: 10,
    color: COLORS.greenDark,
    bold: true,
    margin: 0
  });

  slide.addText(
    items.map((text) => ({
      text,
      options: {
        bullet: { indent: 10 },
        breakLine: true
      }
    })),
    {
      x: box.x,
      y: box.y + 0.28,
      w: box.w,
      h: box.h - 0.28,
      fontFace: "Aptos",
      fontSize: 9,
      color: COLORS.ink,
      valign: "top",
      breakLine: false,
      paraSpaceAfterPt: 5,
      margin: 0
    }
  );
}

function addKeyStat(slide: PptxSlide, pptx: PptxPresentation, stat: PowerPointKeyStat, index: number) {
  const col = index % 2;
  const row = Math.floor(index / 2);
  const x = 8.88 + col * 1.92;
  const y = 1.48 + row * 0.74;

  slide.addShape(pptx.ShapeType.roundRect, {
    x,
    y,
    w: 1.78,
    h: 0.6,
    fill: { color: row % 2 === 0 ? COLORS.white : COLORS.paper },
    line: { color: COLORS.border, pt: 1 }
  });

  slide.addText(stat.label, {
    x: x + 0.12,
    y: y + 0.08,
    w: 1.52,
    h: 0.16,
    fontFace: "Aptos",
    fontSize: 8,
    color: COLORS.muted,
    bold: true,
    margin: 0
  });

  slide.addText(stat.value, {
    x: x + 0.12,
    y: y + 0.26,
    w: 1.52,
    h: 0.2,
    fontFace: "Aptos",
    fontSize: 12,
    color: COLORS.greenDark,
    bold: true,
    margin: 0
  });
}

function addCoverSlide(slide: PptxSlide, pptx: PptxPresentation, params: ExportDeckParams) {
  slide.background = { color: COLORS.cream };

  slide.addShape(pptx.ShapeType.rect, {
    x: 0,
    y: 0,
    w: 4.1,
    h: SLIDE_HEIGHT,
    fill: { color: COLORS.greenDark },
    line: { color: COLORS.greenDark, transparency: 100 }
  });

  slide.addShape(pptx.ShapeType.roundRect, {
    x: 0.58,
    y: 0.72,
    w: 2.92,
    h: 0.5,
    fill: { color: COLORS.greenMid, transparency: 0 },
    line: { color: COLORS.greenMid, transparency: 100 }
  });

  slide.addText("Roomy Revenue", {
    x: 0.82,
    y: 0.84,
    w: 2.1,
    h: 0.16,
    fontFace: "Aptos",
    fontSize: 11,
    color: COLORS.white,
    bold: true,
    margin: 0
  });

  slide.addText("PowerPoint Pack", {
    x: 4.62,
    y: 1.1,
    w: 5.6,
    h: 0.45,
    fontFace: "Aptos Display",
    fontSize: 24,
    color: COLORS.greenDark,
    bold: true,
    margin: 0
  });

  slide.addText(params.clientName, {
    x: 4.62,
    y: 1.72,
    w: 5.4,
    h: 0.28,
    fontFace: "Aptos",
    fontSize: 15,
    color: COLORS.ink,
    bold: true,
    margin: 0
  });

  slide.addText(`Generated ${params.generatedAtLabel}`, {
    x: 4.62,
    y: 2.04,
    w: 4.6,
    h: 0.2,
    fontFace: "Aptos",
    fontSize: 10,
    color: COLORS.muted,
    margin: 0
  });

  const coverStats: PowerPointKeyStat[] = [
    { label: "Slides queued", value: String(params.slides.length) },
    { label: "Checklist items", value: String(params.checklist.length) },
    { label: "Completed", value: String(params.checklist.filter((item) => item.done).length) },
    { label: "Open items", value: String(params.checklist.filter((item) => !item.done).length) }
  ];

  coverStats.forEach((stat, index) => addKeyStat(slide, pptx, stat, index));

  slide.addShape(pptx.ShapeType.roundRect, {
    x: 4.62,
    y: 3.38,
    w: 7.95,
    h: 2.54,
    fill: { color: COLORS.paper },
    line: { color: COLORS.border, pt: 1 }
  });

  slide.addText("What this pack includes", {
    x: 4.9,
    y: 3.68,
    w: 3.2,
    h: 0.22,
    fontFace: "Aptos",
    fontSize: 11,
    color: COLORS.greenDark,
    bold: true,
    margin: 0
  });

  slide.addText(
    [
      { text: "A branded screenshot of each selected dashboard view.", options: { bullet: { indent: 12 }, breakLine: true } },
      { text: "A plain-English summary of what the reader is seeing.", options: { bullet: { indent: 12 }, breakLine: true } },
      { text: "The filters and legend needed to interpret the report without opening the app.", options: { bullet: { indent: 12 }, breakLine: true } },
      { text: "A running checklist slide placed before the report slides for quick pre-read alignment.", options: { bullet: { indent: 12 }, breakLine: true } }
    ],
    {
      x: 4.9,
      y: 4.02,
      w: 7.2,
      h: 1.54,
      fontFace: "Aptos",
      fontSize: 11,
      color: COLORS.ink,
      paraSpaceAfterPt: 8,
      margin: 0
    }
  );

  addBranding(slide, pptx, params.brandImageDataUrl);
}

function addChecklistSlide(slide: PptxSlide, pptx: PptxPresentation, params: ExportDeckParams) {
  slide.background = { color: COLORS.paper };

  slide.addText("Running Checklist", {
    x: 0.62,
    y: 0.58,
    w: 4.2,
    h: 0.38,
    fontFace: "Aptos Display",
    fontSize: 21,
    color: COLORS.greenDark,
    bold: true,
    margin: 0
  });

  slide.addText("Placed ahead of the report slides so the audience sees the guardrails first.", {
    x: 0.62,
    y: 1.02,
    w: 6.2,
    h: 0.18,
    fontFace: "Aptos",
    fontSize: 10,
    color: COLORS.muted,
    margin: 0
  });

  slide.addShape(pptx.ShapeType.roundRect, {
    x: 0.62,
    y: 1.42,
    w: 12.08,
    h: 5.4,
    fill: { color: COLORS.white },
    line: { color: COLORS.border, pt: 1 }
  });

  const checklist =
    params.checklist.length > 0
      ? params.checklist
      : [{ id: "default", text: "No checklist items were added before export.", done: false }];

  checklist.slice(0, 8).forEach((item, index) => {
    const y = 1.82 + index * 0.58;

    slide.addShape(pptx.ShapeType.roundRect, {
      x: 0.98,
      y,
      w: 0.44,
      h: 0.32,
      fill: { color: item.done ? COLORS.greenDark : COLORS.goldSoft },
      line: { color: item.done ? COLORS.greenDark : COLORS.gold, pt: 1 }
    });

    slide.addText(item.done ? "Done" : "Open", {
      x: 1.04,
      y: y + 0.07,
      w: 0.32,
      h: 0.1,
      fontFace: "Aptos",
      fontSize: 6.5,
      color: item.done ? COLORS.white : COLORS.gold,
      bold: true,
      align: "center",
      margin: 0
    });

    slide.addText(item.text, {
      x: 1.64,
      y: y + 0.01,
      w: 10.4,
      h: 0.26,
      fontFace: "Aptos",
      fontSize: 12,
      color: COLORS.ink,
      bold: index === 0,
      margin: 0
    });
  });

  addBranding(slide, pptx, params.brandImageDataUrl);
}

function addReportSlide(slide: PptxSlide, pptx: PptxPresentation, reportSlide: PowerPointSlide, params: ExportDeckParams) {
  slide.background = { color: COLORS.paper };

  slide.addShape(pptx.ShapeType.rect, {
    x: 0,
    y: 0,
    w: SLIDE_WIDTH,
    h: 0.24,
    fill: { color: COLORS.greenDark },
    line: { color: COLORS.greenDark, transparency: 100 }
  });

  slide.addText(reportSlide.title, {
    x: 0.58,
    y: 0.48,
    w: 7.4,
    h: 0.38,
    fontFace: "Aptos Display",
    fontSize: 20,
    color: COLORS.greenDark,
    bold: true,
    margin: 0
  });

  slide.addText(reportSlide.subtitle, {
    x: 0.58,
    y: 0.92,
    w: 6.8,
    h: 0.18,
    fontFace: "Aptos",
    fontSize: 10,
    color: COLORS.muted,
    margin: 0
  });

  slide.addShape(pptx.ShapeType.roundRect, {
    x: 0.58,
    y: 1.38,
    w: 7.7,
    h: 5.58,
    fill: { color: COLORS.white },
    line: { color: COLORS.border, pt: 1 }
  });

  slide.addImage({
    data: reportSlide.imageDataUrl,
    x: 0.74,
    y: 1.54,
    w: 7.38,
    h: 5.24
  });

  slide.addShape(pptx.ShapeType.roundRect, {
    x: 8.58,
    y: 1.38,
    w: 4.16,
    h: 5.58,
    fill: { color: COLORS.white },
    line: { color: COLORS.border, pt: 1 }
  });

  reportSlide.keyStats.slice(0, 4).forEach((stat, index) => addKeyStat(slide, pptx, stat, index));

  slide.addText("What the reader is seeing", {
    x: 8.86,
    y: 3.1,
    w: 3.36,
    h: 0.22,
    fontFace: "Aptos",
    fontSize: 10,
    color: COLORS.greenDark,
    bold: true,
    margin: 0
  });

  slide.addText(reportSlide.summary, {
    x: 8.86,
    y: 3.38,
    w: 3.36,
    h: 0.98,
    fontFace: "Aptos",
    fontSize: 10,
    color: COLORS.ink,
    margin: 0,
    valign: "top"
  });

  addBulletList(slide, "Filters used", reportSlide.filters.slice(0, 6), { x: 8.86, y: 4.5, w: 3.26, h: 1.08 });
  addBulletList(slide, "Legend", reportSlide.legend.slice(0, 5), { x: 8.86, y: 5.76, w: 3.26, h: 0.94 });

  addBranding(slide, pptx, params.brandImageDataUrl);
}

export async function urlToDataUrl(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load image: ${response.status}`);
  }

  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Image conversion failed"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Image conversion failed"));
    reader.readAsDataURL(blob);
  });
}

async function loadPowerPointLibrary(libraryUrl: string): Promise<new () => PptxPresentation> {
  if (typeof window === "undefined") {
    throw new Error("PowerPoint export is only available in the browser.");
  }

  if (window.PptxGenJS) {
    return window.PptxGenJS;
  }

  if (!window.__roomyPptxLoader) {
    window.__roomyPptxLoader = new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = libraryUrl;
      script.async = true;
      script.onload = () => {
        if (window.PptxGenJS) {
          resolve();
          return;
        }
        reject(new Error("PowerPoint library loaded without exposing PptxGenJS."));
      };
      script.onerror = () => reject(new Error("Failed to load the PowerPoint library."));
      document.head.appendChild(script);
    });
  }

  await window.__roomyPptxLoader;
  if (!window.PptxGenJS) {
    throw new Error("PowerPoint library did not initialise correctly.");
  }
  return window.PptxGenJS;
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function exportDashboardDeck(params: ExportDeckParams): Promise<string> {
  const PptxGenJS = await loadPowerPointLibrary(params.libraryUrl);
  const pptx = new PptxGenJS();

  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "OpenAI Codex";
  pptx.company = "Roomy Revenue";
  pptx.subject = `${params.clientName} dashboard report`;
  pptx.title = `${params.clientName} PowerPoint Pack`;
  pptx.lang = "en-GB";
  pptx.theme = {
    headFontFace: "Aptos Display",
    bodyFontFace: "Aptos",
    lang: "en-GB"
  };

  addCoverSlide(pptx.addSlide(), pptx, params);

  if (params.checklist.length > 0) {
    addChecklistSlide(pptx.addSlide(), pptx, params);
  }

  params.slides.forEach((slide) => {
    addReportSlide(pptx.addSlide(), pptx, slide, params);
  });

  const baseName = safeFileName(params.clientName) || "roomy-revenue";
  const fileName = params.fileName ?? `${baseName}-roomy-revenue-pack.pptx`;
  const blobOutput = await pptx.write({ outputType: "blob", compression: true });
  if (blobOutput instanceof Blob) {
    downloadBlob(blobOutput, fileName);
    return fileName;
  }

  return pptx.writeFile({ fileName, compression: true });
}
