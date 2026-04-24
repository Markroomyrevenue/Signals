"use client";

import Link from "next/link";
import { useState } from "react";
import { withBasePath } from "@/lib/base-path";

import WorkspaceLoadingScreen from "./workspace-loading-screen";

type MessageTone = "error" | "success";

type CreateClientResponse = {
  success: boolean;
  requiresProvisioning?: boolean;
  client: {
    id: string;
    name: string;
  };
};

function buildProvisioningHref(clientName: string): string {
  return withBasePath(`/dashboard/select-client/new/provisioning?client=${encodeURIComponent(clientName)}`);
}

function extractErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;

  const error = (body as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (!error || typeof error !== "object") return null;

  const fieldErrors = (error as { fieldErrors?: Record<string, string[] | undefined> }).fieldErrors;
  if (fieldErrors && typeof fieldErrors === "object") {
    const firstMessage = Object.values(fieldErrors).flat().find((message) => typeof message === "string");
    if (firstMessage) return firstMessage;
  }

  return null;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(withBasePath(url), init);
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(extractErrorMessage(body) ?? "Request failed");
  }

  return body as T;
}

export default function ClientCreateForm() {
  const [clientName, setClientName] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [accountId, setAccountId] = useState("");
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageTone, setMessageTone] = useState<MessageTone>("success");

  async function handleCreateClient() {
    const trimmedClientName = clientName.trim();
    const trimmedClientId = clientId.trim();
    const trimmedClientSecret = clientSecret.trim();
    const trimmedAccountId = accountId.trim();
    let redirected = false;

    if (!trimmedClientName) {
      setMessage("Client name is required.");
      setMessageTone("error");
      return;
    }

    if (!trimmedClientId || !trimmedClientSecret) {
      setMessage("Client ID and Client Secret are required.");
      setMessageTone("error");
      return;
    }

    setCreating(true);
    setMessage(null);

    try {
      const created = await fetchJson<CreateClientResponse>("/api/tenants/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName: trimmedClientName,
          apiKey: trimmedClientId,
          apiPin: trimmedClientSecret,
          accountPin: trimmedAccountId
        })
      });
      await fetchJson("/api/tenants/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId: created.client.id })
      });

      if (typeof window !== "undefined") {
        redirected = true;
        window.location.replace(buildProvisioningHref(created.client.name));
        return;
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to create client");
      setMessageTone("error");
    } finally {
      if (!redirected) {
        setCreating(false);
      }
    }
  }

  return (
    <main className="app-shell relative min-h-screen px-5 py-10 sm:px-8">
      {creating ? (
        <WorkspaceLoadingScreen
          fixed
          title="Creating client"
          description="Verifying credentials and preparing the workspace. The first sync will continue on the next screen."
        />
      ) : null}

      <div className="mx-auto max-w-3xl space-y-6">
        <section className="glass-panel rounded-[32px] border px-6 py-6 sm:px-8" style={{ borderColor: "var(--border)" }}>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="max-w-2xl">
              <p className="text-xs font-semibold uppercase tracking-[0.32em]" style={{ color: "var(--muted-text)" }}>
                Client Setup
              </p>
              <h1 className="font-display mt-3 text-4xl sm:text-5xl">Add Client</h1>
              <p className="mt-4 text-sm leading-7 sm:text-base" style={{ color: "var(--muted-text)" }}>
                Create a new workspace for another client. Shared client lists only show the client name, not the connection details behind it.
              </p>
            </div>
            <Link
              href="/dashboard/select-client"
              className="rounded-full border px-4 py-2 text-sm font-semibold"
              style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
            >
              Back to selector
            </Link>
          </div>

          {message ? (
            <p
              className="mt-5 rounded-2xl border px-4 py-3 text-sm"
              style={
                messageTone === "error"
                  ? { borderColor: "rgba(187,75,82,0.2)", background: "rgba(187,75,82,0.08)", color: "var(--delta-negative)" }
                  : { borderColor: "rgba(22,71,51,0.16)", background: "rgba(31,122,77,0.08)" }
              }
            >
              {message}
            </p>
          ) : null}
        </section>

        <section className="glass-panel rounded-[32px] border p-6 sm:p-8" style={{ borderColor: "var(--border)" }}>
          <p className="text-xs font-semibold uppercase tracking-[0.28em]" style={{ color: "var(--muted-text)" }}>
            New Client
          </p>
          <h2 className="font-display mt-3 text-4xl">Connection details</h2>
          <p className="mt-3 text-sm leading-7" style={{ color: "var(--muted-text)" }}>
            Roomy checks the connection before saving the client. Account ID is optional.
          </p>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <label className="block text-sm font-medium sm:col-span-2">
              <span style={{ color: "var(--muted-text)" }}>Client name</span>
              <input
                className="mt-2 w-full rounded-[20px] border bg-white px-4 py-3 outline-none"
                style={{ borderColor: "var(--border)" }}
                type="text"
                value={clientName}
                onChange={(event) => setClientName(event.target.value)}
              />
            </label>
            <label className="block text-sm font-medium">
              <span style={{ color: "var(--muted-text)" }}>Client ID</span>
              <input
                className="mt-2 w-full rounded-[20px] border bg-white px-4 py-3 outline-none"
                style={{ borderColor: "var(--border)" }}
                type="text"
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
                placeholder="Hostaway Client ID"
              />
            </label>
            <label className="block text-sm font-medium">
              <span style={{ color: "var(--muted-text)" }}>Account ID</span>
              <input
                className="mt-2 w-full rounded-[20px] border bg-white px-4 py-3 outline-none"
                style={{ borderColor: "var(--border)" }}
                type="text"
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
                placeholder="Optional Hostaway account ID"
              />
            </label>
            <label className="block text-sm font-medium sm:col-span-2">
              <span style={{ color: "var(--muted-text)" }}>Client Secret</span>
              <input
                className="mt-2 w-full rounded-[20px] border bg-white px-4 py-3 outline-none"
                style={{ borderColor: "var(--border)" }}
                type="password"
                value={clientSecret}
                onChange={(event) => setClientSecret(event.target.value)}
                placeholder="Hostaway Client Secret"
              />
            </label>
          </div>

          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
            <button
              type="button"
              onClick={() => void handleCreateClient()}
              className="rounded-full px-4 py-3 text-sm font-semibold text-white"
              style={{ background: "var(--green-dark)" }}
              disabled={creating}
            >
              {creating ? "Creating..." : "Create client"}
            </button>
            <Link
              href="/dashboard/select-client"
              className="rounded-full border px-4 py-3 text-sm font-semibold"
              style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
            >
              Cancel
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
