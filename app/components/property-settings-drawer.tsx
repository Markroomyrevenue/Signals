"use client";

import { useEffect } from "react";

import type { CalendarPropertyDraft, PricingCalendarRow } from "./revenue-dashboard/calendar-utils";
import { CalendarInspector } from "./revenue-dashboard/calendar-grid-panel";
import type { PricingCalendarResponse } from "@/lib/reports/pricing-calendar-types";

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
  | "multi_unit"
  | "stay_rules";

export type PropertySettingsDrawerProps = {
  open: boolean;
  /** The row whose settings are being edited. */
  row: PricingCalendarRow | null;
  /** The cell to use as inspector context (typically the row's primary cell). */
  cell: PricingCalendarRow["cells"][number] | null;
  pricingCalendarReport: PricingCalendarResponse | null;
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
  handleSetCalendarPropertyHostawayPushEnabled: (
    listingId: string,
    enabled: boolean
  ) => Promise<void> | void;
  updateCalendarPropertyDraft: (
    listingId: string,
    field: keyof CalendarPropertyDraft,
    value: string
  ) => void;
  handleSaveCalendarPropertyOverrides: (listingId: string) => Promise<void> | void;
  handleResetCalendarPropertyDraft: (row: PricingCalendarRow) => void;
  handleRefreshCalendarListing: (listingId: string) => void;
  formatCurrency: (value: number, currency: string) => string;
  formatDisplayDate: (dateOnly: string) => string;
  onClose: () => void;
};

/**
 * Right-side drawer that mirrors the cell-override drawer but holds the
 * existing CalendarInspector content. Opens when the user clicks a
 * listing's name in the calendar's leftmost column. The inspector
 * already has the property-settings editing UI (quality tier, base /
 * minimum overrides, Hostaway push toggle, refresh button); we just
 * re-mount it inside a slide-in drawer instead of the anchored popup.
 */
export function PropertySettingsDrawer(props: PropertySettingsDrawerProps) {
  const { open, row, cell } = props;

  useEffect(() => {
    if (!open) return;
    function handler(e: KeyboardEvent) {
      if (e.key === "Escape") props.onClose();
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, props]);

  if (!open || !row || !cell || !props.pricingCalendarReport) return null;

  return (
    <>
      <div
        onClick={props.onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(15, 23, 42, 0.35)",
          zIndex: 1000,
          cursor: "pointer"
        }}
        aria-hidden="true"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="property-settings-drawer-title"
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: "min(560px, 100vw)",
          background: "white",
          zIndex: 1001,
          boxShadow: "-12px 0 32px rgba(15, 23, 42, 0.18)",
          display: "flex",
          flexDirection: "column",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          color: "var(--navy-dark, #0f172a)"
        }}
      >
        <header
          style={{
            padding: "20px 24px 16px",
            borderBottom: "1px solid var(--border, #e5e7eb)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 12
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2 id="property-settings-drawer-title" style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
              Property settings
            </h2>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--muted-text, #6b7280)" }}>
              <strong style={{ color: "var(--navy-dark, #0f172a)" }}>{row.listingName}</strong>
              {row.hostawayId ? (
                <span style={{ marginLeft: 8, fontFamily: "monospace", fontSize: 12 }}>
                  #{row.hostawayId}
                </span>
              ) : null}
            </p>
          </div>
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Close"
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              fontSize: 24,
              lineHeight: 1,
              padding: 0,
              color: "var(--muted-text, #6b7280)"
            }}
          >
            ×
          </button>
        </header>

        <div style={{ overflowY: "auto", flex: 1, padding: 16 }}>
          <CalendarInspector
            pricingCalendarReport={props.pricingCalendarReport}
            row={row}
            cell={cell}
            propertyDraft={props.propertyDraft}
            propertyDraftDirty={props.propertyDraftDirty}
            isPropertySaving={props.isPropertySaving}
            isPropertyRefreshing={props.isPropertyRefreshing}
            locationMissing={props.locationMissing}
            openCalendarSettingsPanel={(scope, section, options) => {
              // Closing the drawer ahead of opening the full settings page
              // avoids a stacked dialog flash when the user navigates away.
              props.onClose();
              props.openCalendarSettingsPanel(scope, section, options);
            }}
            handleSetCalendarPropertyQualityTier={props.handleSetCalendarPropertyQualityTier}
            handleSetCalendarPropertyHostawayPushEnabled={props.handleSetCalendarPropertyHostawayPushEnabled}
            updateCalendarPropertyDraft={props.updateCalendarPropertyDraft}
            handleSaveCalendarPropertyOverrides={props.handleSaveCalendarPropertyOverrides}
            handleResetCalendarPropertyDraft={props.handleResetCalendarPropertyDraft}
            handleRefreshCalendarListing={props.handleRefreshCalendarListing}
            onCloseInspector={props.onClose}
            formatCurrency={props.formatCurrency}
            formatDisplayDate={props.formatDisplayDate}
          />
        </div>
      </aside>
    </>
  );
}
