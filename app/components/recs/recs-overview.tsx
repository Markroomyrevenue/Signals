"use client";

import Link from "next/link";
import { useState } from "react";

import { withBasePath } from "@/lib/base-path";
import type { RecsClientSummary } from "@/lib/recs/data";

import { formatDateTime, formatHoursOld, formatMoney } from "./format";

function Chip({
  children,
  tone,
  title
}: {
  children: React.ReactNode;
  tone: "green" | "amber" | "red" | "grey";
  title?: string;
}) {
  const styles: Record<string, React.CSSProperties> = {
    green: { borderColor: "rgba(22,71,51,0.2)", background: "rgba(31,122,77,0.08)", color: "var(--green-dark)" },
    amber: { borderColor: "rgba(180,120,20,0.28)", background: "rgba(214,158,46,0.1)", color: "#8a5a12" },
    red: { borderColor: "rgba(187,75,82,0.25)", background: "rgba(187,75,82,0.08)", color: "var(--delta-negative)" },
    grey: { borderColor: "var(--border)", background: "rgba(20,42,34,0.04)", color: "var(--muted-text)" }
  };
  return (
    <span className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold" style={styles[tone]} title={title}>
      {children}
    </span>
  );
}

function EngineBadge({ engine }: { engine: string }) {
  if (engine === "hostaway-scan") {
    return <Chip tone="grey">hostaway-scan · read-only</Chip>;
  }
  return <Chip tone="green">{engine}</Chip>;
}

function OversightChip({ oversight }: { oversight: RecsClientSummary["oversight"] }) {
  if (!oversight) return null;
  if (oversight.status !== "ok") return <Chip tone="grey">Claude: unavailable</Chip>;
  if ((oversight.flags ?? 0) > 0) {
    return <Chip tone="amber">Claude: {oversight.flags} {oversight.flags === 1 ? "flag" : "flags"}</Chip>;
  }
  return null;
}

function ClientCard({
  client,
  onToggleBelowFloor
}: {
  client: RecsClientSummary;
  onToggleBelowFloor: (tenantId: string, next: boolean) => void;
}) {
  const drops = Math.max(0, client.pendingCount - client.holdCount);
  return (
    <Link
      href={`/dashboard/recommendations/${client.tenantId}`}
      className="glass-panel block rounded-[24px] border p-5 transition hover:shadow-lg"
      style={{ borderColor: "var(--border)" }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-xl">{client.name}</h2>
        <span className="flex items-center gap-2">
          {client.snoozedListings > 0 ? (
            <Chip tone="grey" title="Listings snoozed via 'Ignore 30 days' — they resurface automatically">
              {client.snoozedListings} snoozed
            </Chip>
          ) : null}
          <EngineBadge engine={client.engine} />
        </span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>Listings</p>
          <p className="mt-1 text-lg font-semibold">{client.listings}</p>
        </div>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>Nights at risk (14d)</p>
          <p className="mt-1 text-lg font-semibold">
            {client.nightsAtRisk}
            <span className="ml-2 text-sm font-normal" style={{ color: "var(--muted-text)" }}>{formatMoney(client.revenueAtRisk, client.currency)}</span>
          </p>
        </div>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>Pending</p>
          <p className="mt-1 text-lg font-semibold">
            {client.pendingCount}
            <span className="ml-2 text-sm font-normal" style={{ color: "var(--muted-text)" }}>{drops} drops · {client.holdCount} holds</span>
          </p>
        </div>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>Actioned (7d)</p>
          <p className="mt-1 text-lg font-semibold">{client.actioned7d}</p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {client.provenance === "warm-start" ? <Chip tone="amber">warm-start</Chip> : null}
        {client.provenance === "live-observed" ? <Chip tone="green">live-observed</Chip> : null}
        {client.provisionalShare !== null && client.provisionalShare > 0 ? (
          <Chip tone="amber">provisional {Math.round(client.provisionalShare * 100)}%</Chip>
        ) : null}
        <Chip tone={client.stale ? "red" : "grey"}>{formatHoursOld(client.calendarFreshHours)}</Chip>
        <OversightChip oversight={client.oversight} />
      </div>

      {client.stale ? (
        <p className="mt-3 rounded-2xl border px-3 py-2 text-xs font-medium" style={{ borderColor: "rgba(187,75,82,0.25)", background: "rgba(187,75,82,0.08)", color: "var(--delta-negative)" }}>
          Prices shown may be stale — refresh sync first.
        </p>
      ) : null}

      {client.lowConfidence ? (
        <div className="mt-3 rounded-2xl border px-3 py-2 text-xs" style={{ borderColor: "rgba(180,120,20,0.28)", background: "rgba(214,158,46,0.08)", color: "#8a5a12" }}>
          <p className="font-semibold">{client.lowConfidence.note}</p>
          {client.lowConfidence.question ? <p className="mt-1">{client.lowConfidence.question}</p> : null}
        </div>
      ) : null}

      {client.engine === "hostaway-scan" ? (
        <p className="mt-3 text-xs" style={{ color: "var(--muted-text)" }}>
          No push engine connected — view only.
        </p>
      ) : null}

      {client.engine !== "hostaway-scan" ? (
        <button
          type="button"
          className="mt-3 flex w-full items-center justify-between rounded-2xl border px-3 py-2 text-left text-xs"
          style={{ borderColor: "var(--border)", color: "var(--muted-text)" }}
          title={
            client.belowFloorPending > 0
              ? `${client.belowFloorPending} pending recommendation${client.belowFloorPending === 1 ? "" : "s"} sit below the listing minimum right now — still sized from landed rates and market data. Turning this off clamps future generations at the minimum.`
              : "Default off. When on, the NEXT generation may recommend (and pushes may carry) prices below the listing minimum for this client — still sized from landed rates and market data. Prices you type yourself can always go below the minimum."
          }
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onToggleBelowFloor(client.tenantId, !client.allowBelowFloor);
          }}
        >
          <span>Allow recommendations below minimum</span>
          <span
            className="rounded-full border px-2.5 py-0.5 text-[11px] font-semibold"
            style={
              client.belowFloorPending > 0
                ? { borderColor: "rgba(187,75,82,0.4)", background: "var(--delta-negative)", color: "#fff" }
                : client.allowBelowFloor
                  ? { borderColor: "rgba(180,120,20,0.28)", background: "rgba(214,158,46,0.12)", color: "#8a5a12" }
                  : { borderColor: "var(--border)", color: "var(--muted-text)" }
            }
          >
            {client.belowFloorPending > 0
              ? `${client.allowBelowFloor ? "ON" : "off"} · ${client.belowFloorPending} below min`
              : client.allowBelowFloor
                ? "ON"
                : "off"}
          </span>
        </button>
      ) : null}

      {client.lastGeneratedAt ? (
        <p className="mt-3 text-[11px]" style={{ color: "var(--muted-text)" }}>
          Last generated {formatDateTime(client.lastGeneratedAt)}
        </p>
      ) : null}
    </Link>
  );
}

export default function RecsOverview({ initialClients }: { initialClients: RecsClientSummary[] }) {
  const [clients, setClients] = useState<RecsClientSummary[]>(initialClients);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRefresh() {
    setRefreshing(true);
    setError(null);
    try {
      const response = await fetch(withBasePath("/api/recs/overview"));
      const body = (await response.json().catch(() => ({}))) as { clients?: RecsClientSummary[]; error?: string };
      if (!response.ok || !body.clients) {
        throw new Error(body.error ?? "Failed to refresh");
      }
      setClients(body.clients);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Failed to refresh");
    } finally {
      setRefreshing(false);
    }
  }

  async function handleToggleBelowFloor(tenantId: string, next: boolean) {
    setError(null);
    try {
      const response = await fetch(withBasePath("/api/recs/client-settings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId, allowBelowFloor: next })
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Failed to save setting");
      setClients((prev) => prev.map((c) => (c.tenantId === tenantId ? { ...c, allowBelowFloor: next } : c)));
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : "Failed to save setting");
    }
  }

  return (
    <main className="app-shell relative min-h-screen px-5 py-10 sm:px-8">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <Link
              href="/dashboard"
              className="mb-2 inline-flex items-center gap-1 text-sm font-semibold"
              style={{ color: "var(--green-dark)" }}
            >
              ← Dashboard
            </Link>
            <h1 className="font-display text-3xl sm:text-4xl">Pricing Recommendations</h1>
            <p className="mt-1 text-sm" style={{ color: "var(--muted-text)" }}>
              Internal approvals surface — next 14 nights across every client.
            </p>
          </div>
          <button
            type="button"
            className="rounded-full border px-4 py-2 text-sm font-semibold disabled:opacity-60"
            style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
            disabled={refreshing}
            onClick={() => void handleRefresh()}
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        {error ? (
          <p className="mb-5 rounded-2xl border px-4 py-3 text-sm" style={{ borderColor: "rgba(187,75,82,0.2)", background: "rgba(187,75,82,0.08)", color: "var(--delta-negative)" }}>
            {error}
          </p>
        ) : null}

        {clients.length === 0 ? (
          <p className="glass-panel rounded-[24px] border px-5 py-6 text-sm" style={{ borderColor: "var(--border)", color: "var(--muted-text)" }}>
            No clients found.
          </p>
        ) : (
          <div className="space-y-4">
            {clients.map((client) => (
              <ClientCard key={client.tenantId} client={client} onToggleBelowFloor={(t, n) => void handleToggleBelowFloor(t, n)} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
