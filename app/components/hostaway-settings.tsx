"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { buildClientOpenHref, withBasePath } from "@/lib/base-path";
import WorkspaceLoadingScreen from "./workspace-loading-screen";

type ConnectionStatusResponse = {
  dataMode: string;
  liveModeEnabled: boolean;
  hostawayClientId: string | null;
  hostawayAccountId: string | null;
  webhookBasicUser: string | null;
  hasClientSecret: boolean;
  tokenPresent: boolean;
  tokenExpiresAt: string | null;
  lastSyncAt: string | null;
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

type SyncStatusResponse = {
  connection: {
    status: string;
    lastSyncAt: string | null;
  } | null;
  queueCounts: Record<string, number>;
  recentRuns: Array<{
    id: string;
    status: string;
    createdAt: string;
  }>;
};

function formatDate(value: string | null): string {
  if (!value) return "n/a";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(withBasePath(url), init);
  const body = (await response.json().catch(() => ({}))) as { error?: string } & T;
  if (!response.ok) {
    throw new Error(body.error ?? "Request failed");
  }
  return body;
}

function StatusCard({
  label,
  value,
  detail,
  tone = "green"
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: "green" | "gold" | "blue";
}) {
  const borderColor =
    tone === "gold" ? "rgba(176,122,25,0.18)" : tone === "blue" ? "rgba(95,111,103,0.18)" : "rgba(22,71,51,0.16)";

  return (
    <div className="rounded-[22px] border bg-white/75 p-4" style={{ borderColor }}>
      <p className="text-xs font-semibold uppercase tracking-[0.24em]" style={{ color: "var(--muted-text)" }}>
        {label}
      </p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
      {detail ? (
        <p className="mt-2 text-sm leading-6" style={{ color: "var(--muted-text)" }}>
          {detail}
        </p>
      ) : null}
    </div>
  );
}

export default function HostawaySettingsPage() {
  const [status, setStatus] = useState<ConnectionStatusResponse | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatusResponse | null>(null);
  const [hostawayClientId, setHostawayClientId] = useState("");
  const [hostawayAccountId, setHostawayAccountId] = useState("");
  const [hostawayClientSecret, setHostawayClientSecret] = useState("");
  const [webhookBasicUser, setWebhookBasicUser] = useState("");
  const [webhookBasicPass, setWebhookBasicPass] = useState("");
  const [hostawayClientIdTouched, setHostawayClientIdTouched] = useState(false);
  const [hostawayAccountIdTouched, setHostawayAccountIdTouched] = useState(false);
  const [hostawayClientSecretTouched, setHostawayClientSecretTouched] = useState(false);
  const [webhookBasicUserTouched, setWebhookBasicUserTouched] = useState(false);
  const [webhookBasicPassTouched, setWebhookBasicPassTouched] = useState(false);

  const [clients, setClients] = useState<ClientOption[]>([]);
  const [currentTenantId, setCurrentTenantId] = useState("");
  const [renameByClientId, setRenameByClientId] = useState<Record<string, string>>({});

  const [loading, setLoading] = useState(true);
  const [clientsLoading, setClientsLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [loadingFromEnv, setLoadingFromEnv] = useState(false);
  const [switchingClientId, setSwitchingClientId] = useState<string | null>(null);
  const [renamingClientId, setRenamingClientId] = useState<string | null>(null);
  const [deletingClientId, setDeletingClientId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [clientMessage, setClientMessage] = useState<string | null>(null);
  const [showSlowLoadingScreen, setShowSlowLoadingScreen] = useState(false);

  useEffect(() => {
    void Promise.all([loadConnectionStatus(), loadClients(), loadSyncStatus()]);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (loading || clientsLoading || switchingClientId !== null) {
      setShowSlowLoadingScreen(false);
      return;
    }

    const isSlowAction = saving || testing || loadingFromEnv;
    if (!isSlowAction) {
      setShowSlowLoadingScreen(false);
      return;
    }

    const timer = window.setTimeout(() => setShowSlowLoadingScreen(true), 250);
    return () => {
      window.clearTimeout(timer);
    };
  }, [clientsLoading, loading, loadingFromEnv, saving, switchingClientId, testing]);

  async function loadConnectionStatus() {
    setLoading(true);
    try {
      const data = await fetchJson<ConnectionStatusResponse>("/api/hostaway/connection");
      setStatus(data);
      setHostawayClientId(data.hostawayClientId ?? "");
      setHostawayAccountId(data.hostawayAccountId ?? "");
      setWebhookBasicUser(data.webhookBasicUser ?? "");
      setHostawayClientSecret("");
      setWebhookBasicPass("");
      setHostawayClientIdTouched(false);
      setHostawayAccountIdTouched(false);
      setHostawayClientSecretTouched(false);
      setWebhookBasicUserTouched(false);
      setWebhookBasicPassTouched(false);
      setLoading(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load connection status");
      setLoading(false);
    }
  }

  async function loadClients() {
    setClientsLoading(true);
    try {
      const body = await fetchJson<ClientsResponse>("/api/tenants/clients");
      setClients(body.clients ?? []);
      setCurrentTenantId(body.currentTenantId ?? "");
      setRenameByClientId(Object.fromEntries((body.clients ?? []).map((client) => [client.id, client.name])));
      setClientsLoading(false);
    } catch (error) {
      setClientMessage(error instanceof Error ? error.message : "Failed to load clients");
      setClientsLoading(false);
    }
  }

  async function loadSyncStatus() {
    try {
      const body = await fetchJson<SyncStatusResponse>("/api/sync/status");
      setSyncStatus(body);
    } catch {
      setSyncStatus(null);
    }
  }

  async function handleSave() {
    setSaving(true);
    setMessage(null);

    const body: Record<string, string> = {};
    const wantsHostawayCredentialUpdate = hostawayClientIdTouched || hostawayClientSecretTouched;
    const clientIdTrimmed = hostawayClientId.trim();
    const clientSecretTrimmed = hostawayClientSecret.trim();

    if (wantsHostawayCredentialUpdate) {
      if (!clientIdTrimmed || !clientSecretTrimmed) {
        setMessage("Client ID and Client Secret must be entered together.");
        setSaving(false);
        return;
      }
      body.hostawayClientId = clientIdTrimmed;
      body.hostawayClientSecret = clientSecretTrimmed;
    }

    if (hostawayAccountIdTouched) body.hostawayAccountId = hostawayAccountId.trim();
    if (webhookBasicUserTouched) body.webhookBasicUser = webhookBasicUser.trim();
    if (webhookBasicPassTouched) body.webhookBasicPass = webhookBasicPass.trim();

    if (Object.keys(body).length === 0) {
      setMessage("There are no changes to save yet.");
      setSaving(false);
      return;
    }

    try {
      await fetchJson("/api/hostaway/connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      await Promise.all([loadConnectionStatus(), loadClients(), loadSyncStatus()]);
      setMessage("Connection settings updated.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  async function handleLoadFromEnv() {
    setLoadingFromEnv(true);
    setMessage(null);
    try {
      await fetchJson("/api/hostaway/connection/load-env", { method: "POST" });
      await Promise.all([loadConnectionStatus(), loadSyncStatus()]);
      setMessage("Credentials loaded from environment variables.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load from environment");
    } finally {
      setLoadingFromEnv(false);
    }
  }

  async function runConnectionTest() {
    setTesting(true);
    setMessage(null);
    try {
      await fetchJson("/api/hostaway/test");
      setMessage(`Connection test passed in ${status?.dataMode ?? "unknown"} mode.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Connection test failed");
    } finally {
      setTesting(false);
    }
  }

  async function handleRenameClient(tenantId: string) {
    const nextName = (renameByClientId[tenantId] ?? "").trim();
    if (!nextName) {
      setClientMessage("Client name is required.");
      return;
    }

    setRenamingClientId(tenantId);
    setClientMessage(null);
    try {
      await fetchJson("/api/tenants/clients", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId,
          clientName: nextName
        })
      });
      await loadClients();
      setClientMessage("Client name updated.");
    } catch (error) {
      setClientMessage(error instanceof Error ? error.message : "Failed to rename client");
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
        const nextClientName = clients.find((client) => client.id === tenantId)?.name ?? "client";
        window.location.replace(buildClientOpenHref(nextClientName));
      }
    } catch (error) {
      setClientMessage(error instanceof Error ? error.message : "Failed to switch client");
      setSwitchingClientId(null);
    }
  }

  async function handleDeleteClient(tenantId: string) {
    const client = clients.find((entry) => entry.id === tenantId);
    if (!client) return;

    if (
      !window.confirm(
        `Delete ${client.name}? This permanently removes that client workspace, synced data, and any staff access for it.`
      )
    ) {
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
      setClientMessage(error instanceof Error ? error.message : "Failed to remove client");
    } finally {
      setDeletingClientId(null);
    }
  }

  const liveState = status?.liveModeEnabled ? "Live" : "Demo / Sample";
  const tokenState = status?.tokenPresent ? "Valid" : "Missing";
  const queueWaitingCount = (syncStatus?.queueCounts.waiting ?? 0) + (syncStatus?.queueCounts.active ?? 0);
  const pendingSwitchClientName = clients.find((client) => client.id === switchingClientId)?.name ?? "client";
  const loadingTitle = switchingClientId !== null ? `Opening ${pendingSwitchClientName}` : "Signals";
  const loadingDescription =
    switchingClientId !== null
      ? "Switching tenant context and checking whether the selected client needs a fresh sync."
      : "Loading your settings workspace";

  if (loading || clientsLoading) {
    return <WorkspaceLoadingScreen title={loadingTitle} description={loadingDescription} />;
  }

  return (
    <main className="app-shell relative min-h-screen px-5 py-6 sm:px-8 md:px-10">
      {switchingClientId !== null || showSlowLoadingScreen ? (
        <WorkspaceLoadingScreen
          fixed
          title={loadingTitle}
          description={switchingClientId !== null ? loadingDescription : "Working on your latest settings change."}
        />
      ) : null}
      <div className="mx-auto max-w-7xl space-y-6">
        <section className="glass-panel rounded-[32px] border px-6 py-6 sm:px-8" style={{ borderColor: "var(--border)" }}>
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.32em]" style={{ color: "var(--muted-text)" }}>
                Settings
              </p>
              <h1 className="font-display mt-3 text-4xl leading-tight text-balance sm:text-5xl">Client setup and connection health</h1>
              <p className="mt-4 text-sm leading-7 sm:text-base" style={{ color: "var(--muted-text)" }}>
                Configure credentials, monitor sync status, and manage multiple client portfolios from one trusted workspace.
              </p>
            </div>
            <Link
              href="/dashboard"
              className="rounded-full border px-4 py-2 text-sm font-semibold"
              style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
            >
              Back to dashboard
            </Link>
          </div>

          {message ? (
            <p className="mt-5 rounded-2xl border px-4 py-3 text-sm" style={{ borderColor: "rgba(22,71,51,0.16)", background: "rgba(31,122,77,0.08)" }}>
              {message}
            </p>
          ) : null}
        </section>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="space-y-6">
            <section className="glass-panel rounded-[32px] border p-6" style={{ borderColor: "var(--border)" }}>
              <p className="text-xs font-semibold uppercase tracking-[0.28em]" style={{ color: "var(--muted-text)" }}>
                Current Client
              </p>
              <h2 className="font-display mt-3 text-[2rem] sm:text-[2.35rem]">Hostaway connection</h2>
              <p className="mt-3 text-sm leading-7" style={{ color: "var(--muted-text)" }}>
                Keep these credentials clean and accurate. Roomy uses them to refresh reservations, rates, and revenue signals.
              </p>

              <div className="mt-6 grid gap-4 lg:grid-cols-2">
                <div className="rounded-[24px] border bg-white/75 p-5" style={{ borderColor: "var(--border)" }}>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                    API credentials
                  </p>
                  <div className="mt-4 grid gap-4">
                    <label className="block text-sm font-medium">
                      <span style={{ color: "var(--muted-text)" }}>Client ID</span>
                      <input
                        className="mt-2 w-full rounded-[20px] border bg-white px-4 py-3 outline-none"
                        style={{ borderColor: "var(--border)" }}
                        type="text"
                        value={hostawayClientId}
                        onChange={(event) => {
                          setHostawayClientId(event.target.value);
                          setHostawayClientIdTouched(true);
                        }}
                        placeholder="Hostaway Client ID"
                      />
                    </label>
                    <label className="block text-sm font-medium">
                      <span style={{ color: "var(--muted-text)" }}>Client Secret</span>
                      <input
                        className="mt-2 w-full rounded-[20px] border bg-white px-4 py-3 outline-none"
                        style={{ borderColor: "var(--border)" }}
                        type="password"
                        value={hostawayClientSecret}
                        onChange={(event) => {
                          setHostawayClientSecret(event.target.value);
                          setHostawayClientSecretTouched(true);
                        }}
                        placeholder="Leave blank to keep current secret"
                      />
                    </label>
                    <label className="block text-sm font-medium">
                      <span style={{ color: "var(--muted-text)" }}>Account ID</span>
                      <input
                        className="mt-2 w-full rounded-[20px] border bg-white px-4 py-3 outline-none"
                        style={{ borderColor: "var(--border)" }}
                        type="text"
                        value={hostawayAccountId}
                        onChange={(event) => {
                          setHostawayAccountId(event.target.value);
                          setHostawayAccountIdTouched(true);
                        }}
                        placeholder="Optional Hostaway account ID"
                      />
                    </label>
                  </div>
                </div>

                <div className="rounded-[24px] border bg-white/75 p-5" style={{ borderColor: "var(--border)" }}>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                    Webhook access
                  </p>
                  <p className="mt-3 text-sm leading-6" style={{ color: "var(--muted-text)" }}>
                    Keep webhook auth separate from the API credentials so rotation is simpler later.
                  </p>
                  <div className="mt-4 grid gap-4">
                    <label className="block text-sm font-medium">
                      <span style={{ color: "var(--muted-text)" }}>Webhook Username</span>
                      <input
                        className="mt-2 w-full rounded-[20px] border bg-white px-4 py-3 outline-none"
                        style={{ borderColor: "var(--border)" }}
                        type="text"
                        value={webhookBasicUser}
                        onChange={(event) => {
                          setWebhookBasicUser(event.target.value);
                          setWebhookBasicUserTouched(true);
                        }}
                        placeholder="Optional basic auth user"
                      />
                    </label>
                    <label className="block text-sm font-medium">
                      <span style={{ color: "var(--muted-text)" }}>Webhook Password</span>
                      <input
                        className="mt-2 w-full rounded-[20px] border bg-white px-4 py-3 outline-none"
                        style={{ borderColor: "var(--border)" }}
                        type="password"
                        value={webhookBasicPass}
                        onChange={(event) => {
                          setWebhookBasicPass(event.target.value);
                          setWebhookBasicPassTouched(true);
                        }}
                        placeholder="Leave blank to keep current password"
                      />
                    </label>
                  </div>
                </div>
              </div>

              <div className="mt-6 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  className="rounded-full px-4 py-3 text-sm font-semibold text-white"
                  style={{ background: "var(--green-dark)" }}
                  disabled={saving}
                >
                  {saving ? "Saving..." : "Save connection"}
                </button>
                <button
                  type="button"
                  onClick={() => void handleLoadFromEnv()}
                  className="rounded-full border px-4 py-3 text-sm font-semibold"
                  style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
                  disabled={loadingFromEnv}
                >
                  {loadingFromEnv ? "Loading..." : "Load from .env"}
                </button>
                <button
                  type="button"
                  onClick={() => void runConnectionTest()}
                  className="rounded-full border px-4 py-3 text-sm font-semibold"
                  style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
                  disabled={testing}
                >
                  {testing ? "Testing..." : "Test connection"}
                </button>
              </div>
            </section>

            <section className="glass-panel rounded-[32px] border p-6" style={{ borderColor: "var(--border)" }}>
              <p className="text-xs font-semibold uppercase tracking-[0.28em]" style={{ color: "var(--muted-text)" }}>
                Connected Clients
              </p>
              <h2 className="font-display mt-3 text-[2rem] sm:text-[2.35rem]">Portfolio list</h2>
              {clientMessage ? (
                <p className="mt-4 rounded-2xl border px-4 py-3 text-sm" style={{ borderColor: "rgba(22,71,51,0.12)", background: "rgba(22,71,51,0.05)" }}>
                  {clientMessage}
                </p>
              ) : null}
              <div className="mt-6 space-y-4">
                {clientsLoading ? (
                  <p className="text-sm" style={{ color: "var(--muted-text)" }}>
                    Loading client portfolios...
                  </p>
                ) : clients.length === 0 ? (
                  <p className="text-sm" style={{ color: "var(--muted-text)" }}>
                    No clients connected yet.
                  </p>
                ) : (
                  clients.map((client) => (
                    <div key={client.id} className="rounded-[24px] border bg-white/75 p-5" style={{ borderColor: "var(--border)" }}>
                      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                        <div className="min-w-0 flex-1">
                          <label className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                            Client name
                          </label>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <input
                              type="text"
                              className="min-w-[220px] flex-1 rounded-[18px] border bg-white px-4 py-3 text-sm outline-none"
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
                              className="rounded-full border px-4 py-2 text-sm font-semibold"
                              style={{ borderColor: "var(--border-strong)" }}
                              disabled={renamingClientId !== null || deletingClientId !== null}
                              onClick={() => void handleRenameClient(client.id)}
                            >
                              {renamingClientId === client.id ? "Saving..." : "Save"}
                            </button>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {client.id === currentTenantId ? (
                            <span className="rounded-full border px-4 py-2 text-sm font-semibold" style={{ borderColor: "var(--border-strong)" }}>
                              Current
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="rounded-full px-4 py-2 text-sm font-semibold text-white"
                              style={{ background: "var(--green-dark)" }}
                              disabled={switchingClientId !== null || deletingClientId !== null}
                              onClick={() => void handleSwitchClient(client.id)}
                            >
                              {switchingClientId === client.id ? "Switching..." : "Switch to client"}
                            </button>
                          )}
                          {client.canManage && client.id !== currentTenantId ? (
                            <button
                              type="button"
                              className="rounded-full border border-red-200 px-4 py-2 text-sm font-semibold text-red-700"
                              disabled={switchingClientId !== null || deletingClientId !== null || renamingClientId !== null}
                              onClick={() => void handleDeleteClient(client.id)}
                            >
                              {deletingClientId === client.id ? "Removing..." : "Remove client"}
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>

          <aside className="space-y-6 xl:sticky xl:top-6 xl:self-start">
            <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-2">
              <StatusCard label="Mode" value={loading ? "Loading..." : liveState} detail="Whether this tenant is using live Hostaway credentials or sample/demo data." />
              <StatusCard label="Token" value={loading ? "Loading..." : tokenState} detail={loading ? undefined : `Expiry ${formatDate(status?.tokenExpiresAt ?? null)}`} tone="blue" />
              <StatusCard label="Last Sync" value={formatDate(status?.lastSyncAt ?? null)} detail="The latest completed pull for this client." tone="gold" />
              <StatusCard label="Queue" value={String(queueWaitingCount)} detail="Jobs currently waiting or running in the background." />
            </section>

            <section className="glass-panel rounded-[32px] border p-6" style={{ borderColor: "var(--border)" }}>
              <p className="text-xs font-semibold uppercase tracking-[0.28em]" style={{ color: "var(--muted-text)" }}>
                Operational Health
              </p>
              <h2 className="font-display mt-3 text-[2rem] sm:text-[2.2rem]">Sync status</h2>

              <div className="mt-6 space-y-4">
                <div className="rounded-[24px] border bg-white/75 p-5" style={{ borderColor: "var(--border)" }}>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                    Connection status
                  </p>
                  <p className="mt-3 text-3xl font-semibold">{syncStatus?.connection?.status ?? "Unknown"}</p>
                  <p className="mt-2 text-sm leading-6" style={{ color: "var(--muted-text)" }}>
                    Latest pull finished {formatDate(syncStatus?.connection?.lastSyncAt ?? null)}.
                  </p>
                </div>

                <div className="rounded-[24px] border bg-white/75 p-5" style={{ borderColor: "var(--border)" }}>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                    Queue counts
                  </p>
                  <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                    {Object.entries(syncStatus?.queueCounts ?? {}).map(([key, value]) => (
                      <div key={key} className="rounded-2xl px-3 py-3" style={{ background: "rgba(247, 242, 230, 0.88)" }}>
                        <p className="font-semibold capitalize">{key}</p>
                        <p className="mt-1 text-2xl">{value}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-[24px] border bg-white/75 p-5" style={{ borderColor: "var(--border)" }}>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                    Latest runs
                  </p>
                  <div className="mt-3 space-y-3">
                    {(syncStatus?.recentRuns ?? []).slice(0, 5).map((run) => (
                      <div key={run.id} className="rounded-2xl px-3 py-3" style={{ background: "rgba(247, 242, 230, 0.88)" }}>
                        <p className="font-semibold capitalize">{run.status}</p>
                        <p className="mt-1 text-sm" style={{ color: "var(--muted-text)" }}>
                          {formatDate(run.createdAt)}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </section>

            <section className="glass-panel rounded-[32px] border p-6" style={{ borderColor: "var(--border)" }}>
              <p className="text-xs font-semibold uppercase tracking-[0.28em]" style={{ color: "var(--muted-text)" }}>
                Team Access
              </p>
              <h2 className="font-display mt-3 text-[2rem] sm:text-[2.2rem]">Add users and choose clients</h2>
              <p className="mt-3 text-sm leading-7" style={{ color: "var(--muted-text)" }}>
                Invite a teammate, then choose exactly which client workspaces they can open after login.
              </p>
              <div className="mt-6 rounded-[24px] border bg-white/75 p-5" style={{ borderColor: "var(--border)" }}>
                <p className="text-sm leading-7" style={{ color: "var(--muted-text)" }}>
                  Team access lives in a dedicated settings page so you can manage roles and client visibility in one place.
                </p>
                <Link
                  href="/dashboard/team"
                  className="mt-5 inline-flex rounded-full px-4 py-3 text-sm font-semibold text-white"
                  style={{ background: "var(--green-dark)" }}
                >
                  Manage team access
                </Link>
              </div>
            </section>

            <section className="glass-panel rounded-[32px] border p-6" style={{ borderColor: "var(--border)" }}>
              <p className="text-xs font-semibold uppercase tracking-[0.28em]" style={{ color: "var(--muted-text)" }}>
                Client Setup
              </p>
              <h2 className="font-display mt-3 text-[2rem] sm:text-[2.2rem]">Add another client</h2>
              <p className="mt-3 text-sm leading-7" style={{ color: "var(--muted-text)" }}>
                Use the dedicated add-client flow to create a new workspace while keeping the same login. Shared client lists only show client names.
              </p>
              <div className="mt-6 rounded-[24px] border bg-white/75 p-5" style={{ borderColor: "var(--border)" }}>
                <p className="text-sm leading-7" style={{ color: "var(--muted-text)" }}>
                  You can add the client name plus Hostaway connection details on a separate page without exposing any existing client credentials here.
                </p>
                <Link
                  href="/dashboard/select-client/new"
                  className="mt-5 inline-flex rounded-full px-4 py-3 text-sm font-semibold text-white"
                  style={{ background: "var(--green-dark)" }}
                >
                  Add client
                </Link>
              </div>
            </section>
          </aside>
        </div>
      </div>
    </main>
  );
}
