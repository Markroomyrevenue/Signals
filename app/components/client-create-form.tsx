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

type PmsChoice = "hostaway" | "guesty" | "avantio";

const PMS_OPTIONS: Array<{ value: PmsChoice; label: string }> = [
  { value: "hostaway", label: "Hostaway" },
  { value: "guesty", label: "Guesty" },
  { value: "avantio", label: "Avantio" }
];

export default function ClientCreateForm() {
  const [pms, setPms] = useState<PmsChoice>("hostaway");
  const [clientName, setClientName] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [accountId, setAccountId] = useState("");
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageTone, setMessageTone] = useState<MessageTone>("success");

  function selectPms(next: PmsChoice) {
    setPms(next);
    // Credentials are PMS-specific; don't carry one PMS's secrets into
    // another's request body.
    setClientId("");
    setClientSecret("");
    setAccountId("");
    setMessage(null);
  }

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

    if (pms === "avantio") {
      if (!trimmedClientId) {
        setMessage("Avantio API key is required.");
        setMessageTone("error");
        return;
      }
    } else if (!trimmedClientId || !trimmedClientSecret) {
      setMessage("Client ID and Client Secret are required.");
      setMessageTone("error");
      return;
    }

    setCreating(true);
    setMessage(null);

    const requestBody =
      pms === "guesty"
        ? {
            pms,
            clientName: trimmedClientName,
            guestyClientId: trimmedClientId,
            guestyClientSecret: trimmedClientSecret
          }
        : pms === "avantio"
          ? {
              pms,
              clientName: trimmedClientName,
              avantioApiKey: trimmedClientId
            }
          : {
              clientName: trimmedClientName,
              apiKey: trimmedClientId,
              apiPin: trimmedClientSecret,
              accountPin: trimmedAccountId
            };

    try {
      const created = await fetchJson<CreateClientResponse>("/api/tenants/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody)
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
      setMessage(error instanceof Error ? error.message : "Failed to create portfolio");
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
          title="Creating portfolio"
          description="Verifying credentials."
        />
      ) : null}

      <div className="mx-auto max-w-md space-y-5">
        <header className="flex items-baseline justify-between gap-3">
          <h1 className="font-display text-3xl sm:text-4xl">Add portfolio</h1>
          <Link
            href="/dashboard/select-client"
            className="text-sm font-semibold"
            style={{ color: "var(--green-dark)" }}
          >
            ← Portfolios
          </Link>
        </header>

        {message ? (
          <p
            className="rounded-2xl border px-4 py-3 text-sm"
            style={
              messageTone === "error"
                ? { borderColor: "rgba(187,75,82,0.2)", background: "rgba(187,75,82,0.08)", color: "var(--delta-negative)" }
                : { borderColor: "rgba(22,71,51,0.16)", background: "rgba(31,122,77,0.08)" }
            }
          >
            {message}
          </p>
        ) : null}

        <section className="glass-panel space-y-4 rounded-[24px] border p-5 sm:p-6" style={{ borderColor: "var(--border)" }}>
          <div className="block text-sm font-medium">
            <span style={{ color: "var(--muted-text)" }}>Property management system</span>
            <div className="mt-2 flex gap-2">
              {PMS_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => selectPms(option.value)}
                  className="flex-1 rounded-[20px] border px-3 py-3 text-sm font-semibold"
                  style={
                    pms === option.value
                      ? { background: "var(--green-dark)", borderColor: "var(--green-dark)", color: "#fff" }
                      : { borderColor: "var(--border)", color: "var(--muted-text)", background: "#fff" }
                  }
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <label className="block text-sm font-medium">
            <span style={{ color: "var(--muted-text)" }}>Portfolio name</span>
            <input
              className="mt-2 w-full rounded-[20px] border bg-white px-4 py-3 outline-none"
              style={{ borderColor: "var(--border)" }}
              type="text"
              value={clientName}
              onChange={(event) => setClientName(event.target.value)}
            />
          </label>
          {pms === "avantio" ? (
            <label className="block text-sm font-medium">
              <span style={{ color: "var(--muted-text)" }}>Avantio API Key</span>
              <input
                className="mt-2 w-full rounded-[20px] border bg-white px-4 py-3 outline-none"
                style={{ borderColor: "var(--border)" }}
                type="password"
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
              />
            </label>
          ) : (
            <>
              <label className="block text-sm font-medium">
                <span style={{ color: "var(--muted-text)" }}>
                  {pms === "guesty" ? "Guesty Client ID" : "Hostaway Client ID"}
                </span>
                <input
                  className="mt-2 w-full rounded-[20px] border bg-white px-4 py-3 outline-none"
                  style={{ borderColor: "var(--border)" }}
                  type="text"
                  value={clientId}
                  onChange={(event) => setClientId(event.target.value)}
                />
              </label>
              <label className="block text-sm font-medium">
                <span style={{ color: "var(--muted-text)" }}>
                  {pms === "guesty" ? "Guesty Client Secret" : "Hostaway Client Secret"}
                </span>
                <input
                  className="mt-2 w-full rounded-[20px] border bg-white px-4 py-3 outline-none"
                  style={{ borderColor: "var(--border)" }}
                  type="password"
                  value={clientSecret}
                  onChange={(event) => setClientSecret(event.target.value)}
                />
              </label>
            </>
          )}
          {pms === "hostaway" ? (
            <label className="block text-sm font-medium">
              <span style={{ color: "var(--muted-text)" }}>Account ID (optional)</span>
              <input
                className="mt-2 w-full rounded-[20px] border bg-white px-4 py-3 outline-none"
                style={{ borderColor: "var(--border)" }}
                type="text"
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
              />
            </label>
          ) : null}

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <button
              type="button"
              onClick={() => void handleCreateClient()}
              className="rounded-full px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
              style={{ background: "var(--green-dark)" }}
              disabled={creating}
            >
              {creating ? "Creating..." : "Add portfolio"}
            </button>
            <Link
              href="/dashboard/select-client"
              className="rounded-full border px-4 py-3 text-center text-sm font-semibold"
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
