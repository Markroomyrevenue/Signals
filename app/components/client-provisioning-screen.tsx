"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { buildDashboardViewHref, withBasePath } from "@/lib/base-path";

import WorkspaceLoadingScreen from "./workspace-loading-screen";

type SyncRunDetails = {
  stage?: string;
  syncScope?: "core" | "extended";
  listingsSynced?: number;
  reservationsProcessed?: number;
  reservationsSynced?: number;
  nightFactRowsUpserted?: number;
  calendarListingsSynced?: number;
  calendarTotal?: number;
};

type SyncRunSummary = {
  id: string;
  jobType: string;
  status: string;
  createdAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
  details?: SyncRunDetails | null;
};

type SyncStatusResponse = {
  connection: {
    status: string;
    lastSyncAt: string | null;
  } | null;
  recentRuns?: SyncRunSummary[];
};

const SLOW_NOTICE_DELAY_MS = 30000;
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

function describeStage(details: SyncRunDetails | null | undefined): { label: string; detail: string } {
  if (!details) {
    return {
      label: "Connecting to Hostaway",
      detail: "Negotiating credentials with Hostaway."
    };
  }

  const stage = details.stage;
  const listings = typeof details.listingsSynced === "number" ? details.listingsSynced : null;
  const reservationsSynced = typeof details.reservationsSynced === "number" ? details.reservationsSynced : null;
  const reservationsProcessed = typeof details.reservationsProcessed === "number" ? details.reservationsProcessed : null;
  const calendarSynced = typeof details.calendarListingsSynced === "number" ? details.calendarListingsSynced : null;
  const calendarTotal = typeof details.calendarTotal === "number" ? details.calendarTotal : null;

  if (stage === "connecting") {
    return {
      label: "Connecting to Hostaway",
      detail: "Verifying access tokens."
    };
  }

  if (stage === "listings") {
    return {
      label: "Loading properties",
      detail:
        listings !== null && listings > 0
          ? `Imported ${listings} ${listings === 1 ? "property" : "properties"} so far.`
          : "Pulling your property catalogue from Hostaway."
    };
  }

  if (stage === "reservations") {
    if (reservationsProcessed !== null && reservationsProcessed > 0) {
      const synced = reservationsSynced ?? 0;
      return {
        label: "Loading reservations",
        detail: `Reviewed ${reservationsProcessed.toLocaleString()} reservations · saved ${synced.toLocaleString()} updates.`
      };
    }
    return {
      label: "Loading reservations",
      detail: "Pulling reservations and channel data from Hostaway."
    };
  }

  if (stage === "night_facts") {
    return {
      label: "Computing nightly performance",
      detail:
        reservationsSynced !== null
          ? `Building night-level facts from ${reservationsSynced.toLocaleString()} reservations.`
          : "Building night-level facts."
    };
  }

  if (stage === "calendar") {
    if (calendarSynced !== null && calendarTotal !== null && calendarTotal > 0) {
      return {
        label: "Loading calendar & rates",
        detail: `Calendar synced for ${calendarSynced} of ${calendarTotal} ${calendarTotal === 1 ? "property" : "properties"}.`
      };
    }
    return {
      label: "Loading calendar & rates",
      detail: "Loading calendar availability and live rates."
    };
  }

  if (stage === "pace") {
    return {
      label: "Building pace snapshots",
      detail: "Calculating booking pace for trend reporting."
    };
  }

  if (stage === "complete") {
    return {
      label: "Wrapping up",
      detail: "Finalising the workspace."
    };
  }

  return {
    label: "Sync running",
    detail: "Working on the first sync."
  };
}

export default function ClientProvisioningScreen({
  tenantId,
  clientName
}: {
  tenantId: string;
  clientName: string;
}) {
  const [stageInfo, setStageInfo] = useState<{ label: string; detail: string }>(() =>
    describeStage(null)
  );
  const [error, setError] = useState<string | null>(null);
  const [allowContinue, setAllowContinue] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const [statusKind, setStatusKind] = useState<"queueing" | "waiting" | "running" | "slow">(
    "queueing"
  );
  const safeClientName = useMemo(() => clientName.trim() || "your client", [clientName]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    let cancelled = false;
    let pollTimer: number | null = null;
    const slowNoticeTimer = window.setTimeout(() => {
      if (!cancelled) {
        setAllowContinue(true);
        setStatusKind((current) => (current === "running" ? "slow" : current));
      }
    }, SLOW_NOTICE_DELAY_MS);

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
          setError(
            matchingRun.errorMessage ??
              "The first sync failed. You can open the dashboard or head back to the selector."
          );
          setAllowContinue(true);
          setStatusKind("slow");
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
          setStatusKind("running");
          setStageInfo(describeStage(matchingRun.details ?? null));
        } else {
          setStatusKind("waiting");
          setStageInfo({
            label: "Waiting in the queue",
            detail: "Waiting for the sync worker to pick this job up."
          });
        }
      } catch {
        if (cancelled) return;
        setStatusKind((current) => (current === "running" ? "slow" : "waiting"));
        setStageInfo((current) => current);
      }

      pollTimer = window.setTimeout(() => {
        void pollStatus();
      }, POLL_INTERVAL_MS);
    }

    async function beginProvisioning() {
      try {
        setStatusKind("queueing");
        setStageInfo({
          label: "Queueing the first sync",
          detail: "Sending this client to the sync worker."
        });
        if (!rawQueuedAt) {
          window.sessionStorage.setItem(storageKey(tenantId), String(syncQueuedAt));
          await fetchJson("/api/sync/run", { method: "POST" });
        }

        if (cancelled) return;
        setStatusKind("running");
        await pollStatus();
      } catch (provisioningError) {
        if (cancelled) return;
        setError(
          provisioningError instanceof Error
            ? provisioningError.message
            : "Failed to start the first sync"
        );
        setAllowContinue(true);
        setStatusKind("slow");
      }
    }

    void beginProvisioning();

    return () => {
      cancelled = true;
      window.clearTimeout(slowNoticeTimer);
      if (pollTimer !== null) window.clearTimeout(pollTimer);
    };
  }, [retryNonce, tenantId]);

  const description = error ?? stageInfo.detail;

  return (
    <WorkspaceLoadingScreen
      title={`Opening ${safeClientName}`}
      description={description}
    >
      <p className="text-sm font-semibold" style={{ color: "var(--green-dark)" }}>
        {error ? "First sync paused" : stageInfo.label}
      </p>
      <p className="mt-2 text-xs" style={{ color: "var(--muted-text)" }}>
        {statusKind === "queueing"
          ? "Queueing the first workspace sync."
          : statusKind === "waiting"
            ? "Waiting for the sync worker to pick this job up."
            : statusKind === "running"
              ? "Sync in progress. This page updates as data arrives."
              : "This is taking longer than usual — the sync is still running in the background."}
      </p>
      {allowContinue ? (
        <div className="mt-5 space-y-3">
          <p className="text-sm" style={{ color: "var(--muted-text)" }}>
            {error
              ? "You can retry from the Client Selector or open the dashboard while the sync catches up."
              : "Larger Hostaway accounts can take several minutes. You can keep waiting or open Overview now and come back."}
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
                setStageInfo({
                  label: "Queueing the first sync",
                  detail: "Sending this client to the sync worker."
                });
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
