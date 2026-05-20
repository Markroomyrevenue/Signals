"use client";

import { useEffect, type ReactNode } from "react";

export type PropertySettingsDrawerProps = {
  open: boolean;
  /** The listing whose drawer is open. Drives the header + close behaviour. */
  listingId: string | null;
  listingName: string | null;
  hostawayId?: string | null;
  /** Composed content for the editable settings view (the full
   *  CalendarSettingsPanel scoped to this listing). */
  settingsContent: ReactNode;
  onClose: () => void;
};

/**
 * Right-side drawer that opens when the user clicks a listing's name
 * in the calendar's leftmost column. Hosts the FULL editable
 * CalendarSettingsPanel for that listing (scope nav locked to
 * "property", all sections accessible — Base & Min, Occupancy, Demand,
 * Seasonality, Day Of Week, Safety Net, Local Events, Last Minute,
 * Multi-Unit, Stay Rules).
 *
 * No pricing-details toggle here — the per-date drawer is the right
 * surface for "why this date's price?". This drawer is only for
 * editing the listing's settings.
 */
export function PropertySettingsDrawer(props: PropertySettingsDrawerProps) {
  const { open, listingId, listingName } = props;

  useEffect(() => {
    if (!open) return;
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
            <p style={{ margin: 0, fontSize: 11, fontWeight: 600, letterSpacing: 0.5, textTransform: "uppercase", color: "var(--muted-text, #6b7280)" }}>
              Property settings
            </p>
            <h2 id="property-settings-drawer-title" style={{ margin: "4px 0 0", fontSize: 16, fontWeight: 600 }}>
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

        <div style={{ overflowY: "auto", flex: 1, padding: 16 }}>{props.settingsContent}</div>
      </aside>
    </>
  );
}
