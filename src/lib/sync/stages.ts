import { SYNC_STALE_INTERVAL_MS } from "@/lib/sync/client-sync";

export type SyncScope = "core" | "extended";

export const EXTENDED_SYNC_REASON_SUFFIX = "__extended";
export const SYNC_SCOPE_MATCH_TOLERANCE_MS = 15000;

const CORE_TAB_SET = new Set(["overview", "reservations", "property_groups", "pace", "sales"]);

export function buildExtendedSyncReason(reason?: string): string {
  const normalized = (reason ?? "manual_trigger").trim() || "manual_trigger";
  return normalized.endsWith(EXTENDED_SYNC_REASON_SUFFIX)
    ? normalized
    : `${normalized}${EXTENDED_SYNC_REASON_SUFFIX}`;
}

export function syncScopeFromJobType(jobType?: string | null): SyncScope {
  return jobType?.endsWith(EXTENDED_SYNC_REASON_SUFFIX) ? "extended" : "core";
}

export function isJobTypeForScope(jobType: string | null | undefined, scope: SyncScope): boolean {
  return syncScopeFromJobType(jobType) === scope;
}

export function syncScopeForDashboardTab(tab: string): SyncScope {
  return CORE_TAB_SET.has(tab) ? "core" : "extended";
}

function parseTimestamp(value: string | null | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isSyncScopeFresh(params: {
  scope: SyncScope;
  coreLastSyncAt: string | null | undefined;
  extendedLastSyncAt: string | null | undefined;
  now?: number;
}): boolean {
  const now = params.now ?? Date.now();
  const coreTimestamp = parseTimestamp(params.coreLastSyncAt);
  if (params.scope === "core") {
    return coreTimestamp > 0 && now - coreTimestamp < SYNC_STALE_INTERVAL_MS;
  }

  const extendedTimestamp = parseTimestamp(params.extendedLastSyncAt);
  return (
    extendedTimestamp > 0 &&
    now - extendedTimestamp < SYNC_STALE_INTERVAL_MS &&
    extendedTimestamp >= coreTimestamp - SYNC_SCOPE_MATCH_TOLERANCE_MS
  );
}
