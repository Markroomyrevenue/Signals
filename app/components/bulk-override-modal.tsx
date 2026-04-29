"use client";

import { useEffect, useMemo, useState } from "react";

export type BulkOverrideListing = {
  id: string;
  name: string;
  hostawayId?: string | null;
};

export type BulkOverrideModalProps = {
  open: boolean;
  onClose: () => void;
  /** All admin-visible listings in the tenant. Multi-select dropdown. */
  listings: BulkOverrideListing[];
  /** Callback invoked after a successful create. Lets the parent refresh
   *  the calendar so the new override marker shows on affected cells. */
  onCreated?: () => void;
};

type OverrideType = "fixed" | "percentage_delta";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function plusDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function BulkOverrideModal(props: BulkOverrideModalProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [startDate, setStartDate] = useState<string>(todayIso());
  const [endDate, setEndDate] = useState<string>(plusDaysIso(todayIso(), 6));
  const [overrideType, setOverrideType] = useState<OverrideType>("percentage_delta");
  const [overrideValueStr, setOverrideValueStr] = useState<string>("0");
  const [minStayStr, setMinStayStr] = useState<string>("");
  const [notes, setNotes] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultSummary, setResultSummary] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) {
      // Reset form on close
      setSelectedIds(new Set());
      setOverrideValueStr("0");
      setMinStayStr("");
      setNotes("");
      setError(null);
      setResultSummary(null);
    }
  }, [props.open]);

  const overrideValueParsed = useMemo(() => {
    const raw = Number(overrideValueStr);
    if (!Number.isFinite(raw)) return null;
    return overrideType === "percentage_delta" ? raw / 100 : raw;
  }, [overrideValueStr, overrideType]);

  const minStayParsed: number | null | "invalid" = useMemo(() => {
    if (minStayStr.trim().length === 0) return null as number | null | "invalid";
    const n = Number(minStayStr);
    if (!Number.isFinite(n) || n < 1 || n > 30) return "invalid" as number | null | "invalid";
    return Math.round(n) as number | null | "invalid";
  }, [minStayStr]);

  const valid =
    selectedIds.size > 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(startDate) &&
    /^\d{4}-\d{2}-\d{2}$/.test(endDate) &&
    startDate <= endDate &&
    overrideValueParsed !== null &&
    (overrideType === "fixed"
      ? overrideValueParsed > 0
      : overrideValueParsed >= -0.5 && overrideValueParsed <= 1.0) &&
    (minStayParsed as unknown) !== "invalid" &&
    !submitting;

  function toggleListing(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSubmit() {
    if (!valid || overrideValueParsed === null || (minStayParsed as unknown) === "invalid") return;
    setSubmitting(true);
    setError(null);
    setResultSummary(null);
    try {
      const res = await fetch("/api/pricing/overrides", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          listingIds: Array.from(selectedIds),
          startDate,
          endDate,
          overrideType,
          overrideValue: overrideValueParsed,
          minStay: minStayParsed,
          notes: notes.trim().length > 0 ? notes.trim() : null
        })
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
      }
      const data = (await res.json()) as {
        results: Array<{
          listingId: string;
          created: { id: string } | null;
          superseded: { mutations: unknown[]; summary: string } | null;
          error: string | null;
        }>;
      };
      const ok = data.results.filter((r) => r.created !== null).length;
      const fail = data.results.length - ok;
      const supersededCount = data.results.reduce(
        (n, r) => n + (r.superseded?.mutations.length ?? 0),
        0
      );
      const sumLines: string[] = [];
      sumLines.push(`Created ${ok} override${ok === 1 ? "" : "s"}.`);
      if (fail > 0) sumLines.push(`${fail} failed.`);
      if (supersededCount > 0) {
        sumLines.push(`Superseded ${supersededCount} existing override${supersededCount === 1 ? "" : "s"} on overlapping dates.`);
      }
      setResultSummary(sumLines.join(" "));
      props.onCreated?.();
      // Auto-close after a short pause to give the user time to read.
      setTimeout(() => props.onClose(), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (!props.open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="bulk-override-title"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: "rgba(0,0,0,0.5)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        style={{
          background: "white",
          borderRadius: 8,
          padding: 24,
          maxWidth: 720,
          width: "100%",
          maxHeight: "90vh",
          overflowY: "auto",
          boxShadow: "0 10px 40px rgba(0,0,0,0.25)"
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h2 id="bulk-override-title" style={{ margin: 0, fontSize: 18 }}>Bulk edit overrides</h2>
          <button onClick={props.onClose} style={{ background: "none", border: "none", fontSize: 24, cursor: "pointer", lineHeight: 1, padding: 0 }} aria-label="Close">
            ×
          </button>
        </div>

        <p style={{ color: "#555", fontSize: 13, margin: "0 0 16px" }}>
          Apply the same override to one or more listings across a date range. Percentage
          overrides keep the dynamic recommendation but never drop below the listing's minimum.
          Fixed-price overrides replace the rate entirely and bypass the minimum floor —
          set carefully.
        </p>

        <fieldset style={{ border: "1px solid #ddd", borderRadius: 4, padding: 12, marginBottom: 12 }}>
          <legend style={{ padding: "0 6px", fontSize: 12, fontWeight: 600 }}>Listings</legend>
          <div style={{ maxHeight: 160, overflowY: "auto", border: "1px solid #eee", borderRadius: 4, padding: 8, fontSize: 13 }}>
            {props.listings.length === 0 ? (
              <p style={{ color: "#888", margin: 0 }}>No listings available.</p>
            ) : (
              props.listings.map((l) => (
                <label key={l.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 0", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(l.id)}
                    onChange={() => toggleListing(l.id)}
                  />
                  <span style={{ flex: 1 }}>{l.name}</span>
                  {l.hostawayId ? <span style={{ color: "#888", fontFamily: "monospace", fontSize: 11 }}>#{l.hostawayId}</span> : null}
                </label>
              ))
            )}
          </div>
          <div style={{ marginTop: 6, fontSize: 12 }}>
            <button
              type="button"
              onClick={() => setSelectedIds(new Set(props.listings.map((l) => l.id)))}
              style={{ background: "none", border: "none", color: "#1a73e8", cursor: "pointer", padding: 0, marginRight: 8 }}
            >
              Select all
            </button>
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              style={{ background: "none", border: "none", color: "#1a73e8", cursor: "pointer", padding: 0 }}
            >
              Clear
            </button>
            <span style={{ color: "#888", marginLeft: 12 }}>{selectedIds.size} selected</span>
          </div>
        </fieldset>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <label style={{ fontSize: 12 }}>
            Start date
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              style={{ width: "100%", padding: 6, border: "1px solid #ccc", borderRadius: 4, marginTop: 4 }}
            />
          </label>
          <label style={{ fontSize: 12 }}>
            End date
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              style={{ width: "100%", padding: 6, border: "1px solid #ccc", borderRadius: 4, marginTop: 4 }}
            />
          </label>
        </div>

        <fieldset style={{ border: "1px solid #ddd", borderRadius: 4, padding: 12, marginBottom: 12 }}>
          <legend style={{ padding: "0 6px", fontSize: 12, fontWeight: 600 }}>Override type</legend>
          <label style={{ display: "block", marginBottom: 6, fontSize: 13 }}>
            <input
              type="radio"
              checked={overrideType === "percentage_delta"}
              onChange={() => setOverrideType("percentage_delta")}
            />
            <strong style={{ marginLeft: 6 }}>Percentage</strong> — applies on top of the dynamic rate. Allowed -50% to +100%. Min floor still applies.
          </label>
          <label style={{ display: "block", fontSize: 13 }}>
            <input
              type="radio"
              checked={overrideType === "fixed"}
              onChange={() => setOverrideType("fixed")}
            />
            <strong style={{ marginLeft: 6 }}>Fixed price</strong> — replaces the rate entirely. Min floor does NOT apply.
          </label>
          <div style={{ marginTop: 10, display: "flex", gap: 12, alignItems: "center" }}>
            <label style={{ fontSize: 12, flex: 1 }}>
              {overrideType === "fixed" ? "Fixed rate (£)" : "Percentage delta (%)"}
              <input
                type="number"
                step={overrideType === "fixed" ? "1" : "1"}
                value={overrideValueStr}
                onChange={(e) => setOverrideValueStr(e.target.value)}
                style={{ width: "100%", padding: 6, border: "1px solid #ccc", borderRadius: 4, marginTop: 4 }}
                placeholder={overrideType === "fixed" ? "e.g. 120" : "e.g. -10 or 25"}
              />
            </label>
            <label style={{ fontSize: 12, flex: 1 }}>
              Min stay (optional)
              <input
                type="number"
                min={1}
                max={30}
                value={minStayStr}
                onChange={(e) => setMinStayStr(e.target.value)}
                style={{ width: "100%", padding: 6, border: "1px solid #ccc", borderRadius: 4, marginTop: 4 }}
                placeholder="leave blank to use listing default"
              />
            </label>
          </div>
        </fieldset>

        <label style={{ fontSize: 12, display: "block", marginBottom: 12 }}>
          Notes (optional)
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            style={{ width: "100%", padding: 6, border: "1px solid #ccc", borderRadius: 4, marginTop: 4, resize: "vertical" }}
          />
        </label>

        {error ? (
          <div style={{ background: "#fdecea", border: "1px solid #f5c2c0", padding: 10, borderRadius: 4, color: "#a8201a", fontSize: 13, marginBottom: 12 }}>
            {error}
          </div>
        ) : null}
        {resultSummary ? (
          <div style={{ background: "#e6f4ea", border: "1px solid #b7e1c0", padding: 10, borderRadius: 4, color: "#1a8a3a", fontSize: 13, marginBottom: 12 }}>
            {resultSummary}
          </div>
        ) : null}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={props.onClose} style={{ padding: "8px 14px", border: "1px solid #ccc", background: "white", borderRadius: 4, cursor: "pointer" }}>
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!valid}
            style={{
              padding: "8px 14px",
              border: "none",
              background: valid ? "#1a73e8" : "#aaa",
              color: "white",
              borderRadius: 4,
              cursor: valid ? "pointer" : "not-allowed"
            }}
          >
            {submitting ? "Saving…" : "Save override"}
          </button>
        </div>
      </div>
    </div>
  );
}
