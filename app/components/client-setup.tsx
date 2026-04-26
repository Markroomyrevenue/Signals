"use client";

import Link from "next/link";
import { useState } from "react";
import { buildClientOpenHref, withBasePath } from "@/lib/base-path";

import WorkspaceLoadingScreen from "./workspace-loading-screen";

type ClientOption = {
  id: string;
  name: string;
  membershipRole?: "admin" | "viewer";
  canManage?: boolean;
};

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(withBasePath(url), init);
  const body = (await response.json().catch(() => ({}))) as { error?: string } & T;
  if (!response.ok) {
    throw new Error(body.error ?? "Request failed");
  }
  return body;
}

export default function ClientSetup({
  currentTenantId,
  clients
}: {
  currentTenantId: string;
  clients: ClientOption[];
}) {
  const [clientList, setClientList] = useState<ClientOption[]>(clients);
  const [switchingClientId, setSwitchingClientId] = useState<string | null>(null);
  const [deletingClientId, setDeletingClientId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
        const clientName = clients.find((client) => client.id === clientId)?.name ?? "portfolio";
        window.location.replace(buildClientOpenHref(clientName));
      }
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : "Failed to open portfolio");
      setSwitchingClientId(null);
    }
  }

  async function handleDeleteClient(clientId: string) {
    const client = clientList.find((entry) => entry.id === clientId);
    if (!client) return;
    if (
      !confirm(
        `Delete ${client.name}? This permanently removes that portfolio workspace, synced data, and any staff access for it.`
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
      setError(deleteError instanceof Error ? deleteError.message : "Failed to remove portfolio");
    } finally {
      setDeletingClientId(null);
    }
  }

  const pendingClientName = clientList.find((client) => client.id === switchingClientId)?.name ?? "portfolio";

  return (
    <main className="app-shell relative min-h-screen px-5 py-8 sm:px-8">
      {switchingClientId !== null ? (
        <WorkspaceLoadingScreen
          fixed
          title={`Opening ${pendingClientName}`}
          description="Checking sync freshness and preparing the selected portfolio workspace."
        />
      ) : null}

      <div className="mx-auto max-w-5xl space-y-6">
        <section className="glass-panel rounded-[32px] border px-6 py-6 sm:px-8" style={{ borderColor: "var(--border)" }}>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="max-w-2xl">
              <p className="text-xs font-semibold uppercase tracking-[0.32em]" style={{ color: "var(--muted-text)" }}>
                Portfolio Setup
              </p>
              <h1 className="font-display mt-3 text-4xl sm:text-5xl">Connected portfolios</h1>
            </div>
            <Link
              href="/dashboard"
              className="rounded-full border px-4 py-2 text-sm font-semibold"
              style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
            >
              Back to dashboard
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
        </section>

        <div className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
          <section className="glass-panel rounded-[32px] border p-6 sm:p-8" style={{ borderColor: "var(--border)" }}>
            <p className="text-xs font-semibold uppercase tracking-[0.28em]" style={{ color: "var(--muted-text)" }}>
              Add Portfolio
            </p>
            <h2 className="font-display mt-3 text-4xl">Create a new workspace</h2>
            <p className="mt-3 text-sm leading-7" style={{ color: "var(--muted-text)" }}>
              Add another portfolio and keep it separate from the rest of your portfolios.
            </p>
            <Link
              href="/dashboard/select-client/new"
              className="mt-6 inline-flex rounded-full px-4 py-3 text-sm font-semibold text-white"
              style={{ background: "var(--green-dark)" }}
            >
              Add portfolio
            </Link>
          </section>

          <section className="glass-panel rounded-[32px] border p-6 sm:p-8" style={{ borderColor: "var(--border)" }}>
            <p className="text-xs font-semibold uppercase tracking-[0.28em]" style={{ color: "var(--muted-text)" }}>
              Connected Portfolios
            </p>
            <div className="mt-6 space-y-3">
              {clientList.length === 0 ? (
                <p className="text-sm" style={{ color: "var(--muted-text)" }}>
                  No portfolios connected yet.
                </p>
              ) : (
                clientList.map((client) => (
                  <div
                    key={client.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border bg-white/82 px-4 py-4"
                    style={{ borderColor: "var(--border)" }}
                  >
                    <span className="min-w-0 text-base font-semibold">{client.name}</span>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="rounded-full px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                        style={{ background: "var(--green-dark)" }}
                        disabled={switchingClientId !== null || deletingClientId !== null}
                        onClick={() => void handleOpenClient(client.id)}
                      >
                        Open
                      </button>
                      {client.canManage && client.id !== currentTenantId ? (
                        <button
                          type="button"
                          className="rounded-full border border-red-200 px-4 py-2 text-sm font-semibold text-red-700 disabled:opacity-60"
                          disabled={switchingClientId !== null || deletingClientId !== null}
                          onClick={() => void handleDeleteClient(client.id)}
                        >
                          {deletingClientId === client.id ? "Removing..." : "Remove client"}
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
