"use client";

import { useEffect, useState } from "react";

import { withBasePath } from "@/lib/base-path";

/**
 * Modal opened when a user clicks a single date cell on the pricing
 * calendar. Shows the current recommendation breakdown and lets the user
 * create / edit / remove a manual override.
 *
 * Auto-supersede on overlap is server-side; the response includes a
 * summary (`superseded.summary`) for "this will replace 2 existing
 * overrides…". We surface that as a confirmation step before saving.
 */

export type PricingCellModalListing = {
  id: string;
  name: string;
};

export type PricingCellModalCell = {
  date: string; // dateOnly
  recommendedRate: number | null;
  dynamicRateBeforeOverride: number | null;
  manualOverride: {
    id: string;
    type: "fixed" | "percentage_delta";
    value: number;
    notes: string | null;
    startDate: string;
    endDate: string;
  } | null;
  breakdown: Array<{
    label: string;
    amount: number | null;
    unit: "currency" | "percent" | "number" | "multiplier";
  }>;
};

type Props = {
  listing: PricingCellModalListing;
  cell: PricingCellModalCell;
  onClose: () => void;
  /** Called after a successful save / delete so the parent can refresh. */
  onChanged: () => void;
};

type SuperseededSummary = { summary: string };

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(withBasePath(url), init);
  const body = (await response.json().catch(() => ({}))) as { error?: string } & T;
  if (!response.ok) {
    throw new Error(body.error ?? "Request failed");
  }
  return body;
}

function formatBreakdown(item: PricingCellModalCell["breakdown"][number]): string {
  if (item.amount === null) return "—";
  switch (item.unit) {
    case "currency":
      return `£${item.amount.toFixed(2)}`;
    case "percent":
      return `${item.amount.toFixed(1)}%`;
    case "multiplier":
      return `×${item.amount.toFixed(3)}`;
    default:
      return String(item.amount);
  }
}

export default function PricingCalendarCellModal({ listing, cell, onClose, onChanged }: Props) {
  const existing = cell.manualOverride;
  const [startDate, setStartDate] = useState(existing?.startDate ?? cell.date);
  const [endDate, setEndDate] = useState(existing?.endDate ?? cell.date);
  const [overrideType, setOverrideType] = useState<"fixed" | "percentage_delta">(
    existing?.type ?? "percentage_delta"
  );
  const [overrideValueText, setOverrideValueText] = useState<string>(
    existing
      ? existing.type === "fixed"
        ? String(existing.value)
        : String(existing.value * 100)
      : ""
  );
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function save(force: boolean) {
    setError(null);
    setSaving(true);

    const numericValue = Number(overrideValueText);
    if (!Number.isFinite(numericValue)) {
      setError("Override value must be a number.");
      setSaving(false);
      return;
    }
    if (overrideType === "fixed" && numericValue <= 0) {
      setError("Fixed-price override must be > 0.");
      setSaving(false);
      return;
    }
    const persistedValue = overrideType === "fixed" ? numericValue : numericValue / 100;
    if (overrideType === "percentage_delta" && (persistedValue < -0.5 || persistedValue > 1.0)) {
      setError("Percentage adjustment must be between -50 and +100.");
      setSaving(false);
      return;
    }

    try {
      // Pre-flight overlap check by hitting the listing's overrides for the
      // proposed range; if any exist we present the supersede summary as a
      // confirmation step. Server-side does its own transactional check
      // regardless, so this is purely UX.
      if (!force) {
        const existingForRange = await fetchJson<{
          overrides: Array<{
            id: string;
            startDate: string;
            endDate: string;
            overrideType: string;
            overrideValue: number;
          }>;
        }>(
          `/api/pricing/overrides?listingId=${encodeURIComponent(listing.id)}&from=${encodeURIComponent(
            startDate
          )}&to=${encodeURIComponent(endDate)}`
        );
        const overlapping = existingForRange.overrides.filter(
          (o) => o.id !== existing?.id
        );
        if (overlapping.length > 0) {
          const desc = overlapping
            .map((o) =>
              o.startDate === o.endDate
                ? `${o.startDate} (${o.overrideType === "fixed" ? "FIXED" : "%"})`
                : `${o.startDate}–${o.endDate} (${o.overrideType === "fixed" ? "FIXED" : "%"})`
            )
            .join("; ");
          setConfirmation(`This will replace ${overlapping.length} existing override(s): ${desc}.`);
          setSaving(false);
          return;
        }
      }

      if (existing) {
        // Edit path: PATCH with the new range / type / value / notes. If the
        // range expanded into other overrides the server auto-supersedes.
        await fetchJson(`/api/pricing/overrides/${existing.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            startDate,
            endDate,
            overrideType,
            overrideValue: persistedValue,
            notes
          })
        });
      } else {
        await fetchJson("/api/pricing/overrides", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            listingId: listing.id,
            startDate,
            endDate,
            overrideType,
            overrideValue: persistedValue,
            notes
          })
        });
      }
      setSaving(false);
      onChanged();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
      setSaving(false);
    }
  }

  async function remove() {
    if (!existing) return;
    setRemoving(true);
    setError(null);
    try {
      await fetchJson(`/api/pricing/overrides/${existing.id}`, { method: "DELETE" });
      onChanged();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Remove failed");
      setRemoving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl border bg-white p-5"
        style={{ borderColor: "var(--border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between">
          <h3 className="font-display text-base">
            {listing.name} · {cell.date}
          </h3>
          <button onClick={onClose} className="text-xs underline">
            Close
          </button>
        </div>

        <section className="mt-3">
          <div className="text-xs font-semibold uppercase" style={{ color: "var(--muted-text)" }}>
            Current recommendation
          </div>
          {cell.breakdown.length === 0 ? (
            <p className="mt-1 text-sm" style={{ color: "var(--muted-text)" }}>
              No recommendation for this date.
            </p>
          ) : (
            <ul className="mt-1 text-xs">
              {cell.breakdown.map((item, idx) => (
                <li key={idx} className="flex justify-between">
                  <span>{item.label}</span>
                  <span>{formatBreakdown(item)}</span>
                </li>
              ))}
            </ul>
          )}
          {cell.dynamicRateBeforeOverride !== null && existing !== null ? (
            <p className="mt-1 text-xs" style={{ color: "var(--muted-text)" }}>
              Dynamic rate (without override): £{cell.dynamicRateBeforeOverride.toFixed(2)}
            </p>
          ) : null}
        </section>

        <section className="mt-4 border-t pt-3" style={{ borderColor: "var(--border)" }}>
          <div className="flex items-baseline justify-between">
            <div className="text-xs font-semibold uppercase" style={{ color: "var(--muted-text)" }}>
              Override
            </div>
            {existing ? (
              <button
                onClick={() => void remove()}
                disabled={removing}
                className="text-xs font-semibold underline disabled:opacity-50"
                style={{ color: "var(--red-dark, #b91c1c)" }}
              >
                {removing ? "Removing…" : "Remove override"}
              </button>
            ) : null}
          </div>

          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="text-xs">
              <span className="text-xs font-semibold uppercase" style={{ color: "var(--muted-text)" }}>
                Start date
              </span>
              <input
                type="date"
                className="mt-1 w-full rounded-xl border bg-white px-2 py-1.5 text-sm outline-none"
                style={{ borderColor: "var(--border)" }}
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </label>
            <label className="text-xs">
              <span className="text-xs font-semibold uppercase" style={{ color: "var(--muted-text)" }}>
                End date
              </span>
              <input
                type="date"
                className="mt-1 w-full rounded-xl border bg-white px-2 py-1.5 text-sm outline-none"
                style={{ borderColor: "var(--border)" }}
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </label>
          </div>

          <div className="mt-3 flex items-center gap-3 text-xs">
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name="override-type"
                checked={overrideType === "fixed"}
                onChange={() => setOverrideType("fixed")}
              />
              Fixed price (£)
            </label>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name="override-type"
                checked={overrideType === "percentage_delta"}
                onChange={() => setOverrideType("percentage_delta")}
              />
              Percentage adjustment (%)
            </label>
          </div>

          <input
            type="number"
            className="mt-2 w-full rounded-xl border bg-white px-3 py-2 text-sm outline-none"
            style={{ borderColor: "var(--border)" }}
            placeholder={overrideType === "fixed" ? "Fixed price (e.g. 85)" : "Percentage (e.g. -10 for −10%)"}
            value={overrideValueText}
            onChange={(e) => setOverrideValueText(e.target.value)}
          />
          <p className="mt-1 text-xs" style={{ color: "var(--muted-text)" }}>
            {overrideType === "fixed"
              ? "This price will replace the recommendation for the entire range. Minimum floor does NOT apply — set carefully."
              : "This applies on top of the dynamic recommendation. Minimum floor still applies. Allowed: -50 to +100."}
          </p>

          <textarea
            className="mt-3 w-full rounded-xl border bg-white px-3 py-2 text-sm outline-none"
            style={{ borderColor: "var(--border)" }}
            rows={2}
            placeholder="Notes (optional)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />

          {confirmation ? (
            <div className="mt-3 rounded-xl border p-2 text-xs" style={{ borderColor: "var(--border)" }}>
              {confirmation}
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => void save(true)}
                  className="rounded-full px-3 py-1 text-xs font-semibold text-white"
                  style={{ background: "var(--green-dark)" }}
                >
                  Confirm replace
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmation(null)}
                  className="text-xs underline"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          {error ? (
            <p className="mt-2 text-xs" style={{ color: "var(--red-dark, #b91c1c)" }}>
              {error}
            </p>
          ) : null}

          {!confirmation ? (
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => void save(false)}
                disabled={saving}
                className="rounded-full px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                style={{ background: "var(--green-dark)" }}
              >
                {saving ? "Saving…" : existing ? "Save override" : "Create override"}
              </button>
              <button type="button" onClick={onClose} className="text-xs underline">
                Cancel
              </button>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
