"use client";

import { useEffect, useState } from "react";

export type RateCopySettingsProps = {
  /** Target listing (the one being edited). */
  listingId: string;
  listingName: string;
  /** All listings in the tenant — used as the source dropdown. The
   *  current target listing is filtered out. */
  allListings: Array<{ id: string; name: string }>;
};

type CurrentSettings = {
  pricingMode: "standard" | "rate_copy";
  rateCopySourceListingId: string | null;
  rateCopyPushEnabled: boolean;
  basePriceOverride: number | null;
  minimumPriceOverride: number | null;
  minimumNightStay: number | null;
};

export function RateCopySettings(props: RateCopySettingsProps) {
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<CurrentSettings | null>(null);
  const [draft, setDraft] = useState<CurrentSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/pricing-settings?scope=property&scopeRef=${encodeURIComponent(props.listingId)}`
        );
        if (!res.ok) throw new Error(`Settings load failed (${res.status})`);
        const data = (await res.json()) as { resolved?: Record<string, unknown> };
        const r = (data.resolved ?? {}) as Record<string, unknown>;
        const initial: CurrentSettings = {
          pricingMode: r.pricingMode === "rate_copy" ? "rate_copy" : "standard",
          rateCopySourceListingId:
            typeof r.rateCopySourceListingId === "string" && r.rateCopySourceListingId.length > 0
              ? r.rateCopySourceListingId
              : null,
          rateCopyPushEnabled: r.rateCopyPushEnabled === true,
          basePriceOverride:
            typeof r.basePriceOverride === "number" ? r.basePriceOverride : null,
          minimumPriceOverride:
            typeof r.minimumPriceOverride === "number" ? r.minimumPriceOverride : null,
          minimumNightStay: typeof r.minimumNightStay === "number" ? r.minimumNightStay : null
        };
        if (cancelled) return;
        setSettings(initial);
        setDraft(initial);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [props.listingId]);

  if (loading || !draft) {
    return (
      <div style={{ padding: 12, fontSize: 13, color: "#666" }}>Loading rate-copy settings…</div>
    );
  }

  const dirty =
    settings !== null &&
    (draft.pricingMode !== settings.pricingMode ||
      draft.rateCopySourceListingId !== settings.rateCopySourceListingId ||
      draft.rateCopyPushEnabled !== settings.rateCopyPushEnabled);

  async function save() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    setInfo(null);
    try {
      const res = await fetch("/api/pricing-settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: "property",
          scopeRef: props.listingId,
          mergeExisting: true,
          settings: {
            pricingMode: draft.pricingMode,
            rateCopySourceListingId: draft.rateCopySourceListingId,
            rateCopyPushEnabled: draft.rateCopyPushEnabled
          }
        })
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Save failed (${res.status}): ${txt.slice(0, 300)}`);
      }
      setSettings(draft);
      setInfo("Saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function pushNow() {
    setPushing(true);
    setError(null);
    setInfo(null);
    try {
      const res = await fetch("/api/pricing/rate-copy/push-now", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ listingId: props.listingId })
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Push failed (${res.status}): ${txt.slice(0, 300)}`);
      }
      const data = (await res.json()) as {
        summary: {
          status: string;
          dateCount: number;
          pushedCount: number;
          errorMessage: string | null;
        };
      };
      const s = data.summary;
      if (s.status === "success") setInfo(`Pushed ${s.pushedCount} of ${s.dateCount} dates.`);
      else setInfo(`${s.status}: ${s.errorMessage ?? "see logs"}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPushing(false);
    }
  }

  const sourceOptions = props.allListings.filter((l) => l.id !== props.listingId);
  const baseOk = (draft.basePriceOverride ?? 0) > 0;
  const minOk = (draft.minimumPriceOverride ?? 0) > 0;
  const sourceOk = draft.rateCopySourceListingId !== null;
  const fullyConfigured = baseOk && minOk && sourceOk && draft.pricingMode === "rate_copy";

  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 6, padding: 12, marginTop: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.6, textTransform: "uppercase", color: "#666", marginBottom: 8 }}>
        Rate copy (push another listing's rate to this one)
      </div>
      <p style={{ fontSize: 12, color: "#555", margin: "0 0 12px" }}>
        Reads the live Hostaway rate from a source listing each day and pushes it here.
        Multi-unit occupancy adjustments are applied on top, and the final rate is floored
        at this listing's minimum. Min-stay (set in this listing's settings) is also pushed.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "8px 12px", alignItems: "center", fontSize: 13 }}>
        <label htmlFor={`pricingMode-${props.listingId}`} style={{ fontWeight: 500 }}>
          Pricing mode
        </label>
        <select
          id={`pricingMode-${props.listingId}`}
          value={draft.pricingMode}
          onChange={(e) =>
            setDraft({
              ...draft,
              pricingMode: e.target.value === "rate_copy" ? "rate_copy" : "standard"
            })
          }
          style={{ padding: 6, border: "1px solid #ccc", borderRadius: 4 }}
        >
          <option value="standard">Standard (use the recommendation engine)</option>
          <option value="rate_copy">Rate copy (mirror another listing)</option>
        </select>

        <label htmlFor={`rateCopySource-${props.listingId}`} style={{ fontWeight: 500 }}>
          Source listing
        </label>
        <select
          id={`rateCopySource-${props.listingId}`}
          value={draft.rateCopySourceListingId ?? ""}
          onChange={(e) =>
            setDraft({
              ...draft,
              rateCopySourceListingId: e.target.value === "" ? null : e.target.value
            })
          }
          disabled={draft.pricingMode !== "rate_copy"}
          style={{ padding: 6, border: "1px solid #ccc", borderRadius: 4 }}
        >
          <option value="">— pick a listing —</option>
          {sourceOptions.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>

        <label htmlFor={`rateCopyPush-${props.listingId}`} style={{ fontWeight: 500 }}>
          Push to Hostaway
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            id={`rateCopyPush-${props.listingId}`}
            type="checkbox"
            checked={draft.rateCopyPushEnabled}
            onChange={(e) => setDraft({ ...draft, rateCopyPushEnabled: e.target.checked })}
            disabled={draft.pricingMode !== "rate_copy"}
          />
          <span style={{ fontSize: 12, color: "#555" }}>
            Daily 06:30 push, plus &quot;Push now&quot;
          </span>
        </label>
      </div>

      <div style={{ marginTop: 12, fontSize: 12, color: fullyConfigured ? "#1a8a3a" : "#bf7f00" }}>
        {!baseOk
          ? "Set a base price below before enabling push."
          : !minOk
            ? "Set a minimum price below before enabling push."
            : !sourceOk
              ? "Pick a source listing to copy from."
              : draft.pricingMode !== "rate_copy"
                ? "Switch pricing mode to 'rate_copy' to activate."
                : draft.rateCopyPushEnabled
                  ? "Live: scheduled push at 06:30 Europe/London."
                  : "Staged: push toggle is OFF."}
      </div>

      {error ? (
        <div style={{ background: "#fdecea", border: "1px solid #f5c2c0", padding: 8, borderRadius: 4, color: "#a8201a", fontSize: 12, marginTop: 10 }}>
          {error}
        </div>
      ) : null}
      {info ? (
        <div style={{ background: "#e6f4ea", border: "1px solid #b7e1c0", padding: 8, borderRadius: 4, color: "#1a8a3a", fontSize: 12, marginTop: 10 }}>
          {info}
        </div>
      ) : null}

      <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          style={{
            padding: "6px 12px",
            border: "none",
            background: !dirty || saving ? "#aaa" : "#1a73e8",
            color: "white",
            borderRadius: 4,
            cursor: !dirty || saving ? "not-allowed" : "pointer",
            fontSize: 13
          }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={pushNow}
          disabled={!fullyConfigured || !draft.rateCopyPushEnabled || pushing}
          style={{
            padding: "6px 12px",
            border: "1px solid #ccc",
            background: "white",
            color: "#222",
            borderRadius: 4,
            cursor: !fullyConfigured || !draft.rateCopyPushEnabled || pushing ? "not-allowed" : "pointer",
            opacity: !fullyConfigured || !draft.rateCopyPushEnabled ? 0.5 : 1,
            fontSize: 13
          }}
        >
          {pushing ? "Pushing…" : "Push now"}
        </button>
      </div>
    </div>
  );
}
