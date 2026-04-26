"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { buildClientOpenHref, withBasePath } from "@/lib/base-path";
import WorkspaceLoadingScreen from "./workspace-loading-screen";

type ConnectionStatusResponse = {
  hostawayClientId: string | null;
  hostawayAccountId: string | null;
};

type ClientOption = {
  id: string;
  name: string;
  hostawayAccountId: string | null;
  membershipRole: "admin" | "viewer";
  canManage: boolean;
};

type ClientsResponse = {
  currentTenantId: string;
  clients: ClientOption[];
};

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(withBasePath(url), init);
  const body = (await response.json().catch(() => ({}))) as { error?: string } & T;
  if (!response.ok) {
    throw new Error(body.error ?? "Request failed");
  }
  return body;
}

export default function HostawaySettingsPage() {
  const [hostawayClientId, setHostawayClientId] = useState("");
  const [hostawayAccountId, setHostawayAccountId] = useState("");
  const [hostawayClientSecret, setHostawayClientSecret] = useState("");
  const [clientIdTouched, setClientIdTouched] = useState(false);
  const [accountIdTouched, setAccountIdTouched] = useState(false);
  const [secretTouched, setSecretTouched] = useState(false);

  const [clients, setClients] = useState<ClientOption[]>([]);
  const [currentTenantId, setCurrentTenantId] = useState("");
  const [renameByClientId, setRenameByClientId] = useState<Record<string, string>>({});

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [switchingClientId, setSwitchingClientId] = useState<string | null>(null);
  const [renamingClientId, setRenamingClientId] = useState<string | null>(null);
  const [deletingClientId, setDeletingClientId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [clientMessage, setClientMessage] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([loadConnection(), loadClients()]).finally(() => setLoading(false));
  }, []);

  async function loadConnection() {
    try {
      const data = await fetchJson<ConnectionStatusResponse>("/api/hostaway/connection");
      setHostawayClientId(data.hostawayClientId ?? "");
      setHostawayAccountId(data.hostawayAccountId ?? "");
      setHostawayClientSecret("");
      setClientIdTouched(false);
      setAccountIdTouched(false);
      setSecretTouched(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load connection");
    }
  }

  async function loadClients() {
    try {
      const body = await fetchJson<ClientsResponse>("/api/tenants/clients");
      setClients(body.clients ?? []);
      setCurrentTenantId(body.currentTenantId ?? "");
      setRenameByClientId(
        Object.fromEntries((body.clients ?? []).map((client) => [client.id, client.name]))
      );
    } catch (error) {
      setClientMessage(error instanceof Error ? error.message : "Failed to load clients");
    }
  }

  async function handleSave() {
    setSaving(true);
    setMessage(null);

    const body: Record<string, string> = {};
    const wantsCredentialUpdate = clientIdTouched || secretTouched;
    const clientIdTrimmed = hostawayClientId.trim();
    const secretTrimmed = hostawayClientSecret.trim();

    if (wantsCredentialUpdate) {
      if (!clientIdTrimmed || !secretTrimmed) {
        setMessage("Client ID and Client Secret must be entered together.");
        setSaving(false);
        return;
      }
      body.hostawayClientId = clientIdTrimmed;
      body.hostawayClientSecret = secretTrimmed;
    }

    if (accountIdTouched) body.hostawayAccountId = hostawayAccountId.trim();

    if (Object.keys(body).length === 0) {
      setMessage("No changes to save.");
      setSaving(false);
      return;
    }

    try {
      await fetchJson("/api/hostaway/connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      await loadConnection();
      setMessage("Saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleRenameClient(tenantId: string) {
    const nextName = (renameByClientId[tenantId] ?? "").trim();
    if (!nextName) {
      setClientMessage("Name is required.");
      return;
    }

    setRenamingClientId(tenantId);
    setClientMessage(null);
    try {
      await fetchJson("/api/tenants/clients", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId, clientName: nextName })
      });
      await loadClients();
      setClientMessage("Renamed.");
    } catch (error) {
      setClientMessage(error instanceof Error ? error.message : "Failed to rename");
    } finally {
      setRenamingClientId(null);
    }
  }

  async function handleSwitchClient(tenantId: string) {
    if (!tenantId || tenantId === currentTenantId) return;

    setSwitchingClientId(tenantId);
    setClientMessage(null);
    try {
      await fetchJson("/api/tenants/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId })
      });
      if (typeof window !== "undefined") {
        const nextClientName = clients.find((client) => client.id === tenantId)?.name ?? "portfolio";
        window.location.replace(buildClientOpenHref(nextClientName));
      }
    } catch (error) {
      setClientMessage(error instanceof Error ? error.message : "Failed to switch");
      setSwitchingClientId(null);
    }
  }

  async function handleDeleteClient(tenantId: string) {
    const client = clients.find((entry) => entry.id === tenantId);
    if (!client) return;

    if (!window.confirm(`Delete ${client.name}? This permanently removes that portfolio and all its synced data.`)) {
      return;
    }

    setDeletingClientId(tenantId);
    setClientMessage(null);
    try {
      await fetchJson(`/api/tenants/clients?tenantId=${encodeURIComponent(tenantId)}`, {
        method: "DELETE"
      });
      await loadClients();
      setClientMessage(`${client.name} was removed.`);
    } catch (error) {
      setClientMessage(error instanceof Error ? error.message : "Failed to remove");
    } finally {
      setDeletingClientId(null);
    }
  }

  if (loading) {
    return <WorkspaceLoadingScreen title="Settings" description="Loading." />;
  }

  const pendingSwitchClientName = clients.find((client) => client.id === switchingClientId)?.name ?? "portfolio";

  return (
    <main className="app-shell relative min-h-screen px-5 py-8 sm:px-8">
      {switchingClientId !== null ? (
        <WorkspaceLoadingScreen
          fixed
          title={`Opening ${pendingSwitchClientName}`}
          description="Switching client."
        />
      ) : null}

      <div className="mx-auto max-w-3xl space-y-5">
        <header className="flex items-baseline justify-between gap-3">
          <h1 className="font-display text-3xl sm:text-4xl">Settings</h1>
          <Link
            href="/dashboard"
            className="text-sm font-semibold"
            style={{ color: "var(--green-dark)" }}
          >
            ← Dashboard
          </Link>
        </header>

        <section className="glass-panel rounded-[24px] border p-5 sm:p-6" style={{ borderColor: "var(--border)" }}>
          <h2 className="font-display text-lg">Hostaway credentials</h2>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--muted-text)" }}>
                Client ID
              </span>
              <input
                className="mt-1 w-full rounded-xl border bg-white px-3 py-2 text-sm outline-none"
                style={{ borderColor: "var(--border)" }}
                type="text"
                value={hostawayClientId}
                onChange={(event) => {
                  setHostawayClientId(event.target.value);
                  setClientIdTouched(true);
                }}
              />
            </label>
            <label className="block text-sm">
              <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--muted-text)" }}>
                Account ID
              </span>
              <input
                className="mt-1 w-full rounded-xl border bg-white px-3 py-2 text-sm outline-none"
                style={{ borderColor: "var(--border)" }}
                type="text"
                value={hostawayAccountId}
                onChange={(event) => {
                  setHostawayAccountId(event.target.value);
                  setAccountIdTouched(true);
                }}
              />
            </label>
            <label className="block text-sm sm:col-span-2">
              <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--muted-text)" }}>
                Client Secret
              </span>
              <input
                className="mt-1 w-full rounded-xl border bg-white px-3 py-2 text-sm outline-none"
                style={{ borderColor: "var(--border)" }}
                type="password"
                value={hostawayClientSecret}
                onChange={(event) => {
                  setHostawayClientSecret(event.target.value);
                  setSecretTouched(true);
                }}
                placeholder="Leave blank to keep current secret"
              />
            </label>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={() => void handleSave()}
              className="rounded-full px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
              style={{ background: "var(--green-dark)" }}
              disabled={saving}
            >
              {saving ? "Saving..." : "Save"}
            </button>
            {message ? <span className="text-sm" style={{ color: "var(--muted-text)" }}>{message}</span> : null}
          </div>
        </section>

        <section className="glass-panel rounded-[24px] border p-5 sm:p-6" style={{ borderColor: "var(--border)" }}>
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="font-display text-lg">Portfolios</h2>
            <Link
              href="/dashboard/select-client/new"
              className="rounded-full px-3 py-1.5 text-xs font-semibold text-white"
              style={{ background: "var(--green-dark)" }}
            >
              Add portfolio
            </Link>
          </div>

          {clientMessage ? (
            <p className="mt-3 text-sm" style={{ color: "var(--muted-text)" }}>
              {clientMessage}
            </p>
          ) : null}

          <div className="mt-4 space-y-2">
            {clients.length === 0 ? (
              <p className="text-sm" style={{ color: "var(--muted-text)" }}>
                No clients yet.
              </p>
            ) : (
              clients.map((client) => (
                <div
                  key={client.id}
                  className="flex flex-wrap items-center gap-2 rounded-[16px] border bg-white/80 px-3 py-2"
                  style={{ borderColor: "var(--border)" }}
                >
                  <input
                    type="text"
                    className="min-w-0 flex-1 rounded-lg border bg-white px-3 py-1.5 text-sm outline-none"
                    style={{ borderColor: "var(--border)" }}
                    value={renameByClientId[client.id] ?? client.name}
                    onChange={(event) =>
                      setRenameByClientId((current) => ({
                        ...current,
                        [client.id]: event.target.value
                      }))
                    }
                  />
                  <button
                    type="button"
                    className="rounded-full border px-3 py-1 text-xs font-semibold"
                    style={{ borderColor: "var(--border-strong)" }}
                    disabled={renamingClientId !== null}
                    onClick={() => void handleRenameClient(client.id)}
                  >
                    {renamingClientId === client.id ? "..." : "Rename"}
                  </button>
                  {client.id === currentTenantId ? (
                    <span className="rounded-full px-3 py-1 text-xs font-semibold" style={{ color: "var(--green-dark)" }}>
                      Current
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="rounded-full px-3 py-1 text-xs font-semibold text-white disabled:opacity-60"
                      style={{ background: "var(--green-dark)" }}
                      disabled={switchingClientId !== null || deletingClientId !== null}
                      onClick={() => void handleSwitchClient(client.id)}
                    >
                      {switchingClientId === client.id ? "..." : "Switch"}
                    </button>
                  )}
                  {client.canManage && client.id !== currentTenantId ? (
                    <button
                      type="button"
                      className="rounded-full border border-red-200 px-3 py-1 text-xs font-semibold text-red-700 disabled:opacity-60"
                      disabled={switchingClientId !== null || deletingClientId !== null}
                      onClick={() => void handleDeleteClient(client.id)}
                    >
                      {deletingClientId === client.id ? "..." : "Remove"}
                    </button>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </section>

        <section className="glass-panel rounded-[24px] border p-5 sm:p-6" style={{ borderColor: "var(--border)" }}>
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-display text-lg">Team</h2>
            <Link
              href="/dashboard/team"
              className="rounded-full px-3 py-1.5 text-xs font-semibold text-white"
              style={{ background: "var(--green-dark)" }}
            >
              Manage team
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
