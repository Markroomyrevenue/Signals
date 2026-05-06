"use client";

import { useEffect, useState, type ReactNode } from "react";

type DrawerView = "settings" | "pricing";

export type PropertySettingsDrawerProps = {
  open: boolean;
  /** The listing whose drawer is open. Drives the header + close behaviour. */
  listingId: string | null;
  listingName: string | null;
  hostawayId?: string | null;
  /** Composed content for the editable settings view (e.g. the full
   *  CalendarSettingsPanel scoped to this listing). */
  settingsContent: ReactNode;
  /** Composed content for the read-only pricing-details view (e.g. the
   *  CalendarInspector breakdown for this listing's primary cell). */
  pricingDetailsContent: ReactNode;
  onClose: () => void;
};

/**
 * Right-side drawer that mirrors the cell-override drawer but holds the
 * full per-listing settings UI. Two views via a clear segmented control
 * in the header:
 *   - Settings (default) — the editable CalendarSettingsPanel scoped to
 *     this listing (base/min, occupancy, demand, seasonality, etc.).
 *   - Pricing details — the read-only CalendarInspector breakdown for
 *     the listing's primary cell.
 *
 * Both contents are mounted at the same time and toggled via CSS on
 * `data-property-drawer-view`, so switching between them is instant
 * and preserves any in-flight form state.
 */
export function PropertySettingsDrawer(props: PropertySettingsDrawerProps) {
  const { open, listingId, listingName } = props;
  const [view, setView] = useState<DrawerView>("settings");

  useEffect(() => {
    if (!open) return;
    setView("settings");
    function handler(e: KeyboardEvent) {
      if (e.key === "Escape") props.onClose();
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, props]);

  if (!open || !listingId || !listingName) return null;

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
          width: "min(960px, 100vw)",
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
            gap: 12,
            flexShrink: 0
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2 id="property-settings-drawer-title" style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
              {listingName}
            </h2>
            {props.hostawayId ? (
              <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--muted-text, #6b7280)", fontFamily: "monospace" }}>
                #{props.hostawayId}
              </p>
            ) : null}
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

        {/* View toggle: clear segmented control. Defaults to Settings on open. */}
        <div
          role="tablist"
          aria-label="Property drawer view"
          style={{
            margin: "12px 24px 0",
            display: "inline-flex",
            border: "1px solid var(--border, #e5e7eb)",
            borderRadius: 999,
            padding: 3,
            background: "var(--surface, #f3f4f6)",
            alignSelf: "flex-start",
            flexShrink: 0
          }}
        >
          <button
            type="button"
            role="tab"
            aria-selected={view === "settings"}
            onClick={() => setView("settings")}
            style={{
              padding: "5px 14px",
              fontSize: 12,
              fontWeight: 600,
              border: "none",
              borderRadius: 999,
              cursor: "pointer",
              background: view === "settings" ? "white" : "transparent",
              color: view === "settings" ? "var(--navy-dark, #0f172a)" : "var(--muted-text, #6b7280)",
              boxShadow: view === "settings" ? "0 1px 2px rgba(15, 23, 42, 0.08)" : "none"
            }}
          >
            Settings
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "pricing"}
            onClick={() => setView("pricing")}
            style={{
              padding: "5px 14px",
              fontSize: 12,
              fontWeight: 600,
              border: "none",
              borderRadius: 999,
              cursor: "pointer",
              background: view === "pricing" ? "white" : "transparent",
              color: view === "pricing" ? "var(--navy-dark, #0f172a)" : "var(--muted-text, #6b7280)",
              boxShadow: view === "pricing" ? "0 1px 2px rgba(15, 23, 42, 0.08)" : "none"
            }}
          >
            Pricing details
          </button>
        </div>

        <div data-property-drawer-view={view} style={{ overflowY: "auto", flex: 1, padding: 16 }}>
          <div data-inspector-section="settings">{props.settingsContent}</div>
          <div data-inspector-section="pricing-details">{props.pricingDetailsContent}</div>
        </div>
      </aside>
    </>
  );
}
