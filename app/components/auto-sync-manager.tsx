"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { withBasePath } from "@/lib/base-path";
import { readLastAutoSyncQueuedAt, SYNC_STALE_INTERVAL_MS, writeLastAutoSyncQueuedAt } from "@/lib/sync/client-sync";

type SyncStatusResponse = {
  connection: {
    status: string;
    lastSyncAt: string | null;
  } | null;
  queueCounts: Record<string, number>;
};

const AUTO_SYNC_ROUTE_KEY = "roomy-dashboard-auto-sync-route-v1";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(withBasePath(url), init);
  if (!response.ok) {
    throw new Error(`Request failed for ${url}`);
  }
  return (await response.json()) as T;
}

export default function AutoSyncManager({
  tenantId,
  userRole
}: {
  tenantId: string;
  userRole?: "admin" | "viewer" | string | null;
}) {
  const pathname = usePathname();
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined" || !tenantId) return;
    if (!pathname) return;
    // Viewers don't have permission to enqueue syncs server-side (POST
    // /api/sync/run requires admin). Without this gate every page
    // navigation by a viewer fired a 403 and surfaced as a vague
    // "forbidden on sync" error in the console / UI. Admin teammates
    // are responsible for syncs; viewers just read what's already there.
    if (userRole !== "admin") return;

    const previousPath = window.sessionStorage.getItem(AUTO_SYNC_ROUTE_KEY);
    window.sessionStorage.setItem(AUTO_SYNC_ROUTE_KEY, pathname);

    if (!previousPath || previousPath === pathname) return;
    if (document.visibilityState !== "visible") return;
    if (inFlightRef.current) return;

    let cancelled = false;
    inFlightRef.current = true;

    async function maybeQueueAutoSync() {
      try {
        const status = await fetchJson<SyncStatusResponse>("/api/sync/status");
        const queueActivity = (status.queueCounts.waiting ?? 0) + (status.queueCounts.active ?? 0);
        if (queueActivity > 0) return;

        const lastQueuedAt = readLastAutoSyncQueuedAt(tenantId);
        const lastSyncedAt = Date.parse(status.connection?.lastSyncAt ?? "");
        const freshestKnownSyncAt = Math.max(lastQueuedAt, Number.isFinite(lastSyncedAt) ? lastSyncedAt : 0);

        if (freshestKnownSyncAt > 0 && Date.now() - freshestKnownSyncAt < SYNC_STALE_INTERVAL_MS) {
          return;
        }

        const queuedAt = Date.now();
        await fetchJson("/api/sync/run", { method: "POST" });
        writeLastAutoSyncQueuedAt(tenantId, queuedAt);
      } catch (error) {
        console.error("Global auto sync queue failed", error);
      } finally {
        if (!cancelled) {
          inFlightRef.current = false;
        } else {
          inFlightRef.current = false;
        }
      }
    }

    void maybeQueueAutoSync();

    return () => {
      cancelled = true;
    };
  }, [pathname, tenantId, userRole]);

  return null;
}
