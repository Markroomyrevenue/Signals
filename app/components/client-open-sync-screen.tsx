"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { buildDashboardViewHref, withBasePath } from "@/lib/base-path";
import {
  clearClientOpenSyncQueuedAt,
  parseTimestamp,
  readClientOpenSyncQueuedAt,
  SYNC_STALE_INTERVAL_MS,
  writeClientOpenSyncQueuedAt,
  writeLastAutoSyncQueuedAt
} from "@/lib/sync/client-sync";
import { isJobTypeForScope, isSyncScopeFresh, SyncScope, SYNC_SCOPE_MATCH_TOLERANCE_MS } from "@/lib/sync/stages";

import WorkspaceLoadingScreen from "./workspace-loading-screen";

type SyncStatusResponse = {
  connection: {
    status: string;
    lastSyncAt: string | null;
  } | null;
  queueCounts: Record<string, number>;
  freshness?: {
    coreLastSyncAt: string | null;
    extendedLastSyncAt: string | null;
    activeScopes?: SyncScope[];
  };
  recentRuns?: Array<{
    id: string;
    jobType: string;
    status: string;
    createdAt: string;
    finishedAt: string | null;
    errorMessage: string | null;
    details?: {
      queueExtendedAfter?: boolean;
    } | null;
  }>;
};

type SyncRunSummary = NonNullable<SyncStatusResponse["recentRuns"]>[number];

const DEFAULT_SYNC_DURATION_MS: Record<SyncScope, number> = {
  core: 75 * 1000,
  extended: 3 * 60 * 1000
};
const POLL_INTERVAL_MS = 2000;
const PROGRESS_TICK_INTERVAL_MS = 1000;
const STALE_QUEUE_RETRY_MS = 5 * 60 * 1000;

function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  return fetch(withBasePath(url), init).then(async (response) => {
    const body = (await response.json().catch(() => ({}))) as { error?: string } & T;
    if (!response.ok) {
      throw new Error(body.error ?? "Request failed");
    }
    return body;
  });
}

function tabLabel(targetTab: string): string {
  switch (targetTab) {
    case "overview":
      return "Overview";
    case "reservations":
      return "Reservations";
    case "property_groups":
      return "Property Groups";
    case "pace":
      return "Pace";
    case "sales":
      return "Sales";
    case "booked":
      return "Booked";
    case "booking_behaviour":
      return "Booking Windows";
    case "property_drilldown":
      return "Property Drilldown";
    case "signal_lab":
      return "Signal Lab";
    default:
      return "Dashboard";
  }
}

function buildTargetHref(targetTab: string, targetView?: string | null): string {
  return buildDashboardViewHref(targetTab, targetView);
}

function buildTitle(clientName: string, targetTab: string): string {
  const safeClientName = clientName.trim() || "your client";
  return targetTab === "overview"
    ? `Opening ${safeClientName}`
    : `Loading ${tabLabel(targetTab)} for ${safeClientName}`;
}

function syncTimestampForScope(status: SyncStatusResponse, requiredScope: SyncScope): string | null {
  if (requiredScope === "core") {
    return status.freshness?.coreLastSyncAt ?? status.connection?.lastSyncAt ?? null;
  }

  return status.freshness?.extendedLastSyncAt ?? null;
}

function formatElapsedClock(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

type SyncProgressStep = {
  id: string;
  label: string;
  status: "pending" | "active" | "complete";
  weight: number;
};

function progressPercentFromSteps(steps: SyncProgressStep[]): number {
  const totalWeight = steps.reduce((sum, step) => sum + step.weight, 0);
  if (totalWeight <= 0) return 0;

  const completedWeight = steps.reduce((sum, step) => {
    if (step.status === "complete") return sum + step.weight;
    if (step.status === "active") return sum + step.weight * 0.55;
    return sum;
  }, 0);

  return Math.round((completedWeight / totalWeight) * 100);
}

function buildSyncProgressSteps(params: {
  status: SyncStatusResponse | null;
  requiredScope: SyncScope;
  queuedAt: number | null;
}): SyncProgressStep[] {
  const queueActive = (params.status?.queueCounts.waiting ?? 0) + (params.status?.queueCounts.active ?? 0) > 0;
  const activeScopes = params.status?.freshness?.activeScopes ?? [];
  const coreFresh =
    params.status !== null &&
    isSyncScopeFresh({
      scope: "core",
      coreLastSyncAt: params.status.freshness?.coreLastSyncAt ?? params.status.connection?.lastSyncAt ?? null,
      extendedLastSyncAt: params.status.freshness?.extendedLastSyncAt ?? null
    });
  const extendedFresh =
    params.status !== null &&
    isSyncScopeFresh({
      scope: "extended",
      coreLastSyncAt: params.status.freshness?.coreLastSyncAt ?? params.status.connection?.lastSyncAt ?? null,
      extendedLastSyncAt: params.status.freshness?.extendedLastSyncAt ?? null
    });

  const steps: SyncProgressStep[] = [
    {
      id: "queued",
      label: "Queued",
      status: params.queuedAt !== null ? (queueActive || activeScopes.length > 0 || coreFresh || extendedFresh ? "complete" : "active") : "pending",
      weight: 15
    },
    {
      id: "core",
      label: "Core sync",
      status: coreFresh ? "complete" : activeScopes.includes("core") ? "active" : "pending",
      weight: params.requiredScope === "core" ? 55 : 35
    }
  ];

  if (params.requiredScope === "extended") {
    steps.push({
      id: "extended",
      label: "Extended sync",
      status: extendedFresh ? "complete" : activeScopes.includes("extended") ? "active" : coreFresh ? "active" : "pending",
      weight: 35
    });
  }

  steps.push({
    id: "open",
    label: "Open report",
    status: params.requiredScope === "core" ? (coreFresh ? "complete" : "pending") : extendedFresh ? "complete" : "pending",
    weight: 10
  });

  return steps;
}

function buildInitialDescription(params: {
  requiredScope: SyncScope;
  targetTab: string;
  coreLastSyncAt: string | null;
}): string {
  if (params.requiredScope === "core") {
    if (!params.coreLastSyncAt) {
      return "No completed sync yet. Running a fresh sync before opening Overview.";
    }

    const minutes = Math.round(SYNC_STALE_INTERVAL_MS / 60000);
    return `Latest sync is older than ${minutes} minutes. Refreshing Overview, Reservations, Pace, and Sales before opening.`;
  }

  if (!params.coreLastSyncAt) {
    return `Running a full client sync before opening ${tabLabel(params.targetTab)}.`;
  }

  return `Overview, Reservations, Pace, and Sales open first. Finishing the deeper sync before opening ${tabLabel(params.targetTab)}.`;
}

function buildActiveDescription(params: {
  requiredScope: SyncScope;
  targetTab: string;
  activeScopes: SyncScope[];
}): string {
  if (params.requiredScope === "core") {
    return "Refreshing reservations and rebuilding the ready tabs.";
  }

  if (params.activeScopes.includes("core")) {
    return `Refreshing core data first, then finishing the deeper sync for ${tabLabel(params.targetTab)}.`;
  }

  return `Finishing calendars and deeper reporting data before opening ${tabLabel(params.targetTab)}.`;
}

function buildWaitingDescription(requiredScope: SyncScope, targetTab: string): string {
  if (requiredScope === "core") {
    return "Waiting for the fresh client sync to start.";
  }

  return `Waiting for the deeper sync to start before opening ${tabLabel(targetTab)}.`;
}

function currentChainCreatedAt(
  status: SyncStatusResponse,
  requiredScope: SyncScope,
  maxReusableAgeMs: number
): number {
  const runs = status.recentRuns ?? [];
  const reuseCutoff = Date.now() - Math.max(STALE_QUEUE_RETRY_MS, maxReusableAgeMs);
  const scopeRun = runs.find((run) => {
    if (run.status !== "running") return false;
    if (!isJobTypeForScope(run.jobType, requiredScope)) return false;
    return parseTimestamp(run.createdAt) >= reuseCutoff;
  });
  if (scopeRun) {
    return parseTimestamp(scopeRun.createdAt);
  }

  if (requiredScope === "extended") {
    const coreRun = runs.find(
      (run) =>
        run.status === "running" &&
        isJobTypeForScope(run.jobType, "core") &&
        run.details?.queueExtendedAfter === true &&
        parseTimestamp(run.createdAt) >= reuseCutoff
    );
    return parseTimestamp(coreRun?.createdAt);
  }

  return 0;
}

function failedRunForScope(
  status: SyncStatusResponse,
  requiredScope: SyncScope,
  queuedAt: number
): SyncRunSummary | undefined {
  const acceptedScopes = requiredScope === "extended" ? new Set<SyncScope>(["core", "extended"]) : new Set<SyncScope>(["core"]);

  return (status.recentRuns ?? []).find((run) => {
    const createdAt = parseTimestamp(run.createdAt);
    if (createdAt < queuedAt - SYNC_SCOPE_MATCH_TOLERANCE_MS) return false;
    if (!acceptedScopes.has(isJobTypeForScope(run.jobType, "extended") ? "extended" : "core")) return false;
    return run.status === "failed";
  });
}

export default function ClientOpenSyncScreen({
  tenantId,
  clientName,
  targetTab,
  requiredScope,
  targetView
}: {
  tenantId: string;
  clientName: string;
  targetTab: string;
  requiredScope: SyncScope;
  targetView?: string | null;
}) {
  const [description, setDescription] = useState("Checking whether this client needs a fresh sync.");
  const [error, setError] = useState<string | null>(null);
  const [statusSnapshot, setStatusSnapshot] = useState<SyncStatusResponse | null>(null);
  const [syncQueuedAt, setSyncQueuedAt] = useState<number | null>(null);
  const [progressNow, setProgressNow] = useState(() => Date.now());

  const title = useMemo(() => buildTitle(clientName, targetTab), [clientName, targetTab]);
  const elapsedMs = syncQueuedAt === null ? 0 : Math.max(0, progressNow - syncQueuedAt);
  const progressSteps = useMemo(
    () => buildSyncProgressSteps({ status: statusSnapshot, requiredScope, queuedAt: syncQueuedAt }),
    [requiredScope, statusSnapshot, syncQueuedAt]
  );
  const progressPercent = syncQueuedAt === null ? 0 : progressPercentFromSteps(progressSteps);

  useEffect(() => {
    if (typeof window === "undefined" || syncQueuedAt === null || error) return;

    setProgressNow(Date.now());
    const timer = window.setInterval(() => {
      setProgressNow(Date.now());
    }, PROGRESS_TICK_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [error, syncQueuedAt]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    let cancelled = false;
    let pollTimer: number | null = null;

    function finishAndOpenTarget(status: SyncStatusResponse, fallbackTimestamp: number) {
      clearClientOpenSyncQueuedAt(tenantId, requiredScope);
      const coreSyncAt = parseTimestamp(status.freshness?.coreLastSyncAt ?? status.connection?.lastSyncAt);
      writeLastAutoSyncQueuedAt(
        tenantId,
        requiredScope === "core" ? Math.max(coreSyncAt, fallbackTimestamp) : coreSyncAt
      );
      window.location.replace(buildTargetHref(targetTab, targetView));
    }

    async function pollStatus(scopeQueuedAt: number) {
      try {
        const status = await fetchJson<SyncStatusResponse>("/api/sync/status");
        if (cancelled) return;
        setStatusSnapshot(status);

        const failedRun = failedRunForScope(status, requiredScope, scopeQueuedAt);
        if (failedRun) {
          clearClientOpenSyncQueuedAt(tenantId, requiredScope);
          if (pollTimer !== null) window.clearTimeout(pollTimer);
          setError(failedRun.errorMessage ?? "The client refresh failed. Please retry the sync.");
          return;
        }

        const requiredSyncTimestamp = parseTimestamp(syncTimestampForScope(status, requiredScope));
        if (
          isSyncScopeFresh({
            scope: requiredScope,
            coreLastSyncAt: status.freshness?.coreLastSyncAt ?? status.connection?.lastSyncAt ?? null,
            extendedLastSyncAt: status.freshness?.extendedLastSyncAt ?? null
          }) &&
          requiredSyncTimestamp >= scopeQueuedAt - SYNC_SCOPE_MATCH_TOLERANCE_MS
        ) {
          finishAndOpenTarget(status, scopeQueuedAt);
          return;
        }

        const activeScopes = status.freshness?.activeScopes ?? [];
        setDescription(
          activeScopes.length > 0
            ? buildActiveDescription({ requiredScope, targetTab, activeScopes })
            : buildWaitingDescription(requiredScope, targetTab)
        );
      } catch {
        if (cancelled) return;
        setDescription(
          requiredScope === "core"
            ? "Still preparing a fresh sync for this client."
            : `Still finishing the deeper sync for ${tabLabel(targetTab)}.`
        );
      }

      pollTimer = window.setTimeout(() => {
        void pollStatus(scopeQueuedAt);
      }, POLL_INTERVAL_MS);
    }

    async function beginOpenFlow() {
      try {
        const initialStatus = await fetchJson<SyncStatusResponse>("/api/sync/status");
        if (cancelled) return;
        setStatusSnapshot(initialStatus);

        const requiredSyncAt = syncTimestampForScope(initialStatus, requiredScope);
        const coreLastSyncAt = initialStatus.freshness?.coreLastSyncAt ?? initialStatus.connection?.lastSyncAt ?? null;
        if (
          isSyncScopeFresh({
            scope: requiredScope,
            coreLastSyncAt,
            extendedLastSyncAt: initialStatus.freshness?.extendedLastSyncAt ?? null
          })
        ) {
          if (
            requiredScope === "core" &&
            !isSyncScopeFresh({
              scope: "extended",
              coreLastSyncAt,
              extendedLastSyncAt: initialStatus.freshness?.extendedLastSyncAt ?? null
            }) &&
            !(initialStatus.freshness?.activeScopes ?? []).includes("extended")
          ) {
            void fetchJson("/api/sync/run", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ scope: "extended" })
            }).catch(() => undefined);
          }
          finishAndOpenTarget(initialStatus, parseTimestamp(requiredSyncAt));
          return;
        }

        let queuedAt = readClientOpenSyncQueuedAt(tenantId, requiredScope);
        if (queuedAt > 0 && Date.now() - queuedAt > STALE_QUEUE_RETRY_MS) {
          clearClientOpenSyncQueuedAt(tenantId, requiredScope);
          queuedAt = 0;
        }

        if (queuedAt === 0) {
          const runningChainCreatedAt = currentChainCreatedAt(
            initialStatus,
            requiredScope,
            DEFAULT_SYNC_DURATION_MS[requiredScope] * 2
          );
          if (runningChainCreatedAt > 0) {
            queuedAt = runningChainCreatedAt;
            writeClientOpenSyncQueuedAt(tenantId, queuedAt, requiredScope);
          }
        }

        setDescription(
          buildInitialDescription({
            requiredScope,
            targetTab,
            coreLastSyncAt
          })
        );

        if (queuedAt === 0) {
          const requestScope =
            requiredScope === "extended" &&
            isSyncScopeFresh({
              scope: "core",
              coreLastSyncAt,
              extendedLastSyncAt: initialStatus.freshness?.extendedLastSyncAt ?? null
            })
              ? "extended"
              : "full";
          const shouldForceFull = requestScope === "full" && !coreLastSyncAt;

          queuedAt = Date.now();
          writeClientOpenSyncQueuedAt(tenantId, queuedAt, requiredScope);
          if (requestScope === "full") {
            writeLastAutoSyncQueuedAt(tenantId, queuedAt);
          }
          setSyncQueuedAt(queuedAt);
          setProgressNow(Date.now());

          await fetchJson("/api/sync/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              forceFull: shouldForceFull,
              scope: requestScope
            })
          });
        } else {
          setSyncQueuedAt(queuedAt);
          setProgressNow(Date.now());
        }

        if (cancelled) return;
        await pollStatus(queuedAt);
      } catch (openError) {
        if (cancelled) return;
        clearClientOpenSyncQueuedAt(tenantId, requiredScope);
        setError(openError instanceof Error ? openError.message : "Failed to start the client refresh");
      }
    }

    void beginOpenFlow();

    return () => {
      cancelled = true;
      if (pollTimer !== null) window.clearTimeout(pollTimer);
    };
  }, [requiredScope, targetTab, targetView, tenantId]);

  return (
    <WorkspaceLoadingScreen title={title} description={error ?? description}>
      {error ? (
        <div className="space-y-3">
          <p className="text-sm" style={{ color: "var(--muted-text)" }}>
            This client will stay on the loading screen until the sync is ready.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              className="rounded-full px-4 py-3 text-sm font-semibold text-white"
              style={{ background: "var(--green-dark)" }}
              onClick={() => {
                if (typeof window !== "undefined") {
                  clearClientOpenSyncQueuedAt(tenantId, requiredScope);
                  window.location.reload();
                }
              }}
            >
              Retry sync
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
      ) : syncQueuedAt !== null ? (
        <div className="space-y-4">
          <div className="overflow-hidden rounded-full border bg-white/76 p-1" style={{ borderColor: "var(--border)" }}>
            <div
              className="h-3 rounded-full transition-[width] duration-700 ease-out"
              style={{
                width: `${progressPercent}%`,
                background: "linear-gradient(90deg, #1f7a4d 0%, #b07a19 100%)"
              }}
            />
          </div>
          <div
            className="flex items-center justify-between gap-3 text-xs font-semibold uppercase tracking-[0.16em]"
            style={{ color: "var(--muted-text)" }}
          >
            <span>{Math.max(0, Math.round(progressPercent))}% complete</span>
            <span>{formatElapsedClock(elapsedMs)} elapsed</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {progressSteps.map((step) => (
              <div
                key={step.id}
                className="rounded-2xl border px-3 py-3 text-sm"
                style={{
                  borderColor:
                    step.status === "complete"
                      ? "rgba(31,122,77,0.22)"
                      : step.status === "active"
                        ? "rgba(176,122,25,0.24)"
                        : "var(--border)",
                  background:
                    step.status === "complete"
                      ? "rgba(31,122,77,0.06)"
                      : step.status === "active"
                        ? "rgba(176,122,25,0.07)"
                        : "rgba(255,255,255,0.72)"
                }}
              >
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--muted-text)" }}>
                  {step.status === "complete" ? "Done" : step.status === "active" ? "In progress" : "Pending"}
                </p>
                <p className="mt-1 font-semibold" style={{ color: "var(--text)" }}>
                  {step.label}
                </p>
              </div>
            ))}
          </div>
          <div className="space-y-1 text-sm" style={{ color: "var(--muted-text)" }}>
            <p>The loader now tracks real sync stages rather than a time estimate.</p>
            <p>{requiredScope === "core" ? "Overview data opens as soon as the core sync completes." : "This report opens once the core and extended sync stages are both complete."}</p>
          </div>
        </div>
      ) : null}
    </WorkspaceLoadingScreen>
  );
}
