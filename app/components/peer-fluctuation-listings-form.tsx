"use client";

import { useEffect, useState } from "react";

import { withBasePath } from "@/lib/base-path";

/**
 * "Peer-Fluctuation Pricing" settings section.
 *
 * Per spec A.4: a flat list of target listing IDs, each with inline base/min,
 * push toggle, "Push now" button, and last-pushed timestamp. New rows
 * default to push OFF; activate-push only when fully configured.
 *
 * The list of listings is sourced from this tenant's `pricingSettings` rows
 * with `pricingMode === 'peer_fluctuation'`. To "add" a new listing, the
 * user types a Hostaway listing ID (which we resolve to the internal
 * Listing.id once the listing has synced through). The row stays in
 * "Pending: not yet synced" until then.
 */

type SyncedListing = {
  id: string;
  hostawayId: string;
  name: string;
};

type RowState = {
  /** Internal Listing.id if known; otherwise null. */
  listingId: string | null;
  /** Hostaway listing ID as typed by the user / loaded from the row. */
  hostawayId: string;
  basePrice: number | null;
  minimumPrice: number | null;
  pushEnabled: boolean;
  resolvedListingName: string | null;
  lastPushedAt: string | null;
  lastPushedCount: number | null;
  lastPushedStatus: string | null;
  saving: boolean;
  pushing: boolean;
  message: string | null;
};

type LastPushedSummary = {
  listingId: string;
  createdAt: string;
  status: string;
  dateCount: number;
  triggerSource: string;
} | null;

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(withBasePath(url), init);
  const body = (await response.json().catch(() => ({}))) as { error?: string } & T;
  if (!response.ok) {
    throw new Error(body.error ?? "Request failed");
  }
  return body;
}

export default function PeerFluctuationListingsForm() {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<RowState[]>([]);
  const [newHostawayId, setNewHostawayId] = useState("");
  const [adding, setAdding] = useState(false);
  const [globalMessage, setGlobalMessage] = useState<string | null>(null);
  const [pushingAll, setPushingAll] = useState(false);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      // We piggy-back on the existing /api/pricing-settings endpoint to
      // read property-scope settings (one round-trip per row). This isn't
      // efficient for large lists but matches spec A.4's simple-list shape
      // and avoids a new bulk endpoint for the MVP.
      const listings = await fetchJson<{ listings: SyncedListing[] }>("/api/listings?fields=peer-fluctuation");
      const candidates = listings.listings ?? [];
      const rowStates: RowState[] = await Promise.all(
        candidates.map(async (listing): Promise<RowState | null> => {
          const settings = await fetchJson<{
            currentOverride: {
              pricingMode?: string;
              basePriceOverride?: number | null;
              minimumPriceOverride?: number | null;
              peerFluctuationPushEnabled?: boolean;
            };
            lastPushed?: LastPushedSummary;
          }>(`/api/pricing-settings?scope=property&scopeRef=${encodeURIComponent(listing.id)}`);
          if (settings.currentOverride.pricingMode !== "peer_fluctuation") return null;
          return {
            listingId: listing.id,
            hostawayId: listing.hostawayId,
            basePrice: settings.currentOverride.basePriceOverride ?? null,
            minimumPrice: settings.currentOverride.minimumPriceOverride ?? null,
            pushEnabled: settings.currentOverride.peerFluctuationPushEnabled ?? false,
            resolvedListingName: listing.name,
            lastPushedAt: settings.lastPushed?.createdAt ?? null,
            lastPushedCount: settings.lastPushed?.dateCount ?? null,
            lastPushedStatus: settings.lastPushed?.status ?? null,
            saving: false,
            pushing: false,
            message: null
          };
        })
      ).then((arr) => arr.filter((r): r is RowState => r !== null));
      setRows(rowStates);
    } catch (error) {
      setGlobalMessage(error instanceof Error ? error.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  async function addRow() {
    const hostawayId = newHostawayId.trim();
    if (!hostawayId) return;
    setAdding(true);
    setGlobalMessage(null);
    try {
      // Resolve the hostawayId → internal Listing.id (may be null until sync).
      const resolved = await fetchJson<{ listing: SyncedListing | null }>(
        `/api/listings/by-hostaway-id?hostawayId=${encodeURIComponent(hostawayId)}`
      );
      const listingId = resolved.listing?.id ?? null;
      if (listingId === null) {
        setGlobalMessage(
          `Hostaway ID ${hostawayId} hasn't synced yet — once it appears in the next sync run the row will activate. (You can configure base/min now if you wish.)`
        );
      }
      // Save a property-scope settings row with pricingMode = peer_fluctuation.
      // If listingId is null we can't actually save (scopeRef requires the
      // internal id). For MVP we display a "Pending" row in the UI but
      // don't persist until sync completes.
      if (listingId !== null) {
        await fetchJson("/api/pricing-settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scope: "property",
            scopeRef: listingId,
            mergeExisting: true,
            settings: {
              pricingMode: "peer_fluctuation",
              peerFluctuationPushEnabled: false
            }
          })
        });
      }
      setNewHostawayId("");
      await load();
    } catch (error) {
      setGlobalMessage(error instanceof Error ? error.message : "Failed to add listing");
    } finally {
      setAdding(false);
    }
  }

  async function saveRow(row: RowState, patch: Partial<RowState>) {
    if (!row.listingId) return;
    setRows((current) =>
      current.map((r) => (r.listingId === row.listingId ? { ...r, ...patch, saving: true } : r))
    );
    try {
      await fetchJson("/api/pricing-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: "property",
          scopeRef: row.listingId,
          mergeExisting: true,
          settings: {
            pricingMode: "peer_fluctuation",
            basePriceOverride: patch.basePrice ?? row.basePrice,
            minimumPriceOverride: patch.minimumPrice ?? row.minimumPrice,
            peerFluctuationPushEnabled: patch.pushEnabled ?? row.pushEnabled
          }
        })
      });
      setRows((current) =>
        current.map((r) =>
          r.listingId === row.listingId ? { ...r, ...patch, saving: false, message: "Saved." } : r
        )
      );
    } catch (error) {
      setRows((current) =>
        current.map((r) =>
          r.listingId === row.listingId
            ? {
                ...r,
                saving: false,
                message: error instanceof Error ? error.message : "Save failed"
              }
            : r
        )
      );
    }
  }

  async function pushNow(row: RowState) {
    if (!row.listingId) return;
    setRows((current) =>
      current.map((r) => (r.listingId === row.listingId ? { ...r, pushing: true, message: null } : r))
    );
    try {
      const result = await fetchJson<{
        pushed: number;
        skipped: number;
        failed: number;
        errors: string[];
      }>("/api/pricing/peer-fluctuation/push-now", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listingId: row.listingId })
      });
      setRows((current) =>
        current.map((r) =>
          r.listingId === row.listingId
            ? {
                ...r,
                pushing: false,
                message:
                  result.failed > 0
                    ? `Push failed: ${result.errors.join("; ")}`
                    : `Pushed ${result.pushed}; skipped ${result.skipped}.`
              }
            : r
        )
      );
      // refresh last-pushed metadata
      void load();
    } catch (error) {
      setRows((current) =>
        current.map((r) =>
          r.listingId === row.listingId
            ? {
                ...r,
                pushing: false,
                message: error instanceof Error ? error.message : "Push failed"
              }
            : r
        )
      );
    }
  }

  async function pushAll() {
    setPushingAll(true);
    setGlobalMessage(null);
    try {
      const result = await fetchJson<{
        pushed: number;
        skipped: number;
        failed: number;
        errors: string[];
      }>("/api/pricing/peer-fluctuation/push-now", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true })
      });
      setGlobalMessage(
        `Pushed ${result.pushed}; skipped ${result.skipped}; failed ${result.failed}.`
      );
      void load();
    } catch (error) {
      setGlobalMessage(error instanceof Error ? error.message : "Push-all failed");
    } finally {
      setPushingAll(false);
    }
  }

  function statusBadge(row: RowState): string {
    if (!row.listingId) return "Pending: not yet synced";
    if (row.basePrice === null || row.minimumPrice === null) return "Pending: awaiting base/min";
    if (!row.pushEnabled) return "Staged: push OFF";
    return "Live: push ON";
  }

  if (loading) {
    return <p className="text-sm text-[var(--muted-text)]">Loading peer-fluctuation listings…</p>;
  }

  return (
    <section
      className="glass-panel rounded-[24px] border p-5 sm:p-6"
      style={{ borderColor: "var(--border)" }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-lg">Peer-fluctuation pricing</h2>
        <button
          type="button"
          onClick={() => void pushAll()}
          disabled={pushingAll || rows.length === 0}
          className="text-xs font-semibold underline disabled:opacity-50"
          style={{ color: "var(--green-dark)" }}
        >
          {pushingAll ? "Pushing all…" : "Push all"}
        </button>
      </div>
      <p className="mt-1 text-xs" style={{ color: "var(--muted-text)" }}>
        Listings priced from your saved base/min and a daily fluctuation factor
        derived from the rest of your portfolio. The daily push runs at 06:30
        Europe/London. Use “Push now” to publish a midday change immediately.
      </p>

      <div className="mt-4 space-y-3">
        {rows.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--muted-text)" }}>
            No peer-fluctuation listings configured yet.
          </p>
        ) : (
          rows.map((row) => (
            <div
              key={row.listingId ?? row.hostawayId}
              className="rounded-2xl border p-3"
              style={{ borderColor: "var(--border)" }}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold">
                    {row.resolvedListingName ?? `Hostaway #${row.hostawayId}`}
                  </div>
                  <div className="text-xs" style={{ color: "var(--muted-text)" }}>
                    {statusBadge(row)}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void pushNow(row)}
                    disabled={
                      row.pushing ||
                      row.listingId === null ||
                      row.basePrice === null ||
                      row.minimumPrice === null ||
                      !row.pushEnabled
                    }
                    className="rounded-full px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
                    style={{ background: "var(--green-dark)" }}
                  >
                    {row.pushing ? "Pushing…" : "Push now"}
                  </button>
                  <label className="flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={row.pushEnabled}
                      onChange={(e) => void saveRow(row, { pushEnabled: e.target.checked })}
                      disabled={
                        row.listingId === null ||
                        row.basePrice === null ||
                        row.minimumPrice === null
                      }
                    />
                    Push
                  </label>
                </div>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <label className="block text-xs">
                  <span
                    className="text-xs font-semibold uppercase tracking-wide"
                    style={{ color: "var(--muted-text)" }}
                  >
                    Base price (£)
                  </span>
                  <input
                    type="number"
                    className="mt-1 w-full rounded-xl border bg-white px-3 py-2 text-sm outline-none"
                    style={{ borderColor: "var(--border)" }}
                    value={row.basePrice ?? ""}
                    onChange={(e) => {
                      const v = e.target.value === "" ? null : Number(e.target.value);
                      setRows((cur) =>
                        cur.map((r) => (r.listingId === row.listingId ? { ...r, basePrice: v } : r))
                      );
                    }}
                    onBlur={() => void saveRow(row, { basePrice: row.basePrice })}
                  />
                </label>
                <label className="block text-xs">
                  <span
                    className="text-xs font-semibold uppercase tracking-wide"
                    style={{ color: "var(--muted-text)" }}
                  >
                    Minimum price (£)
                  </span>
                  <input
                    type="number"
                    className="mt-1 w-full rounded-xl border bg-white px-3 py-2 text-sm outline-none"
                    style={{ borderColor: "var(--border)" }}
                    value={row.minimumPrice ?? ""}
                    onChange={(e) => {
                      const v = e.target.value === "" ? null : Number(e.target.value);
                      setRows((cur) =>
                        cur.map((r) =>
                          r.listingId === row.listingId ? { ...r, minimumPrice: v } : r
                        )
                      );
                    }}
                    onBlur={() => void saveRow(row, { minimumPrice: row.minimumPrice })}
                  />
                </label>
              </div>
              <div className="mt-2 text-xs" style={{ color: "var(--muted-text)" }}>
                {row.lastPushedAt
                  ? `Last push: ${new Date(row.lastPushedAt).toLocaleString()} — ${
                      row.lastPushedStatus ?? ""
                    }${
                      row.lastPushedCount !== null ? ` (${row.lastPushedCount} dates)` : ""
                    }`
                  : "No push yet."}
                {row.message ? ` · ${row.message}` : null}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="mt-4 flex items-center gap-2">
        <input
          type="text"
          className="flex-1 rounded-xl border bg-white px-3 py-2 text-sm outline-none"
          style={{ borderColor: "var(--border)" }}
          placeholder="Add Hostaway listing ID"
          value={newHostawayId}
          onChange={(e) => setNewHostawayId(e.target.value)}
        />
        <button
          type="button"
          onClick={() => void addRow()}
          disabled={adding || newHostawayId.trim().length === 0}
          className="rounded-full px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
          style={{ background: "var(--green-dark)" }}
        >
          {adding ? "Adding…" : "Add target listing ID"}
        </button>
      </div>
      {globalMessage ? (
        <p className="mt-2 text-xs" style={{ color: "var(--muted-text)" }}>
          {globalMessage}
        </p>
      ) : null}
    </section>
  );
}
