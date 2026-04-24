"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { buildDashboardViewHref, withBasePath } from "@/lib/base-path";

import WorkspaceLoadingScreen from "./workspace-loading-screen";

type SyncStatusResponse = {
  connection: {
    status: string;
    lastSyncAt: string | null;
  } | null;
  recentRuns?: Array<{
    id: string;
    jobType: string;
    status: string;
    createdAt: string;
    finishedAt: string | null;
    errorMessage: string | null;
  }>;
};

const CONTINUE_BUTTON_DELAY_MS = 12000;
const POLL_INTERVAL_MS = 2000;

function buildOverviewHref(): string {
  return buildDashboardViewHref("overview");
}

function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  return fetch(withBasePath(url), init).then(async (response) => {
    const body = (await response.json().catch(() => ({}))) as { error?: string } & T;
    if (!response.ok) {
      throw new Error(body.error ?? "Request failed");
    }
    return body;
  });
}

function storageKey(tenantId: string): string {
  return `roomy-new-client-provisioning:${tenantId}`;
}

export default function ClientProvisioningScreen({
  tenantId,
  clientName
}: {
  tenantId: string;
  clientName: string;
}) {
  const [description, setDescription] = useState("Queueing the first sync for this client.");
  const [error, setError] = useState<string | null>(null);
  const [allowContinue, setAllowContinue] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const [syncStage, setSyncStage] = useState<"queueing" | "waiting" | "running" | "slow">("queueing");
  const safeClientName = useMemo(() => clientName.trim() || "your client", [clientName]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    let cancelled = false;
    let pollTimer: number | null = null;
    const allowContinueTimer = window.setTimeout(() => {
      if (!cancelled) {
        setAllowContinue(true);
        setSyncStage((current) => (current === "running" ? "slow" : current));
      }
    }, CONTINUE_BUTTON_DELAY_MS);

    const rawQueuedAt = window.sessionStorage.getItem(storageKey(tenantId));
    const queuedAt = Number(rawQueuedAt);
    const syncQueuedAt = Number.isFinite(queuedAt) && queuedAt > 0 ? queuedAt : Date.now();

    async function pollStatus() {
      try {
        const status = await fetchJson<SyncStatusResponse>("/api/sync/status");
        if (cancelled) return;

        const matchingRun = (status.recentRuns ?? []).find((run) => {
          const createdAt = Date.parse(run.createdAt);
          return Number.isFinite(createdAt) && createdAt >= syncQueuedAt - 15000;
        });

        if (matchingRun?.status === "failed") {
          if (pollTimer !== null) window.clearTimeout(pollTimer);
          setError(matchingRun.errorMessage ?? "The first sync failed. You can open the dashboard or head back to the selector.");
          setAllowContinue(true);
          setSyncStage("slow");
          return;
        }

        const lastSyncAt = Date.parse(status.connection?.lastSyncAt ?? "");
        if (
          matchingRun?.status === "success" ||
          (Number.isFinite(lastSyncAt) && lastSyncAt >= syncQueuedAt - 15000)
        ) {
          window.sessionStorage.removeItem(storageKey(tenantId));
          window.location.replace(buildOverviewHref());
          return;
        }

        if (matchingRun?.status === "running") {
          setSyncStage(allowContinue ? "slow" : "running");
          setDescription("Pulling reservations, rates, and pricing context into the workspace.");
        } else {
          setSyncStage("waiting");
          setDescription("Waiting for the first sync job to start.");
        }
      } catch (statusError) {
        if (cancelled) return;
        setSyncStage(allowContinue ? "slow" : "waiting");
        setDescription(
          statusError instanceof Error
            ? "Still preparing the workspace."
            : "Still preparing the workspace."
        );
      }

      pollTimer = window.setTimeout(() => {
        void pollStatus();
      }, POLL_INTERVAL_MS);
    }

    async function beginProvisioning() {
      try {
        setSyncStage("queueing");
        if (!rawQueuedAt) {
          window.sessionStorage.setItem(storageKey(tenantId), String(syncQueuedAt));
          await fetchJson("/api/sync/run", { method: "POST" });
        }

        if (cancelled) return;
        setSyncStage("running");
        setDescription("Pulling reservations, rates, and building the workspace.");
        await pollStatus();
      } catch (provisioningError) {
        if (cancelled) return;
        setError(provisioningError instanceof Error ? provisioningError.message : "Failed to start the first sync");
        setAllowContinue(true);
        setSyncStage("slow");
      }
    }

    void beginProvisioning();

    return () => {
      cancelled = true;
      window.clearTimeout(allowContinueTimer);
      if (pollTimer !== null) window.clearTimeout(pollTimer);
    };
  }, [allowContinue, retryNonce, tenantId]);

  return (
    <WorkspaceLoadingScreen
      title={`Opening ${safeClientName}`}
      description={error ?? description}
    >
      <p className="text-sm" style={{ color: "var(--muted-text)" }}>
        {syncStage === "queueing"
          ? "Queueing the first workspace sync."
          : syncStage === "waiting"
            ? "Waiting for the sync worker to pick this job up."
            : syncStage === "running"
              ? "Sync is running now."
              : "This is slower than usual, but you stay in control of when to continue."}
      </p>
      {allowContinue ? (
        <div className="space-y-3">
          <p className="text-sm" style={{ color: "var(--muted-text)" }}>
            {error
              ? "You can retry from Client Selector or open the dashboard while the sync catches up."
              : "This is taking a little longer than usual. You can keep waiting or open Overview now."}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              className="rounded-full border px-4 py-3 text-sm font-semibold"
              style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
              onClick={() => {
                if (typeof window === "undefined") return;
                window.sessionStorage.removeItem(storageKey(tenantId));
                setError(null);
                setAllowContinue(false);
                setDescription("Queueing the first sync for this client.");
                setRetryNonce((current) => current + 1);
              }}
            >
              Retry sync
            </button>
            <button
              type="button"
              className="rounded-full px-4 py-3 text-sm font-semibold text-white"
              style={{ background: "var(--green-dark)" }}
              onClick={() => {
                if (typeof window !== "undefined") {
                  window.location.replace(buildOverviewHref());
                }
              }}
            >
              Open Overview
            </button>
            <Link
              href="/dashboard/select-client"
              className="rounded-full border px-4 py-3 text-sm font-semibold"
              style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
            >
              Back to selector
            </Link>
          </div>
        </div>
      ) : null}
    </WorkspaceLoadingScreen>
  );
}
