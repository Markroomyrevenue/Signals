"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { buildClientOpenHref, withBasePath } from "@/lib/base-path";

import WorkspaceLoadingScreen from "./workspace-loading-screen";

type ClientSelectorOption = {
  id: string;
  name: string;
  hostawayAccountId: string | null;
  membershipRole: "admin" | "viewer";
  canManage: boolean;
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
  const [clientList, setClientList] = useState<ClientSelectorOption[]>(clients);
  const [switchingClientId, setSwitchingClientId] = useState<string | null>(null);
  const [deletingClientId, setDeletingClientId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  async function handleOpenClient(clientId: string) {
    setSwitchingClientId(clientId);
    setError(null);
    setNotice(null);

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

  async function handleDeleteClient(clientId: string) {
    const client = clientList.find((entry) => entry.id === clientId);
    if (!client) return;
    if (
      !confirm(
        `Delete ${client.name}? This permanently removes that client workspace, synced data, and any staff access for it.`
      )
    ) {
      return;
    }

    setDeletingClientId(clientId);
    setError(null);
    setNotice(null);
    try {
      await fetchJson(`/api/tenants/clients?tenantId=${encodeURIComponent(clientId)}`, {
        method: "DELETE"
      });
      setClientList((current) => current.filter((entry) => entry.id !== clientId));
      setNotice(`${client.name} was removed.`);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Failed to remove client");
    } finally {
      setDeletingClientId(null);
    }
  }

  const activeClientName = clientList.find((client) => client.id === switchingClientId)?.name ?? "client";
  const normalizedSearch = search.trim().toLowerCase();
  const visibleClients = useMemo(() => {
    return [...clientList]
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
  }, [clientList, currentTenantId, normalizedSearch]);

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
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="font-display text-3xl sm:text-4xl">Clients</h1>
            <Link
              href="/dashboard/select-client/new"
              className="rounded-full px-4 py-2 text-sm font-semibold text-white"
              style={{ background: "var(--green-dark)" }}
            >
              Add client
            </Link>
          </div>

          {error ? (
            <p className="mt-5 rounded-2xl border px-4 py-3 text-sm" style={{ borderColor: "rgba(187,75,82,0.2)", background: "rgba(187,75,82,0.08)", color: "var(--delta-negative)" }}>
              {error}
            </p>
          ) : null}
          {notice ? (
            <p className="mt-5 rounded-2xl border px-4 py-3 text-sm" style={{ borderColor: "rgba(22,71,51,0.16)", background: "rgba(22,71,51,0.05)", color: "var(--green-dark)" }}>
              {notice}
            </p>
          ) : null}

          {clientList.length > 6 ? (
            <input
              type="search"
              className="mt-5 w-full rounded-[20px] border bg-white px-4 py-3 text-sm outline-none transition focus-visible:border-emerald-700 focus-visible:ring-2 focus-visible:ring-emerald-100"
              style={{ borderColor: "var(--border)" }}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search clients"
            />
          ) : null}

          <div className="mt-5 space-y-2">
            {visibleClients.length === 0 ? (
              <p className="rounded-[18px] border bg-white/82 px-4 py-4 text-sm" style={{ borderColor: "var(--border)", color: "var(--muted-text)" }}>
                No clients yet.
              </p>
            ) : null}

            {visibleClients.map((client) => {
              return (
                <div
                  key={client.id}
                  className="flex items-center justify-between gap-3 rounded-[18px] border bg-white/82 px-4 py-3"
                  style={{ borderColor: "var(--border)" }}
                >
                  <span className="min-w-0 truncate text-base font-semibold">
                    {client.name}
                    {client.id === currentTenantId ? (
                      <span className="ml-2 text-xs font-normal" style={{ color: "var(--muted-text)" }}>(current)</span>
                    ) : null}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="rounded-full px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                      style={{ background: "var(--green-dark)" }}
                      disabled={switchingClientId !== null || deletingClientId !== null}
                      onClick={() => void handleOpenClient(client.id)}
                    >
                      Open
                    </button>
                    {client.canManage && client.id !== currentTenantId ? (
                      <button
                        type="button"
                        className="rounded-full border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-700 disabled:opacity-60"
                        disabled={switchingClientId !== null || deletingClientId !== null}
                        onClick={() => void handleDeleteClient(client.id)}
                      >
                        {deletingClientId === client.id ? "..." : "Remove"}
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </main>
  );
}
