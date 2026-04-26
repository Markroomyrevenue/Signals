import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { createPortal } from "react-dom";

import type { PricingCalendarResponse } from "@/lib/reports/pricing-calendar-types";
import {
  buildCalendarAnchorFieldState,
  buildCalendarRationaleLines,
  buildCalendarSuggestedActionText,
  buildCalendarPropertyDraft,
  calendarCellCopy,
  calendarCellSelectionKey,
  formatCalendarOverrideInput,
  formatCompactCalendarPrice,
  isCalendarPropertyDraftDirty,
  pricingMarketDataStatusLabel,
  pricingMarketDataStatusTone,
  qualityTierLabel,
  type CalendarPropertyDraft,
  type PricingCalendarCell,
  type PricingCalendarRow
} from "./calendar-utils";

type CalendarSettingsScope = "portfolio" | "group" | "property";
type CalendarSettingsSectionId =
  | "base_pricing"
  | "occupancy"
  | "demand"
  | "seasonality"
  | "day_of_week"
  | "safety_net"
  | "local_events"
  | "last_minute"
  | "stay_rules";

const DESKTOP_CALENDAR_ROW_HEIGHT = 104;
const DESKTOP_CALENDAR_DAY_COLUMN_WIDTH = 84;
const ROOMY_RECOMMENDED_LABEL = "Roomy Recommended";
const UPDATE_RECOMMENDED_PRICES_LABEL = "Refresh recommendations";

const DESKTOP_INSPECTOR_POPUP_WIDTH = 540;
const DESKTOP_INSPECTOR_POPUP_MAX_HEIGHT = 680;

type AnchorRect = { top: number; left: number; width: number; height: number };

function computeAnchoredPopupPosition(
  anchor: AnchorRect,
  popup: { width: number; maxHeight: number },
  viewport: { width: number; height: number },
  margin = 8
): { top: number; left: number; placement: "above" | "below" } {
  const spaceBelow = viewport.height - (anchor.top + anchor.height);
  const spaceAbove = anchor.top;
  const placeBelow = spaceBelow >= popup.maxHeight + margin || spaceBelow >= spaceAbove;
  const top = placeBelow
    ? Math.min(anchor.top + anchor.height + margin, viewport.height - popup.maxHeight - margin)
    : Math.max(margin, anchor.top - popup.maxHeight - margin);
  let left = anchor.left + anchor.width / 2 - popup.width / 2;
  if (left + popup.width > viewport.width - margin) left = viewport.width - popup.width - margin;
  if (left < margin) left = margin;
  return { top: Math.max(margin, top), left, placement: placeBelow ? "below" : "above" };
}
const DEFAULT_DESKTOP_COLUMN_WIDTHS = {
  property: 264,
  market: 138,
  minimum: 126,
  base: 126
} as const;
const MIN_DESKTOP_COLUMN_WIDTHS = {
  property: 228,
  market: 116,
  minimum: 112,
  base: 112
} as const;
const MAX_DESKTOP_COLUMN_WIDTHS = {
  property: 420,
  market: 210,
  minimum: 180,
  base: 180
} as const;
type DesktopColumnKey = keyof typeof DEFAULT_DESKTOP_COLUMN_WIDTHS;
const QUALITY_TIER_OPTIONS = [
  { id: "low_scale" as const, label: "Value" },
  { id: "mid_scale" as const, label: "Standard" },
  { id: "upscale" as const, label: "Premium" }
];

function MetricBadge({ tone, children }: { tone: "green" | "gold" | "red" | "blue"; children: React.ReactNode }) {
  const tones: Record<typeof tone, CSSProperties> = {
    green: { background: "rgba(31,122,77,0.12)", color: "var(--delta-positive)" },
    gold: { background: "rgba(176,122,25,0.14)", color: "var(--mustard-dark)" },
    red: { background: "rgba(187,75,82,0.12)", color: "var(--delta-negative)" },
    blue: { background: "rgba(95,111,103,0.12)", color: "var(--green-mid)" }
  };

  return (
    <span className="inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]" style={tones[tone]}>
      {children}
    </span>
  );
}

function InspectorValueCard({
  label,
  value,
  tone = "default",
  field,
  caption
}: {
  label: string;
  value: string;
  tone?: "default" | "green" | "gold";
  field?: "base" | "minimum";
  caption?: string;
}) {
  const tones: Record<typeof tone, CSSProperties> = {
    default: { background: "rgba(248, 250, 249, 0.86)", borderColor: "var(--border)" },
    green: { background: "rgba(31,122,77,0.08)", borderColor: "rgba(22,71,51,0.14)" },
    gold: { background: "rgba(176,122,25,0.08)", borderColor: "rgba(176,122,25,0.18)" }
  };
  const fieldStyle: CSSProperties | undefined =
    field === "base"
      ? { borderBottom: "2px solid var(--green-dark)" }
      : field === "minimum"
        ? { borderBottom: "1px dashed var(--mustard-dark)" }
        : undefined;

  return (
    <div className="rounded-[14px] border px-3 py-3" style={{ ...tones[tone], ...fieldStyle }}>
      <div className="flex items-center gap-1.5">
        {field ? <PricingFieldChip field={field} /> : null}
        <div className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--muted-text)" }}>
          {label}
        </div>
      </div>
      <div className="mt-1 text-base font-semibold">{value}</div>
      {caption ? (
        <div className="mt-1 text-[11px] leading-4" style={{ color: "var(--muted-text)" }}>
          {caption}
        </div>
      ) : null}
    </div>
  );
}

function MiniBadge({ tone, children }: { tone: "green" | "gold" | "blue"; children: React.ReactNode }) {
  const tones: Record<typeof tone, CSSProperties> = {
    green: { background: "rgba(31,122,77,0.1)", color: "var(--green-dark)", borderColor: "rgba(22,71,51,0.14)" },
    gold: { background: "rgba(176,122,25,0.1)", color: "var(--mustard-dark)", borderColor: "rgba(176,122,25,0.18)" },
    blue: { background: "rgba(95,111,103,0.12)", color: "var(--green-mid)", borderColor: "rgba(95,111,103,0.18)" }
  };

  return (
    <span className="inline-flex rounded-full border px-2 py-1 text-[10px] font-semibold leading-none" style={tones[tone]}>
      {children}
    </span>
  );
}

function QualityTierToggle({
  value,
  onChange,
  disabled = false,
  compact = false
}: {
  value: PricingCalendarRow["settings"]["qualityTier"];
  onChange: (value: PricingCalendarRow["settings"]["qualityTier"]) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "grid grid-cols-3 gap-1.5" : "grid grid-cols-3 gap-2"}>
      {QUALITY_TIER_OPTIONS.map((option) => {
        const selected = value === option.id;

        return (
          <button
            key={`calendar-quality-${option.id}`}
            type="button"
            aria-pressed={selected}
            className={`min-w-0 rounded-[10px] border font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${
              compact ? "px-1.5 py-1 text-[9px]" : "px-3 py-2.5 text-sm"
            }`}
            style={
              selected
                ? { background: "var(--green-dark)", borderColor: "var(--green-dark)", color: "#ffffff" }
                : { background: "#ffffff", borderColor: "var(--border)", color: "var(--navy-dark)" }
            }
            disabled={disabled}
            onClick={() => onChange(option.id)}
          >
            <span className="block truncate">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function firstSelectableCell(row: PricingCalendarRow | null | undefined): PricingCalendarCell | null {
  if (!row) return null;
  return row.cells.find((cell) => cell.state !== "unknown") ?? row.cells[0] ?? null;
}

function compactCellBackground(cell: PricingCalendarCell, palette: ReturnType<typeof calendarCellCopy>): string {
  if (cell.state === "booked") return "rgba(223, 228, 234, 0.86)";
  if (cell.state === "unavailable") return "rgba(247, 236, 193, 0.66)";
  if (cell.state === "unknown") return "rgba(222, 229, 236, 0.72)";
  return "rgba(255, 255, 255, 0.96)";
}

// Solid green = Base Price (anchor); dashed mustard = Minimum Price (floor).
// The shape difference is intentional so the two columns are distinguishable
// at a glance even for users with reduced colour vision.
function PricingFieldChip({ field }: { field: "base" | "minimum" }) {
  if (field === "base") {
    return (
      <span
        className="inline-flex items-center justify-center rounded-md px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-[0.16em]"
        style={{ background: "rgba(31,122,77,0.14)", color: "var(--green-dark)", border: "1px solid var(--green-dark)" }}
        aria-label="Base Price"
        title="Base Price — the anchor for future pricing"
      >
        Base
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center justify-center rounded-md px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-[0.16em]"
      style={{
        background: "rgba(176,122,25,0.12)",
        color: "var(--mustard-dark)",
        border: "1px dashed var(--mustard-dark)"
      }}
      aria-label="Minimum Price"
      title="Minimum Price — the floor; we never recommend below this"
    >
      Min
    </span>
  );
}

function formatNightLabel(value: number): string {
  const nights = Math.max(1, Math.round(value));
  return `${nights} night${nights === 1 ? "" : "s"}`;
}

function calendarPropertyFieldLabel(field: "base" | "minimum"): string {
  return field === "base" ? "Base Price" : "Minimum Price";
}

function shortMarketStatusLabel(status: PricingCalendarRow["marketDataStatus"]): string | null {
  if (status === "cached_market_data") return null;
  return pricingMarketDataStatusLabel(status);
}

function conciseAnchorExplanation(
  field: "base" | "minimum",
  state: ReturnType<typeof buildCalendarAnchorFieldState>,
  locationMissing: boolean
): string {
  const fieldLabel = calendarPropertyFieldLabel(field);

  if (locationMissing) {
    return `Add a Base Price or a resolvable location before relying on future recommendations.`;
  }

  if (!state.isManualOverride) {
    return `${fieldLabel} is following ${ROOMY_RECOMMENDED_LABEL}.`;
  }

  if (!state.isBlendedWithMarket) {
    return `${fieldLabel} is using your saved price.`;
  }

  return `${fieldLabel} starts with your saved price, then adjusts with market data.`;
}

function ColumnResizeHandle({
  onPointerDown
}: {
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      role="presentation"
      className="absolute inset-y-0 right-0 z-40 flex w-3 cursor-col-resize items-center justify-center"
      onPointerDown={onPointerDown}
      style={{ touchAction: "none" }}
    >
      <span className="h-8 w-[2px] rounded-full bg-[rgba(53,78,104,0.16)]" />
    </div>
  );
}

function CalendarInspector({
  pricingCalendarReport,
  row,
  cell,
  propertyDraft,
  propertyDraftDirty,
  isPropertySaving,
  isPropertyRefreshing,
  locationMissing,
  openCalendarSettingsPanel,
  handleSetCalendarPropertyQualityTier,
  updateCalendarPropertyDraft,
  handleSaveCalendarPropertyOverrides,
  handleResetCalendarPropertyDraft,
  handleRefreshCalendarListing,
  onCloseInspector,
  formatCurrency,
  formatDisplayDate
}: {
  pricingCalendarReport: PricingCalendarResponse;
  row: PricingCalendarRow | null;
  cell: PricingCalendarCell | null;
  propertyDraft: CalendarPropertyDraft | null;
  propertyDraftDirty: boolean;
  isPropertySaving: boolean;
  isPropertyRefreshing: boolean;
  locationMissing: boolean;
  openCalendarSettingsPanel: (
    scope: CalendarSettingsScope | null,
    section?: CalendarSettingsSectionId,
    options?: { propertyId?: string; groupRef?: string }
  ) => void;
  handleSetCalendarPropertyQualityTier: (
    listingId: string,
    qualityTier: PricingCalendarRow["settings"]["qualityTier"]
  ) => Promise<void> | void;
  updateCalendarPropertyDraft: (listingId: string, field: keyof CalendarPropertyDraft, value: string) => void;
  handleSaveCalendarPropertyOverrides: (listingId: string) => Promise<void> | void;
  handleResetCalendarPropertyDraft: (row: PricingCalendarRow) => void;
  handleRefreshCalendarListing: (listingId: string) => void;
  onCloseInspector: () => void;
  formatCurrency: (value: number, currency: string) => string;
  formatDisplayDate: (dateOnly: string) => string;
}) {
  if (!row || !cell || !propertyDraft) return null;
  const listingId = row.listingId;
  const baseAnchorState = buildCalendarAnchorFieldState(row, "base", pricingCalendarReport.meta.displayCurrency);
  const minimumAnchorState = buildCalendarAnchorFieldState(row, "minimum", pricingCalendarReport.meta.displayCurrency);
  const anchorSummaryTone =
    row.pricingAnchors.pricingAnchorSource === "system"
      ? "green"
      : row.pricingAnchors.pricingAnchorSource === "user"
        ? "gold"
        : "blue";
  const marketStatusLabel = shortMarketStatusLabel(row.marketDataStatus);
  const rationaleLines = buildCalendarRationaleLines(cell, pricingCalendarReport.meta.displayCurrency).slice(0, 5);
  const suggestedActionText = buildCalendarSuggestedActionText(cell, pricingCalendarReport.meta.displayCurrency);

  function maybeCommitPropertyDraft() {
    if (!propertyDraftDirty || isPropertySaving) return;
    void handleSaveCalendarPropertyOverrides(listingId);
  }

  function handlePropertyInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    maybeCommitPropertyDraft();
  }

  const cellStateBadgeTone = cell.state === "booked" ? "blue" : cell.state === "unavailable" ? "gold" : "green";

  return (
    <div className="relative space-y-4">
      {/* Always-visible primary close affordance: a large circular X anchored
          to the top-right of the inspector. Sits above all other content
          (z-10) so the user never has to hunt for "how do I close this". */}
      <button
        type="button"
        aria-label="Close pricing detail"
        onClick={onCloseInspector}
        className="absolute right-0 top-0 z-10 flex h-9 w-9 items-center justify-center rounded-full border bg-white text-lg font-semibold leading-none shadow-sm transition hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
        style={{ borderColor: "var(--border-strong)", color: "var(--navy-dark)" }}
        title="Close pricing detail"
      >
        ×
      </button>
      <div className="rounded-[18px] border bg-white/94 p-4 pr-12" style={{ borderColor: "var(--border)" }}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              {/* Sets expectations up front: tapping a cell shows detail, it
                  doesn't change anything. The property-pricing inputs below
                  ARE editable but they belong to the property, not this date. */}
              <span
                className="rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em]"
                style={{ borderColor: "var(--border-strong)", color: "var(--navy-dark)", background: "rgba(255,255,255,0.94)" }}
              >
                Pricing detail · read-only
              </span>
              <MetricBadge tone={cellStateBadgeTone}>{calendarCellCopy(cell.state, cell.demandBand).label}</MetricBadge>
              {marketStatusLabel ? (
                <span className="rounded-full px-2 py-1 text-[10px] font-semibold" style={pricingMarketDataStatusTone(row.marketDataStatus)}>
                  {marketStatusLabel}
                </span>
              ) : null}
            </div>
            <h2 className="mt-3 font-display text-[1.35rem] leading-tight">{formatDisplayDate(cell.date)}</h2>
            <p className="mt-2 text-[13px] font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--muted-text)" }}>
              {row.listingName}
            </p>
            <p className="mt-1 text-sm leading-6" style={{ color: "var(--muted-text)" }}>
              {marketStatusLabel
                ? row.marketDataMessage
                : "Here's why we recommended this price. Editing happens in the property pricing card below — never per date."}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              className="rounded-full border px-3 py-1.5 text-xs font-semibold"
              style={{ borderColor: "var(--border-strong)", color: "var(--navy-dark)" }}
              onClick={() => {
                openCalendarSettingsPanel("property", "base_pricing", { propertyId: row.listingId });
              }}
              title="Opens the full pricing settings for this property"
            >
              Edit this property&apos;s pricing
            </button>
            <button
              type="button"
              className="rounded-full border px-3 py-1.5 text-xs font-semibold"
              style={{ borderColor: "var(--border-strong)", color: "var(--navy-dark)" }}
              disabled={isPropertySaving || isPropertyRefreshing}
              onClick={() => handleRefreshCalendarListing(listingId)}
              title="Re-runs Roomy's recommendation using the latest cached data"
            >
              {isPropertyRefreshing ? "Refreshing" : "Refresh recommendations"}
            </button>
            {/* Close action also lives as a top-right circular X — see top of
                the inspector wrapper above. Removed the duplicate text button. */}
          </div>
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <InspectorValueCard
            label={cell.state === "booked" ? "Booked rate" : "Recommended"}
            value={
              cell.state === "booked"
                ? formatCurrency(cell.bookedRate ?? 0, pricingCalendarReport.meta.displayCurrency)
                : cell.recommendedRate !== null
                  ? formatCurrency(cell.recommendedRate, pricingCalendarReport.meta.displayCurrency)
                  : "—"
            }
            tone="green"
          />
          <InspectorValueCard
            label="Current live rate"
            value={cell.liveRate !== null ? formatCurrency(cell.liveRate, pricingCalendarReport.meta.displayCurrency) : "—"}
          />
          <InspectorValueCard
            field="base"
            label="Base Price"
            value={cell.recommendedBaseRate !== null ? formatCurrency(cell.recommendedBaseRate, pricingCalendarReport.meta.displayCurrency) : "—"}
            caption="Anchor for future pricing"
          />
          <InspectorValueCard
            field="minimum"
            label="Minimum Price"
            value={cell.minimumSuggestedRate !== null ? formatCurrency(cell.minimumSuggestedRate, pricingCalendarReport.meta.displayCurrency) : "—"}
            tone="gold"
            caption="Floor — never recommend below this"
          />
        </div>

        <div className="mt-4 rounded-[14px] border bg-slate-50/72 px-3 py-3" style={{ borderColor: "var(--border)" }}>
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--muted-text)" }}>
            Why this price
          </div>
          <div className="mt-2 grid gap-2 text-sm">
            {rationaleLines.map((line, index) => (
              <div key={`${cell.date}-rationale-${index}`} className="leading-snug">
                <div className="font-semibold">{line.primary}</div>
                {line.rationale ? (
                  <div className="text-[12px] leading-5" style={{ color: "var(--muted-text)" }}>
                    {line.rationale}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          {suggestedActionText ? (
            <div
              className="mt-3 rounded-[10px] border px-3 py-2 text-[13px] leading-5"
              style={{ borderColor: "rgba(53,78,104,0.16)", background: "rgba(248,250,249,0.86)", color: "var(--navy-dark)" }}
            >
              <span className="mr-1.5 font-semibold uppercase tracking-[0.12em] text-[10px]" style={{ color: "var(--muted-text)" }}>
                What this means
              </span>
              {suggestedActionText}
            </div>
          ) : null}
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <InspectorValueCard label="Current minimum stay" value={cell.minStay !== null ? formatNightLabel(cell.minStay) : "—"} />
          <InspectorValueCard label="Demand" value={calendarCellCopy("available", cell.demandBand).summary} />
        </div>
      </div>

      <div className="rounded-[18px] border bg-white/94 p-4" style={{ borderColor: "var(--border)" }}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--muted-text)" }}>
              Property pricing · editable
            </p>
            <p className="mt-1 text-sm leading-6" style={{ color: "var(--muted-text)" }}>
              These changes apply to <strong>every</strong> date for this property — they do not
              affect just {formatDisplayDate(cell.date)}.
            </p>
          </div>
          <span
            className="text-[11px] font-semibold uppercase tracking-[0.16em]"
            style={{ color: isPropertySaving ? "var(--green-dark)" : propertyDraftDirty ? "var(--mustard-dark)" : "var(--muted-text)" }}
          >
            {isPropertySaving ? "Saving" : propertyDraftDirty ? "Unsaved" : "Saved"}
          </span>
        </div>

        <div className="mt-3 rounded-[14px] border px-3 py-3" style={{ borderColor: "var(--border)", background: "rgba(248,250,249,0.88)" }}>
          <div className="flex flex-wrap items-center gap-2">
            <MiniBadge tone={anchorSummaryTone}>
              {row.pricingAnchors.pricingAnchorSource === "system"
                ? ROOMY_RECOMMENDED_LABEL
                : row.pricingAnchors.pricingAnchorSource === "user"
                  ? "Manual override"
                  : "Adjusted with market data"}
            </MiniBadge>
            {locationMissing ? <MiniBadge tone="gold">Needs Base Price or location</MiniBadge> : null}
          </div>
          <p className="mt-2 text-sm leading-6" style={{ color: "var(--navy-dark)" }}>
            {locationMissing
              ? "This property still needs either a Base Price or a resolvable location before future recommendations are fully dependable."
              : "Change Base Price or Minimum Price here when Roomy needs a different starting point."}
          </p>
        </div>

        <div className="mt-3">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--muted-text)" }}>
            Property Quality
          </div>
          <QualityTierToggle
            value={propertyDraft.qualityTier}
            disabled={isPropertySaving}
            onChange={(nextQualityTier) => handleSetCalendarPropertyQualityTier(row.listingId, nextQualityTier)}
          />
        </div>

        <div className="mt-3 grid gap-3">
          {/* Base Price comes first — it is the anchor for future pricing.
              Solid green border accent matches the grid's solid bottom line. */}
          <label
            className="rounded-[16px] border-2 px-4 py-4"
            style={{ borderColor: "var(--green-dark)", background: "rgba(31,122,77,0.06)" }}
          >
            <div className="flex items-center gap-2">
              <PricingFieldChip field="base" />
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--muted-text)" }}>
                Base Price
              </div>
              <span className="text-[11px] font-medium normal-case" style={{ color: "var(--muted-text)" }}>
                — anchor for future pricing
              </span>
            </div>
            <input
              type="text"
              inputMode="decimal"
              aria-label="Base Price"
              className="mt-3 w-full rounded-[12px] border bg-white px-3 py-2.5 text-[1.05rem] font-semibold outline-none"
              style={{ borderColor: "rgba(22,71,51,0.18)", color: "var(--green-dark)" }}
              value={propertyDraft.basePriceOverride}
              placeholder={formatCalendarOverrideInput(row.pricingAnchors.recommendedBasePrice) || "No base set"}
              onChange={(event) => updateCalendarPropertyDraft(listingId, "basePriceOverride", event.target.value)}
              onKeyDown={handlePropertyInputKeyDown}
            />
            <div className="mt-3 grid gap-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span style={{ color: "var(--muted-text)" }}>{ROOMY_RECOMMENDED_LABEL}</span>
                <span className="font-semibold">{baseAnchorState.recommendedValue}</span>
              </div>
              {baseAnchorState.isManualOverride ? (
                <div className="flex items-center justify-between gap-3">
                  <span style={{ color: "var(--muted-text)" }}>Your saved price</span>
                  <span className="font-semibold">{baseAnchorState.manualValue}</span>
                </div>
              ) : null}
              {baseAnchorState.isBlendedWithMarket ? (
                <div className="flex items-center justify-between gap-3">
                  <span style={{ color: "var(--muted-text)" }}>Price used</span>
                  <span className="font-semibold">{baseAnchorState.effectiveValue}</span>
                </div>
              ) : null}
            </div>
            <p className="mt-2 text-[13px] leading-5" style={{ color: "var(--muted-text)" }}>
              {conciseAnchorExplanation("base", baseAnchorState, locationMissing)}
            </p>
          </label>
          {/* Minimum Price renders second as the floor / safety net.
              Dashed mustard border matches the grid's dashed bottom line. */}
          <label
            className="rounded-[16px] border-2 border-dashed px-4 py-4"
            style={{ borderColor: "var(--mustard-dark)", background: "rgba(180,122,25,0.06)" }}
          >
            <div className="flex items-center gap-2">
              <PricingFieldChip field="minimum" />
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--muted-text)" }}>
                Minimum Price
              </div>
              <span className="text-[11px] font-medium normal-case" style={{ color: "var(--muted-text)" }}>
                — floor; we never recommend below this
              </span>
            </div>
            <input
              type="text"
              inputMode="decimal"
              aria-label="Minimum Price"
              className="mt-3 w-full rounded-[12px] border bg-white px-3 py-2.5 text-[1.05rem] font-semibold outline-none"
              style={{ borderColor: "rgba(180,143,54,0.22)", color: "var(--mustard-dark)" }}
              value={propertyDraft.minimumPriceOverride}
              placeholder={formatCalendarOverrideInput(row.pricingAnchors.recommendedMinimumPrice) || "No minimum set"}
              onChange={(event) => updateCalendarPropertyDraft(listingId, "minimumPriceOverride", event.target.value)}
              onKeyDown={handlePropertyInputKeyDown}
            />
            <div className="mt-3 grid gap-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span style={{ color: "var(--muted-text)" }}>{ROOMY_RECOMMENDED_LABEL}</span>
                <span className="font-semibold">{minimumAnchorState.recommendedValue}</span>
              </div>
              {minimumAnchorState.isManualOverride ? (
                <div className="flex items-center justify-between gap-3">
                  <span style={{ color: "var(--muted-text)" }}>Your saved price</span>
                  <span className="font-semibold">{minimumAnchorState.manualValue}</span>
                </div>
              ) : null}
              {minimumAnchorState.isBlendedWithMarket ? (
                <div className="flex items-center justify-between gap-3">
                  <span style={{ color: "var(--muted-text)" }}>Price used</span>
                  <span className="font-semibold">{minimumAnchorState.effectiveValue}</span>
                </div>
              ) : null}
            </div>
            <p className="mt-2 text-[13px] leading-5" style={{ color: "var(--muted-text)" }}>
              {conciseAnchorExplanation("minimum", minimumAnchorState, locationMissing)}
            </p>
          </label>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
          {locationMissing ? (
            <span style={{ color: "var(--delta-negative)" }}>Add a Base Price or a resolvable location before relying on future recommendations.</span>
          ) : (
            <span style={{ color: "var(--muted-text)" }}>Changes here affect future recommendations for every date on this property.</span>
          )}
          <span style={{ color: "var(--muted-text)" }}>
            {ROOMY_RECOMMENDED_LABEL}: Base Price {baseAnchorState.recommendedValue} · Minimum Price {minimumAnchorState.recommendedValue}
          </span>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-full px-3.5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            style={{ background: "var(--green-dark)" }}
            disabled={!propertyDraftDirty || isPropertySaving}
            onClick={() => void handleSaveCalendarPropertyOverrides(listingId)}
          >
            Save property pricing
          </button>
          <button
            type="button"
            className="rounded-full border px-3.5 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
            style={{ borderColor: "var(--border-strong)", color: "var(--navy-dark)" }}
            disabled={!propertyDraftDirty || isPropertySaving}
            onClick={() => handleResetCalendarPropertyDraft(row)}
          >
            Reset changes
          </button>
        </div>
      </div>
    </div>
  );
}

export function CalendarGridPanel({
  pricingCalendarReport,
  calendarVisibleRows,
  calendarVisibleDays,
  selectedCalendarCellDetail,
  calendarPropertyDrafts,
  savingCalendarPropertyIds,
  refreshingCalendarListingIds,
  selectedCalendarCellKey,
  calendarHasHorizontalOverflow,
  calendarScrollViewportRef,
  calendarTableRef,
  calendarBottomScrollRef,
  calendarBottomScrollContentRef,
  setSelectedCalendarCellKey,
  openCalendarSettingsPanel,
  handleSetCalendarPropertyQualityTier,
  updateCalendarPropertyDraft,
  handleSaveCalendarPropertyOverrides,
  handleResetCalendarPropertyDraft,
  handleRefreshCalendarListing,
  formatCurrency,
  formatDisplayDate
}: {
  pricingCalendarReport: PricingCalendarResponse;
  calendarVisibleRows: PricingCalendarRow[];
  calendarVisibleDays: PricingCalendarResponse["days"];
  selectedCalendarCellDetail: { row: PricingCalendarRow; cell: PricingCalendarCell } | null;
  calendarPropertyDrafts: Record<string, CalendarPropertyDraft>;
  savingCalendarPropertyIds: string[];
  refreshingCalendarListingIds: string[];
  selectedCalendarCellKey: string | null;
  calendarHasHorizontalOverflow: boolean;
  calendarScrollViewportRef: RefObject<HTMLDivElement | null>;
  calendarTableRef: RefObject<HTMLTableElement | null>;
  calendarBottomScrollRef: RefObject<HTMLDivElement | null>;
  calendarBottomScrollContentRef: RefObject<HTMLDivElement | null>;
  setSelectedCalendarCellKey: (key: string | null) => void;
  openCalendarSettingsPanel: (
    scope: CalendarSettingsScope | null,
    section?: CalendarSettingsSectionId,
    options?: { propertyId?: string; groupRef?: string }
  ) => void;
  handleSetCalendarPropertyQualityTier: (
    listingId: string,
    qualityTier: PricingCalendarRow["settings"]["qualityTier"]
  ) => Promise<void> | void;
  updateCalendarPropertyDraft: (listingId: string, field: keyof CalendarPropertyDraft, value: string) => void;
  handleSaveCalendarPropertyOverrides: (listingId: string) => Promise<void> | void;
  handleResetCalendarPropertyDraft: (row: PricingCalendarRow) => void;
  handleRefreshCalendarListing: (listingId: string) => void;
  formatCurrency: (value: number, currency: string) => string;
  formatDisplayDate: (dateOnly: string) => string;
}) {
  const selectedRow = selectedCalendarCellDetail?.row ?? null;
  const selectedCell = selectedCalendarCellDetail?.cell ?? null;
  const inspectorOpen = selectedRow !== null && selectedCell !== null;
  const inspectorPanelRef = useRef<HTMLDivElement | null>(null);
  const inspectorAsideRef = useRef<HTMLElement | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const [desktopColumnWidths, setDesktopColumnWidths] = useState(DEFAULT_DESKTOP_COLUMN_WIDTHS);
  const [hasMounted, setHasMounted] = useState(false);
  const [inspectorAnchorRect, setInspectorAnchorRect] = useState<AnchorRect | null>(null);
  // Mobile viewport flag — used to drop horizontal-sticky on the
  // Market/Min/Base columns so date columns become reachable on a 380px
  // screen. Without this, the Market/Min/Base sticky-left positions sum to
  // ~654px and pin the date columns permanently off-screen.
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  useEffect(() => {
    setHasMounted(true);
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 1023px)");
    const update = () => setIsMobileViewport(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // The popup stays open until the user explicitly saves, closes, clicks
  // outside, or clicks a different cell. We do NOT close on scroll/resize —
  // owner reported the earlier close-on-scroll behaviour killed the popup
  // during normal interaction.
  useEffect(() => {
    if (!inspectorOpen || typeof document === "undefined") return;
    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      // Click inside the popup itself — leave it open.
      if (inspectorAsideRef.current && inspectorAsideRef.current.contains(target)) return;
      // Click on another cell — let the cell's onClick handle re-selection.
      // The popup will re-anchor to the new cell as React updates state.
      const targetEl = target instanceof Element ? target : (target as Node).parentElement;
      if (targetEl?.closest("[data-calendar-cell]")) return;
      setSelectedCalendarCellKey(null);
      setInspectorAnchorRect(null);
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [inspectorOpen, setSelectedCalendarCellKey]);

  const activePropertyDraft = selectedRow ? calendarPropertyDrafts[selectedRow.listingId] ?? buildCalendarPropertyDraft(selectedRow) : null;
  const activePropertyDraftDirty = selectedRow && activePropertyDraft ? isCalendarPropertyDraftDirty(selectedRow, activePropertyDraft) : false;
  const activePropertySaving = selectedRow ? savingCalendarPropertyIds.includes(selectedRow.listingId) : false;
  const activePropertyRefreshing = selectedRow ? refreshingCalendarListingIds.includes(selectedRow.listingId) : false;
  const activeLocationMissing = selectedRow ? !selectedRow.marketLabel && selectedRow.pricingAnchors.currentBasePrice === null : false;
  const desktopColumnLefts = {
    market: desktopColumnWidths.property,
    minimum: desktopColumnWidths.property + desktopColumnWidths.market,
    base: desktopColumnWidths.property + desktopColumnWidths.market + desktopColumnWidths.minimum
  };

  useEffect(() => {
    if (!selectedCell) return;
    // Reset scroll inside the popup so a freshly-selected cell shows the top
    // of its inspector content rather than the previous cell's scroll offset.
    inspectorAsideRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [selectedCell, selectedRow?.listingId]);

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  function selectCalendarCell(listingId: string, date: string, anchorEl?: HTMLElement | null) {
    setSelectedCalendarCellKey(calendarCellSelectionKey(listingId, date));
    if (anchorEl) {
      const rect = anchorEl.getBoundingClientRect();
      setInspectorAnchorRect({ top: rect.top, left: rect.left, width: rect.width, height: rect.height });
    } else {
      setInspectorAnchorRect(null);
    }
  }

  function closeInspector() {
    setSelectedCalendarCellKey(null);
    setInspectorAnchorRect(null);
  }

  function maybeCommitRowPropertyDraft(row: PricingCalendarRow, draftDirty: boolean, isRowSaving: boolean) {
    if (!draftDirty || isRowSaving) return;
    void handleSaveCalendarPropertyOverrides(row.listingId);
  }

  function handleRowPropertyInputKeyDown(
    event: KeyboardEvent<HTMLInputElement>,
    row: PricingCalendarRow,
    draftDirty: boolean,
    isRowSaving: boolean
  ) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    maybeCommitRowPropertyDraft(row, draftDirty, isRowSaving);
  }

  function startDesktopColumnResize(columnKey: DesktopColumnKey, event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();

    resizeCleanupRef.current?.();

    const startX = event.clientX;
    const startWidth = desktopColumnWidths[columnKey];

    const handlePointerMove = (pointerEvent: PointerEvent) => {
      const widthDelta = pointerEvent.clientX - startX;
      const nextWidth = Math.max(
        MIN_DESKTOP_COLUMN_WIDTHS[columnKey],
        Math.min(MAX_DESKTOP_COLUMN_WIDTHS[columnKey], Math.round(startWidth + widthDelta))
      );

      setDesktopColumnWidths((current) => ({
        ...current,
        [columnKey]: nextWidth
      }));
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", cleanup);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      resizeCleanupRef.current = null;
    };

    resizeCleanupRef.current = cleanup;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", cleanup, { once: true });
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-[18px] border bg-white/64 p-2" style={{ borderColor: "var(--border)" }}>
      {/* Mobile scroll affordance: a chevron at the right edge of the table
          viewport that signals "more dates →". Hidden on lg+ where the full
          width is usually visible without scroll. */}
      <div
        aria-hidden
        className="pointer-events-none absolute right-3 top-1/2 z-40 -translate-y-1/2 rounded-full border bg-white/95 px-2 py-1 text-[10px] font-semibold shadow-md lg:hidden"
        style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
      >
        scroll&nbsp;→
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] gap-3">
        <div className="flex min-h-0 flex-col overflow-hidden rounded-[16px] border bg-white/88 p-2" style={{ borderColor: "var(--border)" }}>
          <div ref={calendarScrollViewportRef} className="min-h-0 flex-1 overflow-auto rounded-[14px]">
            <table ref={calendarTableRef} className="min-w-max table-fixed border-separate text-[11px]" style={{ borderSpacing: "0 0" }}>
              <thead>
                <tr>
                  <th
                    className="relative sticky left-0 top-0 z-30 px-4 py-2 text-left font-semibold shadow-[2px_0_0_rgba(228,234,240,0.9)]"
                    style={{ width: `${desktopColumnWidths.property}px`, minWidth: `${desktopColumnWidths.property}px`, background: "rgba(255,255,255,0.98)" }}
                  >
                    Property
                    <ColumnResizeHandle onPointerDown={(event) => startDesktopColumnResize("property", event)} />
                  </th>
                  <th
                    className="relative sticky top-0 z-30 px-3 py-2 text-left font-semibold shadow-[2px_0_0_rgba(228,234,240,0.9)]"
                    style={{
                      left: isMobileViewport ? undefined : `${desktopColumnLefts.market}px`,
                      width: `${desktopColumnWidths.market}px`,
                      minWidth: `${desktopColumnWidths.market}px`,
                      background: "rgba(255,255,255,0.98)"
                    }}
                  >
                    Market
                    <ColumnResizeHandle onPointerDown={(event) => startDesktopColumnResize("market", event)} />
                  </th>
                  <th
                    className="relative sticky top-0 z-30 px-3 py-2 text-left font-semibold shadow-[2px_0_0_rgba(228,234,240,0.9)]"
                    style={{
                      left: isMobileViewport ? undefined : `${desktopColumnLefts.minimum}px`,
                      width: `${desktopColumnWidths.minimum}px`,
                      minWidth: `${desktopColumnWidths.minimum}px`,
                      background: "rgba(255,255,255,0.98)"
                    }}
                  >
                    Minimum Price
                    <ColumnResizeHandle onPointerDown={(event) => startDesktopColumnResize("minimum", event)} />
                  </th>
                  <th
                    className="relative sticky top-0 z-30 px-3 py-2 text-left font-semibold shadow-[2px_0_0_rgba(228,234,240,0.9)]"
                    style={{
                      left: isMobileViewport ? undefined : `${desktopColumnLefts.base}px`,
                      width: `${desktopColumnWidths.base}px`,
                      minWidth: `${desktopColumnWidths.base}px`,
                      background: "rgba(255,255,255,0.98)"
                    }}
                  >
                    Base Price
                    <ColumnResizeHandle onPointerDown={(event) => startDesktopColumnResize("base", event)} />
                  </th>
                  {calendarVisibleDays.map((day) => {
                    const isWeekend = day.weekdayShort === "Sat" || day.weekdayShort === "Sun";
                    return (
                      <th
                        key={`workspace-day-${day.date}`}
                        className="sticky top-0 z-20 h-[44px] px-1 py-1 text-center"
                        style={{
                          minWidth: `${DESKTOP_CALENDAR_DAY_COLUMN_WIDTH}px`,
                          maxWidth: `${DESKTOP_CALENDAR_DAY_COLUMN_WIDTH}px`,
                          background: isWeekend ? "rgba(243, 246, 249, 0.98)" : "rgba(255,255,255,0.96)"
                        }}
                      >
                        <div className="text-[13px] font-semibold leading-none">{day.dayNumber}</div>
                        <div className="mt-1 text-[8px] font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--muted-text)" }}>
                          {day.weekdayShort}
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {calendarVisibleRows.map((row) => {
                  const rowPrimaryCell = firstSelectableCell(row);
                  const isSelectedRow = selectedRow?.listingId === row.listingId;
                  const locationMissing = !row.marketLabel && row.pricingAnchors.currentBasePrice === null;
                  const isRowSaving = savingCalendarPropertyIds.includes(row.listingId);
                  const rowPropertyDraft = calendarPropertyDrafts[row.listingId] ?? buildCalendarPropertyDraft(row);
                  const rowPropertyDraftDirty = isCalendarPropertyDraftDirty(row, rowPropertyDraft);
                  const baseAnchorState = buildCalendarAnchorFieldState(row, "base", pricingCalendarReport.meta.displayCurrency);
                  const minimumAnchorState = buildCalendarAnchorFieldState(row, "minimum", pricingCalendarReport.meta.displayCurrency);

                  return (
                    <tr key={`workspace-row-${row.listingId}`}>
                      <td
                        className="sticky left-0 z-20 p-0 align-top shadow-[2px_0_0_rgba(228,234,240,0.9)]"
                        style={{ width: `${desktopColumnWidths.property}px`, minWidth: `${desktopColumnWidths.property}px` }}
                      >
                        <div
                          className="flex h-full flex-col overflow-hidden border border-r-0 px-4 py-3"
                          style={{
                            width: `${desktopColumnWidths.property}px`,
                            height: `${DESKTOP_CALENDAR_ROW_HEIGHT}px`,
                            background: isSelectedRow ? "rgba(255,255,255,1)" : "rgba(255,255,255,0.98)",
                            borderColor: isSelectedRow ? "rgba(22, 71, 51, 0.26)" : "var(--border)",
                            boxShadow: isSelectedRow ? "inset 0 0 0 1px rgba(22, 71, 51, 0.12)" : undefined
                          }}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <button
                              type="button"
                              className="min-w-0 flex-1 overflow-hidden text-left"
                              data-calendar-cell="true"
                              onClick={(event) => {
                                if (rowPrimaryCell) {
                                  selectCalendarCell(row.listingId, rowPrimaryCell.date, event.currentTarget);
                                }
                              }}
                            >
                              <div className="line-clamp-2 min-h-[2.15rem] pr-2 text-[14px] font-semibold leading-[1.2] [overflow-wrap:anywhere]">
                                {row.listingName}
                              </div>
                            </button>
                            {isRowSaving || rowPropertyDraftDirty ? (
                              <span
                                className="shrink-0 rounded-full px-2 py-1 text-[8px] font-semibold uppercase tracking-[0.08em]"
                                style={{
                                  color: isRowSaving ? "var(--green-dark)" : "var(--mustard-dark)",
                                  background: isRowSaving ? "rgba(31,122,77,0.08)" : "rgba(176,122,25,0.12)"
                                }}
                              >
                                {isRowSaving ? "Saving" : "Unsaved"}
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-2">
                            <QualityTierToggle
                              value={rowPropertyDraft.qualityTier}
                              compact
                              disabled={isRowSaving}
                              onChange={(nextQualityTier) => handleSetCalendarPropertyQualityTier(row.listingId, nextQualityTier)}
                            />
                          </div>
                          <div className="mt-auto pt-2">
                            <div className="text-[9px] font-medium" style={{ color: "var(--muted-text)" }}>
                              {qualityTierLabel(rowPropertyDraft.qualityTier)}
                            </div>
                            {rowPropertyDraftDirty || isRowSaving ? (
                              <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                                <button
                                  type="button"
                                  className="rounded-[9px] px-2 py-1.5 text-[9px] font-semibold leading-none text-white disabled:cursor-not-allowed disabled:opacity-50"
                                  style={{ background: "var(--green-dark)" }}
                                  disabled={!rowPropertyDraftDirty || isRowSaving}
                                  onClick={() => maybeCommitRowPropertyDraft(row, rowPropertyDraftDirty, isRowSaving)}
                                >
                                  {isRowSaving ? "Saving" : "Save"}
                                </button>
                                <button
                                  type="button"
                                  className="rounded-[9px] border px-2 py-1.5 text-[9px] font-semibold leading-none disabled:cursor-not-allowed disabled:opacity-50"
                                  style={{ borderColor: "var(--border-strong)", color: "var(--navy-dark)" }}
                                  disabled={!rowPropertyDraftDirty || isRowSaving}
                                  onClick={() => handleResetCalendarPropertyDraft(row)}
                                >
                                  Reset
                                </button>
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </td>
                      <td
                        className="sticky z-20 p-0 align-top shadow-[2px_0_0_rgba(228,234,240,0.9)]"
                        style={{ left: isMobileViewport ? undefined : `${desktopColumnLefts.market}px`, width: `${desktopColumnWidths.market}px`, minWidth: `${desktopColumnWidths.market}px` }}
                      >
                        <div
                          className="flex h-full flex-col justify-center border border-l-0 border-r-0 px-3 py-2"
                          style={{
                            width: `${desktopColumnWidths.market}px`,
                            height: `${DESKTOP_CALENDAR_ROW_HEIGHT}px`,
                            background: isSelectedRow ? "rgba(246, 250, 247, 0.98)" : "rgba(255,255,255,0.96)",
                            borderColor: isSelectedRow ? "rgba(22, 71, 51, 0.22)" : "var(--border)"
                          }}
                        >
                          <div className="truncate text-[11px] font-semibold" style={{ color: "var(--navy-dark)" }}>
                            {row.marketLabel ?? "Setup needed"}
                          </div>
                          {locationMissing || row.marketDataStatus !== "cached_market_data" ? (
                            <div className="mt-1 text-[9px] font-medium uppercase tracking-[0.12em]" style={{ color: "var(--muted-text)" }}>
                              {locationMissing ? "Setup needed" : shortMarketStatusLabel(row.marketDataStatus)}
                            </div>
                          ) : null}
                        </div>
                      </td>
                      <td
                        className="sticky z-20 p-0 align-top shadow-[2px_0_0_rgba(228,234,240,0.9)]"
                        style={{ left: isMobileViewport ? undefined : `${desktopColumnLefts.minimum}px`, width: `${desktopColumnWidths.minimum}px`, minWidth: `${desktopColumnWidths.minimum}px` }}
                      >
                        <div
                          className="flex h-full flex-col justify-center border border-l-0 border-r-0 px-2.5 py-2"
                          style={{
                            width: `${desktopColumnWidths.minimum}px`,
                            height: `${DESKTOP_CALENDAR_ROW_HEIGHT}px`,
                            background: isSelectedRow ? "rgba(248, 246, 236, 0.96)" : "rgba(255,255,255,0.96)",
                            borderColor: isSelectedRow ? "rgba(176, 122, 25, 0.22)" : "var(--border)",
                            // dashed bottom accent so Minimum reads as a "floor"
                            // line at a glance, distinct from Base's solid line.
                            borderBottom: "1px dashed var(--mustard-dark)"
                          }}
                        >
                          <div className="mb-1 flex items-center gap-1">
                            <PricingFieldChip field="minimum" />
                          </div>
                          <input
                            type="text"
                            inputMode="decimal"
                            aria-label={`Minimum Price for ${row.listingName}`}
                            className="w-full rounded-[9px] border bg-white px-2 py-1.5 text-[12px] font-semibold outline-none transition focus:border-[rgba(176,122,25,0.34)]"
                            style={{ borderColor: "rgba(180,143,54,0.2)", color: "var(--mustard-dark)" }}
                            value={rowPropertyDraft.minimumPriceOverride}
                            placeholder={formatCalendarOverrideInput(row.pricingAnchors.recommendedMinimumPrice) || "—"}
                            disabled={isRowSaving}
                            onChange={(event) => updateCalendarPropertyDraft(row.listingId, "minimumPriceOverride", event.target.value)}
                            onKeyDown={(event) => handleRowPropertyInputKeyDown(event, row, rowPropertyDraftDirty, isRowSaving)}
                          />
                          <div className="mt-1 flex items-center justify-between gap-1">
                            <span className="truncate text-[8px] font-medium" style={{ color: "var(--muted-text)" }}>
                              {ROOMY_RECOMMENDED_LABEL} {minimumAnchorState.recommendedValue}
                            </span>
                            {minimumAnchorState.isBlendedWithMarket ? <MiniBadge tone="blue">Adjusted</MiniBadge> : null}
                            {!minimumAnchorState.isBlendedWithMarket && minimumAnchorState.isManualOverride ? <MiniBadge tone="gold">Manual</MiniBadge> : null}
                          </div>
                          {minimumAnchorState.isBlendedWithMarket ? (
                            <div className="mt-1 truncate text-[8px] font-medium" style={{ color: "var(--muted-text)" }}>
                              Price used {minimumAnchorState.effectiveValue}
                            </div>
                          ) : null}
                        </div>
                      </td>
                      <td
                        className="sticky z-20 p-0 align-top shadow-[2px_0_0_rgba(228,234,240,0.9)]"
                        style={{ left: isMobileViewport ? undefined : `${desktopColumnLefts.base}px`, width: `${desktopColumnWidths.base}px`, minWidth: `${desktopColumnWidths.base}px` }}
                      >
                        <div
                          className="flex h-full flex-col justify-center border border-l-0 px-2.5 py-2"
                          style={{
                            width: `${desktopColumnWidths.base}px`,
                            height: `${DESKTOP_CALENDAR_ROW_HEIGHT}px`,
                            background: isSelectedRow ? "rgba(243, 249, 245, 0.98)" : "rgba(255,255,255,0.98)",
                            borderColor: isSelectedRow ? "rgba(22, 71, 51, 0.22)" : "var(--border)",
                            // solid bottom accent so Base reads as the anchor
                            // line — paired with Minimum's dashed line above.
                            borderBottom: "2px solid var(--green-dark)",
                            boxShadow: isSelectedRow ? "inset 0 0 0 1px rgba(22, 71, 51, 0.08), inset -1px 0 0 rgba(22, 71, 51, 0.08)" : undefined
                          }}
                        >
                          <div className="mb-1 flex items-center gap-1">
                            <PricingFieldChip field="base" />
                          </div>
                          <input
                            type="text"
                            inputMode="decimal"
                            aria-label={`Base Price for ${row.listingName}`}
                            className="w-full rounded-[9px] border bg-white px-2 py-1.5 text-[12px] font-semibold outline-none transition focus:border-[rgba(22,71,51,0.28)]"
                            style={{ borderColor: "rgba(22,71,51,0.16)", color: "var(--green-dark)" }}
                            value={rowPropertyDraft.basePriceOverride}
                            placeholder={formatCalendarOverrideInput(row.pricingAnchors.recommendedBasePrice) || "—"}
                            disabled={isRowSaving}
                            onChange={(event) => updateCalendarPropertyDraft(row.listingId, "basePriceOverride", event.target.value)}
                            onKeyDown={(event) => handleRowPropertyInputKeyDown(event, row, rowPropertyDraftDirty, isRowSaving)}
                          />
                          <div className="mt-1 flex items-center justify-between gap-1">
                            <span className="truncate text-[8px] font-medium" style={{ color: "var(--muted-text)" }}>
                              {ROOMY_RECOMMENDED_LABEL} {baseAnchorState.recommendedValue}
                            </span>
                            {baseAnchorState.isBlendedWithMarket ? <MiniBadge tone="blue">Adjusted</MiniBadge> : null}
                            {!baseAnchorState.isBlendedWithMarket && baseAnchorState.isManualOverride ? <MiniBadge tone="gold">Manual</MiniBadge> : null}
                          </div>
                          {baseAnchorState.isBlendedWithMarket ? (
                            <div className="mt-1 truncate text-[8px] font-medium" style={{ color: "var(--muted-text)" }}>
                              Price used {baseAnchorState.effectiveValue}
                            </div>
                          ) : null}
                        </div>
                      </td>
                      {row.cells.map((cell, cellIndex) => {
                        const palette = calendarCellCopy(cell.state, cell.demandBand);
                        const isSelectedCell = selectedCalendarCellKey === calendarCellSelectionKey(row.listingId, cell.date);
                        const primaryValue =
                          cell.state === "booked"
                            ? formatCompactCalendarPrice(cell.bookedRate, pricingCalendarReport.meta.displayCurrency)
                            : formatCompactCalendarPrice(cell.recommendedRate, pricingCalendarReport.meta.displayCurrency);
                        const demandStripOpacity = cell.state === "available" ? 0.18 + cell.demandBand * 0.1 : 0;
                        const secondaryLabel =
                          cell.state === "available"
                            ? cell.adjustmentPct !== null
                              ? `${cell.adjustmentPct > 0 ? "+" : ""}${Math.round(cell.adjustmentPct)}% vs Base Price`
                              : "Recommended"
                            : palette.label;
                        const minStayLabel = `${formatNightLabel(cell.minStay ?? 1)} min`;

                        return (
                          <td
                            key={`workspace-cell-${row.listingId}-${cell.date}`}
                            className="h-full p-0 align-stretch"
                            style={{
                              width: `${DESKTOP_CALENDAR_DAY_COLUMN_WIDTH}px`,
                              minWidth: `${DESKTOP_CALENDAR_DAY_COLUMN_WIDTH}px`,
                              maxWidth: `${DESKTOP_CALENDAR_DAY_COLUMN_WIDTH}px`,
                              height: `${DESKTOP_CALENDAR_ROW_HEIGHT}px`
                            }}
                          >
                            <button
                              type="button"
                              className={`relative flex h-full w-full overflow-hidden border px-1.5 py-1.5 text-left transition focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 ${
                                cellIndex > 0 ? "border-l-0" : ""
                              }`}
                              style={{
                                background: compactCellBackground(cell, palette),
                                borderColor: palette.border,
                                borderTopLeftRadius: 0,
                                borderBottomLeftRadius: 0,
                                borderTopRightRadius: 0,
                                borderBottomRightRadius: 0,
                                boxShadow: isSelectedCell ? "inset 0 0 0 2px rgba(22, 71, 51, 0.26)" : undefined
                              }}
                              aria-pressed={isSelectedCell}
                              aria-label={`${row.listingName} ${formatDisplayDate(cell.date)} ${palette.label}. ${cell.state === "booked" ? "Booked" : "Recommended"} ${primaryValue}`}
                              data-calendar-cell="true"
                              onClick={(event) => selectCalendarCell(row.listingId, cell.date, event.currentTarget)}
                              onFocus={(event) => selectCalendarCell(row.listingId, cell.date, event.currentTarget)}
                            >
                              {cell.state === "available" ? (
                                <div
                                  className="absolute inset-x-0 bottom-0 h-2"
                                  style={{ background: palette.accent, opacity: demandStripOpacity }}
                                />
                              ) : null}
                              <div
                                className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full"
                                style={{ background: palette.accent, opacity: cell.state === "booked" ? 0.55 : 0.85 }}
                              />
                              <div className="flex h-full w-full flex-col items-center justify-center text-center">
                                <div className="text-[15px] font-semibold leading-none" style={{ color: palette.accent }}>
                                  {primaryValue}
                                </div>
                                <div className="mt-1 text-[9px] font-medium leading-none" style={{ color: "var(--muted-text)" }}>
                                  {secondaryLabel}
                                </div>
                                <div className="mt-1 text-[9px] font-semibold leading-none" style={{ color: "var(--green-mid)" }}>
                                  {minStayLabel}
                                </div>
                              </div>
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div
            className="mt-2 border-t px-1 pt-2 transition-opacity"
            style={{
              borderColor: "rgba(53, 78, 104, 0.12)",
              opacity: calendarHasHorizontalOverflow ? 1 : 0,
              pointerEvents: calendarHasHorizontalOverflow ? "auto" : "none"
            }}
          >
            <div
              ref={calendarBottomScrollRef}
              className="overflow-x-auto overflow-y-hidden rounded-full border bg-white/90"
              style={{ borderColor: "var(--border)", scrollbarWidth: "thin" }}
            >
              <div ref={calendarBottomScrollContentRef} className="h-3 min-w-full" />
            </div>
          </div>
        </div>

      </div>

      {hasMounted && inspectorOpen && inspectorAnchorRect && typeof document !== "undefined" && typeof window !== "undefined"
        ? (() => {
            // Popup width clamps to viewport on small screens so the inspector
            // shows on mobile too (the same desktop table now renders on
            // mobile, so a single anchored popup is the right pattern at all
            // sizes). 540px on desktop, 92vw on mobile.
            const popupWidth = Math.min(DESKTOP_INSPECTOR_POPUP_WIDTH, Math.floor(window.innerWidth * 0.92));
            const popupMaxHeight = Math.min(
              DESKTOP_INSPECTOR_POPUP_MAX_HEIGHT,
              Math.floor(window.innerHeight * 0.85)
            );
            const placement = computeAnchoredPopupPosition(
              inspectorAnchorRect,
              { width: popupWidth, maxHeight: popupMaxHeight },
              { width: window.innerWidth, height: window.innerHeight }
            );
            return createPortal(
              <aside
                ref={inspectorAsideRef}
                className="fixed z-[1000] overflow-auto rounded-[16px] border bg-white shadow-2xl"
                role="dialog"
                aria-modal="false"
                aria-label="Pricing detail"
                style={{
                  top: placement.top,
                  left: placement.left,
                  width: popupWidth,
                  maxHeight: popupMaxHeight,
                  borderColor: "var(--border)"
                }}
              >
                <div ref={inspectorPanelRef} className="p-3.5">
                  <CalendarInspector
                    pricingCalendarReport={pricingCalendarReport}
                    row={selectedRow}
                    cell={selectedCell}
                    propertyDraft={activePropertyDraft}
                    propertyDraftDirty={activePropertyDraftDirty}
                    isPropertySaving={activePropertySaving}
                    isPropertyRefreshing={activePropertyRefreshing}
                    locationMissing={activeLocationMissing}
                    openCalendarSettingsPanel={openCalendarSettingsPanel}
                    handleSetCalendarPropertyQualityTier={handleSetCalendarPropertyQualityTier}
                    updateCalendarPropertyDraft={updateCalendarPropertyDraft}
                    handleSaveCalendarPropertyOverrides={handleSaveCalendarPropertyOverrides}
                    handleResetCalendarPropertyDraft={handleResetCalendarPropertyDraft}
                    handleRefreshCalendarListing={handleRefreshCalendarListing}
                    onCloseInspector={closeInspector}
                    formatCurrency={formatCurrency}
                    formatDisplayDate={formatDisplayDate}
                  />
                </div>
              </aside>,
              document.body
            );
          })()
        : null}

    </div>
  );
}
