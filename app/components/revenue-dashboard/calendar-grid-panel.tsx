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
const UPDATE_RECOMMENDED_PRICES_LABEL = "Update Recommended Prices";
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
  ) => void;
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
    <div className="space-y-4">
      <div className="rounded-[18px] border bg-white/94 p-4" style={{ borderColor: "var(--border)" }}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
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
                : "See what shaped this date, then adjust Base Price or Minimum Price if this property needs a different anchor."}
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
            >
              Open property settings
            </button>
            <button
              type="button"
              className="rounded-full border px-3 py-1.5 text-xs font-semibold"
              style={{ borderColor: "var(--border-strong)", color: "var(--navy-dark)" }}
              disabled={isPropertySaving || isPropertyRefreshing}
              onClick={() => handleRefreshCalendarListing(listingId)}
            >
              {isPropertyRefreshing ? "Refreshing" : UPDATE_RECOMMENDED_PRICES_LABEL}
            </button>
            <button
              type="button"
              aria-label="Close pricing detail"
              className="inline-flex h-8 w-8 items-center justify-center rounded-full border text-base font-semibold"
              style={{ borderColor: "var(--border-strong)", color: "var(--muted-text)" }}
              onClick={onCloseInspector}
            >
              ×
            </button>
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
              Property pricing
            </p>
            <p className="mt-1 text-sm leading-6" style={{ color: "var(--muted-text)" }}>
              These prices guide Roomy&apos;s future recommendations for this property.
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
  ) => void;
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
  const mobileSheetScrollRef = useRef<HTMLDivElement | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const [mobileFocusedListingId, setMobileFocusedListingId] = useState<string | null>(calendarVisibleRows[0]?.listingId ?? null);
  const [desktopColumnWidths, setDesktopColumnWidths] = useState(DEFAULT_DESKTOP_COLUMN_WIDTHS);
  const [hasMounted, setHasMounted] = useState(false);
  useEffect(() => {
    setHasMounted(true);
  }, []);

  useEffect(() => {
    if (selectedRow?.listingId) {
      setMobileFocusedListingId(selectedRow.listingId);
      return;
    }

    if (!calendarVisibleRows.some((row) => row.listingId === mobileFocusedListingId)) {
      setMobileFocusedListingId(calendarVisibleRows[0]?.listingId ?? null);
    }
  }, [calendarVisibleRows, mobileFocusedListingId, selectedRow?.listingId]);

  const mobileActiveRow =
    selectedRow ??
    calendarVisibleRows.find((candidate) => candidate.listingId === mobileFocusedListingId) ??
    calendarVisibleRows[0] ??
    null;
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
    // Reset scroll *inside* the inspector containers — never scroll the page.
    // The inspector itself is anchored to the viewport (sticky on desktop,
    // fixed bottom-sheet on mobile), so the user keeps the cell they tapped
    // visually anchored where it was.
    inspectorAsideRef.current?.scrollTo({ top: 0, behavior: "auto" });
    mobileSheetScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [selectedCell, selectedRow?.listingId]);

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  // While the mobile bottom sheet is open we lock body scroll so the user can
  // scroll the sheet contents without the underlying calendar moving.
  useEffect(() => {
    if (!inspectorOpen || typeof document === "undefined") return;
    const isMobile = typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches;
    if (!isMobile) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [inspectorOpen]);

  function selectCalendarCell(listingId: string, date: string) {
    setMobileFocusedListingId(listingId);
    setSelectedCalendarCellKey(calendarCellSelectionKey(listingId, date));
    // Deliberately no page scroll. The inspector opens in-place (desktop column
    // sticky / mobile bottom sheet) so the user never loses the cell they
    // tapped from view.
  }

  function focusProperty(listingId: string) {
    setMobileFocusedListingId(listingId);
    if (selectedRow?.listingId !== listingId) {
      setSelectedCalendarCellKey(null);
    }
  }

  function closeInspector() {
    setSelectedCalendarCellKey(null);
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
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[18px] border bg-white/64 p-2" style={{ borderColor: "var(--border)" }}>
      <div className={`hidden min-h-0 flex-1 lg:grid ${inspectorOpen ? "lg:grid-cols-[minmax(0,1fr)_460px]" : "lg:grid-cols-[minmax(0,1fr)]"} lg:gap-3`}>
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
                      left: `${desktopColumnLefts.market}px`,
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
                      left: `${desktopColumnLefts.minimum}px`,
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
                      left: `${desktopColumnLefts.base}px`,
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
                              onClick={() => {
                                if (rowPrimaryCell) {
                                  selectCalendarCell(row.listingId, rowPrimaryCell.date);
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
                        style={{ left: `${desktopColumnLefts.market}px`, width: `${desktopColumnWidths.market}px`, minWidth: `${desktopColumnWidths.market}px` }}
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
                        style={{ left: `${desktopColumnLefts.minimum}px`, width: `${desktopColumnWidths.minimum}px`, minWidth: `${desktopColumnWidths.minimum}px` }}
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
                        style={{ left: `${desktopColumnLefts.base}px`, width: `${desktopColumnWidths.base}px`, minWidth: `${desktopColumnWidths.base}px` }}
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
                              onClick={() => selectCalendarCell(row.listingId, cell.date)}
                              onFocus={() => selectCalendarCell(row.listingId, cell.date)}
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

        {inspectorOpen ? (
          <aside
            ref={inspectorAsideRef}
            // The inspector lives in a fixed-height grid column whose parent is
            // already a viewport-bound flex container (calendar workspace
            // shell), so the aside itself owns its own scroll and stays in
            // view as the user scrolls the calendar table next to it. No
            // `sticky` needed: the column height is bounded by the workspace
            // section, not by document height.
            className="min-h-0 overflow-auto rounded-[16px] border bg-white/90 p-3.5"
            style={{ borderColor: "var(--border)" }}
          >
            <div ref={inspectorPanelRef}>
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
          </aside>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto lg:hidden">
        <div className="space-y-3">
          <div className="rounded-[16px] border bg-white/92 p-4" style={{ borderColor: "var(--border)" }}>
            <label className="block text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--muted-text)" }}>
              Property
              <select
                className="mt-2 w-full rounded-[14px] border bg-white px-3 py-3 text-sm outline-none"
                style={{ borderColor: "var(--border)" }}
                value={mobileActiveRow?.listingId ?? ""}
                onChange={(event) => focusProperty(event.target.value)}
              >
                {calendarVisibleRows.map((row) => (
                  <option key={`mobile-calendar-row-${row.listingId}`} value={row.listingId}>
                    {row.listingName}
                  </option>
                ))}
              </select>
            </label>
            {mobileActiveRow ? (
              <div className="mt-3 flex items-center justify-end">
                <button
                  type="button"
                  className="rounded-full border px-3 py-1.5 text-xs font-semibold"
                  style={{ borderColor: "var(--border-strong)", color: "var(--navy-dark)" }}
                  disabled={refreshingCalendarListingIds.includes(mobileActiveRow.listingId)}
                  onClick={() => handleRefreshCalendarListing(mobileActiveRow.listingId)}
                >
                  {refreshingCalendarListingIds.includes(mobileActiveRow.listingId) ? "Refreshing" : UPDATE_RECOMMENDED_PRICES_LABEL}
                </button>
              </div>
            ) : null}
            {mobileActiveRow ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {mobileActiveRow.marketDataStatus !== "cached_market_data" ? (
                  <span className="rounded-full px-2.5 py-1 text-[10px] font-semibold" style={pricingMarketDataStatusTone(mobileActiveRow.marketDataStatus)}>
                    {shortMarketStatusLabel(mobileActiveRow.marketDataStatus)}
                  </span>
                ) : null}
                <span
                  className="rounded-full border bg-white/78 px-2.5 py-1 text-[10px] font-semibold"
                  style={{ borderColor: "var(--border)", color: "var(--muted-text)" }}
                >
                  {mobileActiveRow.marketLabel ?? "Location needed"}
                </span>
              </div>
            ) : null}
          </div>

          {!inspectorOpen ? (
            <div className="rounded-[16px] border border-dashed bg-white/76 px-4 py-4 text-sm" style={{ borderColor: "var(--border-strong)", color: "var(--muted-text)" }}>
              Tap a date below to see why we recommended that price.
            </div>
          ) : null}

          {mobileActiveRow ? (
            <div className="rounded-[16px] border bg-white/92 p-3" style={{ borderColor: "var(--border)" }}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--muted-text)" }}>
                    Month view
                  </p>
                  <p className="mt-1 text-sm" style={{ color: "var(--muted-text)" }}>
                    One property at a time on mobile.
                  </p>
                </div>
              </div>
              <div className="mt-3 space-y-2">
                {mobileActiveRow.cells.map((cell) => {
                  const palette = calendarCellCopy(cell.state, cell.demandBand);
                  const isSelectedCell = selectedCalendarCellKey === calendarCellSelectionKey(mobileActiveRow.listingId, cell.date);
                  const primaryValue =
                    cell.state === "booked"
                      ? formatCompactCalendarPrice(cell.bookedRate, pricingCalendarReport.meta.displayCurrency)
                      : formatCompactCalendarPrice(cell.recommendedRate, pricingCalendarReport.meta.displayCurrency);

                  return (
                    <button
                      key={`mobile-calendar-cell-${mobileActiveRow.listingId}-${cell.date}`}
                      type="button"
                      className="w-full rounded-[14px] border px-3 py-3 text-left"
                      style={{
                        borderColor: isSelectedCell ? "rgba(22,71,51,0.22)" : palette.border,
                        background: isSelectedCell ? "rgba(22,71,51,0.05)" : compactCellBackground(cell, palette)
                      }}
                      onClick={() => selectCalendarCell(mobileActiveRow.listingId, cell.date)}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold">{formatDisplayDate(cell.date)}</div>
                          <div className="mt-1 text-[12px]" style={{ color: "var(--muted-text)" }}>
                            {palette.label}
                            {cell.state === "available" ? ` · ${calendarCellCopy("available", cell.demandBand).summary}` : ""}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-sm font-semibold" style={{ color: palette.accent }}>
                            {primaryValue}
                          </div>
                          <div className="mt-1 text-[12px]" style={{ color: "var(--muted-text)" }}>
                            {cell.liveRate !== null ? `Current ${formatCompactCalendarPrice(cell.liveRate, pricingCalendarReport.meta.displayCurrency)}` : " "}
                          </div>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {hasMounted && inspectorOpen && typeof document !== "undefined"
        ? createPortal(
            <div
              className="fixed inset-0 z-[1000] flex flex-col justify-end lg:hidden"
              role="dialog"
              aria-modal="true"
              aria-label="Pricing detail"
            >
              <button
                type="button"
                aria-label="Close pricing detail"
                className="absolute inset-0 cursor-default bg-black/40"
                onClick={closeInspector}
              />
              <div
                className="relative max-h-[90vh] overflow-hidden rounded-t-[22px] border-t bg-white shadow-2xl"
                style={{ borderColor: "var(--border)" }}
              >
                <div className="flex items-center justify-between gap-2 border-b px-4 py-3" style={{ borderColor: "var(--border)" }}>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-semibold"
                    style={{ borderColor: "var(--border-strong)", color: "var(--navy-dark)" }}
                    onClick={closeInspector}
                  >
                    Back to calendar
                  </button>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--muted-text)" }}>
                    Pricing detail · read-only
                  </div>
                </div>
                <div ref={mobileSheetScrollRef} className="max-h-[calc(90vh-50px)] overflow-y-auto px-4 py-4">
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
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
