"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { buildClientOpenHref, withBasePath } from "@/lib/base-path";

import WorkspaceLoadingScreen from "./workspace-loading-screen";

type ClientSelectorOption = {
  id: string;
  name: string;
  hostawayAccountId: string | null;
};

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(withBasePath(url), init);
  const body = (await response.json().catch(() => ({}))) as { error?: string } & T;
  if (!response.ok) {
    throw new Error(body.error ?? "Request failed");
  }
  return body;
}

export default function ClientSelector({
  currentTenantId,
  clients
}: {
  currentTenantId: string;
  clients: ClientSelectorOption[];
}) {
  const [switchingClientId, setSwitchingClientId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  async function handleOpenClient(clientId: string) {
    setSwitchingClientId(clientId);
    setError(null);

    try {
      if (clientId !== currentTenantId) {
        await fetchJson("/api/tenants/switch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tenantId: clientId })
        });
      }

      if (typeof window !== "undefined") {
        const clientName = clients.find((client) => client.id === clientId)?.name ?? "client";
        window.location.assign(buildClientOpenHref(clientName));
      }
    } catch (switchError) {
      setError(switchError instanceof Error ? switchError.message : "Failed to open client");
      setSwitchingClientId(null);
    }
  }

  const activeClientName = clients.find((client) => client.id === switchingClientId)?.name ?? "client";
  const normalizedSearch = search.trim().toLowerCase();
  const visibleClients = useMemo(() => {
    return [...clients]
      .sort((left, right) => {
        if (left.id === currentTenantId) return -1;
        if (right.id === currentTenantId) return 1;
        return left.name.localeCompare(right.name, "en-GB", { sensitivity: "base" });
      })
      .filter((client) => {
        if (!normalizedSearch) return true;
        return (
          client.name.toLowerCase().includes(normalizedSearch) ||
          (client.hostawayAccountId ?? "").toLowerCase().includes(normalizedSearch)
        );
      });
  }, [clients, currentTenantId, normalizedSearch]);

  return (
    <main className="app-shell relative min-h-screen px-5 py-10 sm:px-8">
      {switchingClientId !== null ? (
        <WorkspaceLoadingScreen
          fixed
          title={`Opening ${activeClientName}`}
          description="Checking sync freshness and preparing the selected client workspace."
        />
      ) : null}

      <div className="mx-auto max-w-3xl">
        <section className="glass-panel rounded-[32px] border p-6 sm:p-8" style={{ borderColor: "var(--border)" }}>
          <h1 className="font-display text-4xl sm:text-5xl">Open a client workspace</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6" style={{ color: "var(--muted-text)" }}>
            Pick the client you want to work in next and jump straight back into that portfolio.
          </p>

          {error ? (
            <p className="mt-5 rounded-2xl border px-4 py-3 text-sm" style={{ borderColor: "rgba(187,75,82,0.2)", background: "rgba(187,75,82,0.08)", color: "var(--delta-negative)" }}>
              {error}
            </p>
          ) : null}

          <div className="mt-6 space-y-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <label className="block flex-1 text-sm font-medium">
                <span style={{ color: "var(--muted-text)" }}>Search clients</span>
                <input
                  type="search"
                  className="mt-2 w-full rounded-[20px] border bg-white px-4 py-3 outline-none transition focus-visible:border-emerald-700 focus-visible:ring-2 focus-visible:ring-emerald-100"
                  style={{ borderColor: "var(--border)" }}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search by client name or Hostaway account"
                />
              </label>
              <p className="pb-1 text-sm font-semibold" style={{ color: "var(--muted-text)" }}>
                {visibleClients.length} client{visibleClients.length === 1 ? "" : "s"}
              </p>
            </div>

            {visibleClients.length === 0 ? (
              <p className="rounded-[22px] border bg-white/82 px-4 py-4 text-sm" style={{ borderColor: "var(--border)", color: "var(--muted-text)" }}>
                No clients match that search yet.
              </p>
            ) : null}

            {visibleClients.map((client) => {
              return (
                <div
                  key={client.id}
                  className="flex flex-col gap-3 rounded-[22px] border bg-white/82 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
                  style={{ borderColor: "var(--border)" }}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 text-base font-semibold">{client.name}</span>
                      {client.id === currentTenantId ? (
                        <span className="rounded-full border px-2.5 py-1 text-[11px] font-semibold" style={{ borderColor: "rgba(22,71,51,0.16)", color: "var(--green-dark)" }}>
                          Current
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-sm" style={{ color: "var(--muted-text)" }}>
                      {client.hostawayAccountId ? `Hostaway account ${client.hostawayAccountId}` : "Hostaway account still needs an ID"}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="rounded-full px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                    style={{ background: "var(--green-dark)" }}
                    disabled={switchingClientId !== null}
                    onClick={() => void handleOpenClient(client.id)}
                  >
                    Open workspace
                  </button>
                </div>
              );
            })}
          </div>

          <p className="mt-6 text-sm" style={{ color: "var(--muted-text)" }}>
            Need to add a new client?{" "}
            <Link href="/dashboard/select-client/new" className="font-semibold" style={{ color: "var(--green-dark)" }}>
              Add client
            </Link>
          </p>
        </section>
      </div>
    </main>
  );
}
