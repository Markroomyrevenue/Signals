"use client";

import { useEffect, useMemo, useState } from "react";

export type CellOverrideDrawerTarget = {
  listingId: string;
  listingName: string;
  /** ISO date `YYYY-MM-DD` of the clicked cell. */
  date: string;
  /** Existing override on this listing × date, if any (so the drawer
   *  can open in "edit existing" mode). */
  existingOverride?: {
    id: string;
    type: "fixed" | "percentage_delta";
    value: number;
    minStay: number | null;
    notes: string | null;
    startDate: string;
    endDate: string;
  } | null;
  /** Optional dynamic recommendation for the clicked date — surfaced as
   *  a read-only "Current recommendation" line so the user has context
   *  while writing the override. */
  currentRecommendation?: number | null;
  currentMinimum?: number | null;
  /** Cell pricing breakdown rows — `{ label, amount, unit }` triples
   *  from the calendar API. Rendered in the drawer's "Pricing details"
   *  view so the user can see the logic behind the date's price
   *  without leaving the override form. */
  cellBreakdown?: Array<{ label: string; amount: number | null; unit: "currency" | "percent" | "number" | "multiplier" }>;
  /** Booked rate for this date when the cell state is "booked" — shown
   *  alongside the breakdown for context. */
  bookedRate?: number | null;
  /** Cell state — drives the breakdown header copy. */
  cellState?: "booked" | "available" | "unavailable" | "unknown";
  /** The current live rate on Hostaway for this date — surfaced in the
   *  Pricing details view as a side-by-side comparison vs Signals'
   *  recommendation. Null when Hostaway hasn't synced a rate for the
   *  date or the listing isn't connected. */
  hostawayLiveRate?: number | null;
};

export type CellOverrideDrawerProps = {
  open: boolean;
  target: CellOverrideDrawerTarget | null;
  onClose: () => void;
  /** Called after a successful save / remove so the parent can refresh
   *  the calendar to reflect the new state. */
  onChanged?: () => void;
};

type OverrideType = "fixed" | "percentage_delta";

const PERCENT_MIN = -50;
const PERCENT_MAX = 100;

function asPercentString(decimal: number): string {
  return String(Math.round(decimal * 100));
}

function asFixedString(amount: number): string {
  return String(Math.round(amount));
}

type DrawerView = "override" | "pricing";

export function CellOverrideDrawer(props: CellOverrideDrawerProps) {
  const { target, open } = props;
  const existing = target?.existingOverride ?? null;

  const [view, setView] = useState<DrawerView>("override");
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");
  const [overrideType, setOverrideType] = useState<OverrideType>("percentage_delta");
  const [valueStr, setValueStr] = useState<string>("");
  const [minStayStr, setMinStayStr] = useState<string>("");
  const [notes, setNotes] = useState<string>("");

  const [submitting, setSubmitting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Reset form whenever a new target is loaded
  useEffect(() => {
    if (!open || !target) return;
    setView("override");
    if (existing) {
      setStartDate(existing.startDate);
      setEndDate(existing.endDate);
      setOverrideType(existing.type);
      setValueStr(
        existing.type === "fixed" ? asFixedString(existing.value) : asPercentString(existing.value)
      );
      setMinStayStr(existing.minStay !== null ? String(existing.minStay) : "");
      setNotes(existing.notes ?? "");
    } else {
      setStartDate(target.date);
      setEndDate(target.date);
      setOverrideType("percentage_delta");
      setValueStr("");
      setMinStayStr("");
      setNotes("");
    }
    setError(null);
    setSuccess(null);
    // Reset only when the user opens a *different* cell — using primitive
    // identity for target + existing keeps in-progress edits from being
    // wiped on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, target?.listingId, target?.date, existing?.id]);

  // Close on Escape key
  useEffect(() => {
    if (!open) return;
    function handler(e: KeyboardEvent) {
      if (e.key === "Escape") props.onClose();
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, props]);

  const valueParsed = useMemo<number | null>(() => {
    const n = Number(valueStr);
    if (!Number.isFinite(n)) return null;
    if (overrideType === "fixed") return n;
    return n / 100; // percent input is in whole percent (e.g. -10 → -0.10)
  }, [valueStr, overrideType]);

  const minStayParsed = useMemo<number | null | "invalid">(() => {
    if (minStayStr.trim().length === 0) return null as number | null | "invalid";
    const n = Number(minStayStr);
    if (!Number.isFinite(n) || n < 1 || n > 30) return "invalid" as number | null | "invalid";
    return Math.round(n) as number | null | "invalid";
  }, [minStayStr]);

  const valid =
    !!target &&
    /^\d{4}-\d{2}-\d{2}$/.test(startDate) &&
    /^\d{4}-\d{2}-\d{2}$/.test(endDate) &&
    startDate <= endDate &&
    valueParsed !== null &&
    (overrideType === "fixed"
      ? valueParsed > 0
      : valueParsed >= PERCENT_MIN / 100 && valueParsed <= PERCENT_MAX / 100) &&
    (minStayParsed as unknown) !== "invalid" &&
    !submitting &&
    !removing;

  async function handleSave(pushAfterSave: boolean) {
    if (!valid || !target || valueParsed === null || (minStayParsed as unknown) === "invalid") return;
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/pricing/overrides", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          listingIds: [target.listingId],
          startDate,
          endDate,
          overrideType,
          overrideValue: valueParsed,
          minStay: minStayParsed,
          notes: notes.trim().length > 0 ? notes.trim() : null
        })
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Save failed (${res.status}): ${body.slice(0, 300)}`);
      }
      const data = (await res.json()) as {
        results: Array<{ created: { id: string } | null; superseded: { mutations: unknown[] } | null; error: string | null }>;
      };
      const r = data.results[0];
      if (r?.error) throw new Error(r.error);
      const supersededCount = r?.superseded?.mutations.length ?? 0;
      const savedMessage =
        supersededCount > 0
          ? `Saved. Replaced ${supersededCount} overlapping override${supersededCount === 1 ? "" : "s"}.`
          : "Saved.";

      if (!pushAfterSave) {
        setSuccess(savedMessage);
        props.onChanged?.();
        setTimeout(() => props.onClose(), 1100);
        return;
      }

      // Push ONLY the overridden date range to Hostaway, so the change
      // lands live immediately instead of waiting for the next scheduled
      // push. Server-side guards (push toggle, allowlist) still apply.
      setSuccess(`${savedMessage} Pushing ${startDate === endDate ? startDate : `${startDate} – ${endDate}`} to Hostaway…`);
      const pushRes = await fetch("/api/hostaway/push-rates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          listingId: target.listingId,
          dateFrom: startDate,
          dateTo: endDate,
          dryRun: false
        })
      });
      const pushData = (await pushRes.json().catch(() => ({}))) as {
        ok?: boolean;
        pushedCount?: number;
        errorMessage?: string;
        error?: string;
      };
      if (!pushRes.ok || pushData.ok === false) {
        const detail = pushData.errorMessage ?? pushData.error ?? `HTTP ${pushRes.status}`;
        setSuccess(null);
        setError(`Override saved, but the Hostaway push failed: ${detail}`);
        props.onChanged?.();
        return;
      }
      setSuccess(`${savedMessage} Pushed ${pushData.pushedCount ?? 0} date${(pushData.pushedCount ?? 0) === 1 ? "" : "s"} to Hostaway.`);
      props.onChanged?.();
      setTimeout(() => props.onClose(), 1600);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRemove() {
    if (!existing) return;
    setRemoving(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch(`/api/pricing/overrides/${encodeURIComponent(existing.id)}`, {
        method: "DELETE"
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Remove failed (${res.status}): ${body.slice(0, 300)}`);
      }
      setSuccess("Override removed.");
      props.onChanged?.();
      setTimeout(() => props.onClose(), 800);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemoving(false);
    }
  }

  if (!open || !target) return null;

  const headerLabel = (() => {
    try {
      const d = new Date(`${target.date}T12:00:00Z`);
      return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
    } catch {
      return target.date;
    }
  })();

  return (
    <>
      {/* Backdrop */}
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

      {/* Drawer */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="cell-override-drawer-title"
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: "min(480px, 100vw)",
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
            <h2 id="cell-override-drawer-title" style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
              Date specific override
            </h2>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--muted-text, #6b7280)" }}>
              <strong style={{ color: "var(--navy-dark, #0f172a)" }}>{target.listingName}</strong>
              <span style={{ margin: "0 6px" }}>·</span>
              {headerLabel}
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

        {/* View toggle: Override (default) | Pricing details. Lets the
            user check why this date got the price it did without
            leaving the override flow. */}
        <div
          role="tablist"
          aria-label="Cell drawer view"
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
            aria-selected={view === "override"}
            onClick={() => setView("override")}
            style={{
              padding: "5px 14px",
              fontSize: 12,
              fontWeight: 600,
              border: "none",
              borderRadius: 999,
              cursor: "pointer",
              background: view === "override" ? "white" : "transparent",
              color: view === "override" ? "var(--navy-dark, #0f172a)" : "var(--muted-text, #6b7280)",
              boxShadow: view === "override" ? "0 1px 2px rgba(15, 23, 42, 0.08)" : "none"
            }}
          >
            Override
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

        <div style={{ padding: "16px 24px", overflowY: "auto", flex: 1, display: view === "override" ? "block" : "none" }}>
          {existing ? (
            <section
              style={{
                background: "rgba(252, 244, 220, 0.55)",
                border: "1px solid #f1d894",
                borderRadius: 6,
                padding: 12,
                marginBottom: 16,
                fontSize: 13
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <strong>Existing override</strong>
                <button
                  type="button"
                  onClick={handleRemove}
                  disabled={removing}
                  style={{
                    border: "none",
                    background: "transparent",
                    color: "#b91c1c",
                    cursor: removing ? "not-allowed" : "pointer",
                    fontSize: 12,
                    fontWeight: 600,
                    padding: 0
                  }}
                >
                  {removing ? "Removing…" : "Remove override"}
                </button>
              </div>
              <p style={{ margin: "6px 0 0", color: "var(--muted-text, #6b7280)", fontSize: 12 }}>
                {existing.startDate === existing.endDate
                  ? existing.startDate
                  : `${existing.startDate} – ${existing.endDate}`}{" "}
                ·{" "}
                {existing.type === "fixed"
                  ? `£${existing.value.toFixed(0)} fixed`
                  : `${existing.value >= 0 ? "+" : ""}${(existing.value * 100).toFixed(0)}%`}
                {existing.minStay !== null ? ` · min stay ${existing.minStay}` : ""}
              </p>
              <p style={{ margin: "6px 0 0", fontSize: 11, color: "var(--muted-text, #6b7280)" }}>
                Edit values below and Save to replace it.
              </p>
            </section>
          ) : null}

          {target.currentRecommendation !== undefined && target.currentRecommendation !== null ? (
            <p style={{ fontSize: 12, color: "var(--muted-text, #6b7280)", margin: "0 0 16px" }}>
              Current recommendation for this date:{" "}
              <strong style={{ color: "var(--navy-dark, #0f172a)" }}>
                £{target.currentRecommendation.toFixed(0)}
              </strong>
              {target.currentMinimum !== undefined && target.currentMinimum !== null ? (
                <span> · listing min £{target.currentMinimum.toFixed(0)}</span>
              ) : null}
            </p>
          ) : null}

          <fieldset
            style={{
              border: "none",
              padding: 0,
              margin: "0 0 18px",
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 12
            }}
          >
            <label style={{ fontSize: 12, fontWeight: 500 }}>
              Start date
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                style={{
                  display: "block",
                  width: "100%",
                  padding: "6px 8px",
                  marginTop: 4,
                  border: "1px solid var(--border, #e5e7eb)",
                  borderRadius: 4,
                  fontSize: 13
                }}
              />
            </label>
            <label style={{ fontSize: 12, fontWeight: 500 }}>
              End date
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                style={{
                  display: "block",
                  width: "100%",
                  padding: "6px 8px",
                  marginTop: 4,
                  border: "1px solid var(--border, #e5e7eb)",
                  borderRadius: 4,
                  fontSize: 13
                }}
              />
            </label>
          </fieldset>

          <section style={{ marginBottom: 18 }}>
            <h3
              style={{
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: 0.5,
                textTransform: "uppercase",
                color: "var(--muted-text, #6b7280)",
                margin: "0 0 8px"
              }}
            >
              Price override
            </h3>
            <div style={{ display: "flex", gap: 16, fontSize: 13, marginBottom: 8 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                <input
                  type="radio"
                  name="cell-override-type"
                  checked={overrideType === "fixed"}
                  onChange={() => setOverrideType("fixed")}
                />
                Fixed price
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                <input
                  type="radio"
                  name="cell-override-type"
                  checked={overrideType === "percentage_delta"}
                  onChange={() => setOverrideType("percentage_delta")}
                />
                Percentage adjustment
              </label>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="number"
                value={valueStr}
                onChange={(e) => setValueStr(e.target.value)}
                placeholder={overrideType === "fixed" ? "e.g. 120" : "e.g. -10 or 25"}
                style={{
                  flex: 1,
                  padding: "6px 8px",
                  border: "1px solid var(--border, #e5e7eb)",
                  borderRadius: 4,
                  fontSize: 13
                }}
              />
              <span style={{ fontSize: 13, color: "var(--muted-text, #6b7280)", minWidth: 24 }}>
                {overrideType === "fixed" ? "GBP" : "%"}
              </span>
            </div>
            <p style={{ fontSize: 11, color: "var(--muted-text, #6b7280)", margin: "6px 0 0" }}>
              {overrideType === "fixed"
                ? "Replaces the rate entirely. The listing's minimum floor does NOT apply — set carefully."
                : `Applies on top of the dynamic recommendation. The minimum floor still applies. Allowed range ${PERCENT_MIN}% to +${PERCENT_MAX}%.`}
            </p>
          </section>

          <section style={{ marginBottom: 18 }}>
            <h3
              style={{
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: 0.5,
                textTransform: "uppercase",
                color: "var(--muted-text, #6b7280)",
                margin: "0 0 8px"
              }}
            >
              Stay restrictions
            </h3>
            <label style={{ fontSize: 12, fontWeight: 500, display: "block" }}>
              Minimum stay (optional)
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={minStayStr}
                  onChange={(e) => setMinStayStr(e.target.value)}
                  placeholder="leave blank to keep the listing default"
                  style={{
                    flex: 1,
                    padding: "6px 8px",
                    border: "1px solid var(--border, #e5e7eb)",
                    borderRadius: 4,
                    fontSize: 13
                  }}
                />
                <span style={{ fontSize: 13, color: "var(--muted-text, #6b7280)" }}>night(s)</span>
              </div>
            </label>
            <p style={{ fontSize: 11, color: "var(--muted-text, #6b7280)", margin: "6px 0 0" }}>
              Pushed to Hostaway alongside the rate for listings that push live (e.g. rate-copy).
            </p>
          </section>

          <section style={{ marginBottom: 18 }}>
            <h3
              style={{
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: 0.5,
                textTransform: "uppercase",
                color: "var(--muted-text, #6b7280)",
                margin: "0 0 8px"
              }}
            >
              Reason / notes (optional)
            </h3>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Why this override? Visible in the audit log."
              style={{
                display: "block",
                width: "100%",
                padding: "8px",
                border: "1px solid var(--border, #e5e7eb)",
                borderRadius: 4,
                fontSize: 13,
                resize: "vertical",
                fontFamily: "inherit"
              }}
            />
          </section>

          {error ? (
            <div
              style={{
                background: "#fdecea",
                border: "1px solid #f5c2c0",
                padding: 10,
                borderRadius: 4,
                color: "#a8201a",
                fontSize: 13,
                marginBottom: 12
              }}
            >
              {error}
            </div>
          ) : null}
          {success ? (
            <div
              style={{
                background: "#e6f4ea",
                border: "1px solid #b7e1c0",
                padding: 10,
                borderRadius: 4,
                color: "#1a8a3a",
                fontSize: 13,
                marginBottom: 12
              }}
            >
              {success}
            </div>
          ) : null}
        </div>

        <footer
          style={{
            padding: "14px 24px",
            borderTop: "1px solid var(--border, #e5e7eb)",
            display: view === "override" ? "flex" : "none",
            justifyContent: "flex-end",
            gap: 8,
            background: "var(--surface, #f9fafb)"
          }}
        >
          <button
            type="button"
            onClick={props.onClose}
            style={{
              padding: "8px 14px",
              border: "1px solid var(--border-strong, #d1d5db)",
              background: "white",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 13,
              fontWeight: 500
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSave(false)}
            disabled={!valid}
            style={{
              padding: "8px 14px",
              border: "1px solid var(--border-strong, #d1d5db)",
              background: "white",
              color: valid ? "var(--navy-dark, #0f172a)" : "#94a3b8",
              borderRadius: 4,
              cursor: valid ? "pointer" : "not-allowed",
              fontSize: 13,
              fontWeight: 600
            }}
          >
            {submitting ? "Saving…" : existing ? "Replace override" : "Save override"}
          </button>
          <button
            type="button"
            onClick={() => void handleSave(true)}
            disabled={!valid}
            title="Saves the override, then pushes ONLY these dates to Hostaway immediately"
            style={{
              padding: "8px 14px",
              border: "none",
              background: valid ? "var(--green-dark, #1a73e8)" : "#cbd5e1",
              color: "white",
              borderRadius: 4,
              cursor: valid ? "pointer" : "not-allowed",
              fontSize: 13,
              fontWeight: 600
            }}
          >
            {submitting ? "Working…" : "Save & push"}
          </button>
        </footer>

        {/* Pricing details view — read-only breakdown for the clicked
            date. Sits alongside the override view and is shown only when
            the user toggles to it. The breakdown rows come from the
            calendar API's per-cell `breakdown` array, so the math here
            is exactly what the recommendation engine produced. */}
        <div style={{ padding: "16px 24px", overflowY: "auto", flex: 1, display: view === "pricing" ? "block" : "none" }}>
          <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--muted-text, #6b7280)" }}>
            How this date&apos;s price was calculated.
          </p>
          {target.hostawayLiveRate !== null && target.hostawayLiveRate !== undefined && target.currentRecommendation !== null && target.currentRecommendation !== undefined ? (
            <div
              style={{
                background: "rgba(243, 249, 245, 0.7)",
                border: "1px solid rgba(22, 71, 51, 0.18)",
                borderRadius: 6,
                padding: 12,
                marginBottom: 16,
                fontSize: 13,
                color: "var(--navy-dark, #0f172a)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12
              }}
            >
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.4, textTransform: "uppercase", color: "var(--muted-text, #6b7280)" }}>
                  Hostaway live vs Signals rec
                </div>
                <div style={{ marginTop: 2 }}>
                  <strong>£{target.hostawayLiveRate.toFixed(0)}</strong> on Hostaway
                  <span style={{ margin: "0 8px", color: "var(--muted-text, #6b7280)" }}>vs</span>
                  <strong>£{target.currentRecommendation.toFixed(0)}</strong> Signals rec
                </div>
              </div>
              {(() => {
                const delta = target.currentRecommendation - target.hostawayLiveRate;
                const deltaPct = target.hostawayLiveRate > 0 ? (delta / target.hostawayLiveRate) * 100 : 0;
                if (Math.abs(delta) < 0.5) {
                  return <span style={{ fontSize: 12, color: "var(--muted-text, #6b7280)" }}>match</span>;
                }
                return (
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: delta > 0 ? "#1f7a4d" : "#bb4b52"
                    }}
                  >
                    {delta > 0 ? "+" : ""}£{delta.toFixed(0)} ({delta > 0 ? "+" : ""}{deltaPct.toFixed(1)}%)
                  </span>
                );
              })()}
            </div>
          ) : target.hostawayLiveRate !== null && target.hostawayLiveRate !== undefined ? (
            <div
              style={{
                background: "rgba(243, 249, 245, 0.7)",
                border: "1px solid rgba(22, 71, 51, 0.18)",
                borderRadius: 6,
                padding: 12,
                marginBottom: 16,
                fontSize: 13,
                color: "var(--navy-dark, #0f172a)"
              }}
            >
              <strong>Hostaway live: £{target.hostawayLiveRate.toFixed(0)}</strong>
            </div>
          ) : null}
          {target.cellState === "booked" && target.bookedRate !== null && target.bookedRate !== undefined ? (
            <div
              style={{
                background: "rgba(243, 217, 159, 0.35)",
                border: "1px solid rgba(176, 122, 25, 0.35)",
                borderRadius: 6,
                padding: 12,
                marginBottom: 16,
                fontSize: 13,
                color: "var(--navy-dark, #0f172a)"
              }}
            >
              <strong>Booked at £{target.bookedRate.toFixed(0)}.</strong> The breakdown below is what
              the recommendation would have been if the date were still available.
            </div>
          ) : null}
          {target.cellBreakdown && target.cellBreakdown.length > 0 ? (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <tbody>
                {target.cellBreakdown.map((row, index) => {
                  const isFinal = row.label.toLowerCase() === "final";
                  return (
                    <tr
                      key={`${row.label}-${index}`}
                      style={{
                        borderBottom: "1px solid var(--border, #e5e7eb)",
                        fontWeight: isFinal ? 700 : 400,
                        background: isFinal ? "rgba(232, 245, 235, 0.5)" : "transparent"
                      }}
                    >
                      <td style={{ padding: "8px 4px", color: "var(--navy-dark, #0f172a)" }}>{row.label}</td>
                      <td style={{ padding: "8px 4px", textAlign: "right", fontFamily: "monospace", color: "var(--navy-dark, #0f172a)" }}>
                        {row.amount === null
                          ? "—"
                          : row.unit === "currency"
                            ? `£${Number(row.amount).toFixed(0)}`
                            : row.unit === "percent"
                              ? `${Number(row.amount) >= 0 ? "+" : ""}${Number(row.amount).toFixed(1)}%`
                              : row.unit === "multiplier"
                                ? `× ${Number(row.amount).toFixed(2)}`
                                : Number(row.amount).toLocaleString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p style={{ fontSize: 13, color: "var(--muted-text, #6b7280)" }}>
              No breakdown available for this date — the cell may be booked or unavailable.
            </p>
          )}
        </div>
      </aside>
    </>
  );
}
