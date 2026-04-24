export const SYNC_STALE_INTERVAL_MS = 20 * 60 * 1000;

const AUTO_SYNC_QUEUE_KEY_PREFIX = "roomy-dashboard-auto-sync-v1";
const CLIENT_OPEN_SYNC_KEY_PREFIX = "roomy-client-open-sync-v1";
type ClientOpenSyncScope = "core" | "extended";

function storageValueToTimestamp(value: string | null): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function autoSyncStorageKey(tenantId: string): string {
  return `${AUTO_SYNC_QUEUE_KEY_PREFIX}:${tenantId}`;
}

export function readLastAutoSyncQueuedAt(tenantId: string): number {
  if (typeof window === "undefined" || !tenantId) return 0;
  return storageValueToTimestamp(window.localStorage.getItem(autoSyncStorageKey(tenantId)));
}

export function writeLastAutoSyncQueuedAt(tenantId: string, timestamp: number) {
  if (typeof window === "undefined" || !tenantId) return;
  window.localStorage.setItem(autoSyncStorageKey(tenantId), String(timestamp));
}

export function clientOpenSyncStorageKey(tenantId: string, scope: ClientOpenSyncScope = "core"): string {
  return `${CLIENT_OPEN_SYNC_KEY_PREFIX}:${tenantId}:${scope}`;
}

export function readClientOpenSyncQueuedAt(tenantId: string, scope: ClientOpenSyncScope = "core"): number {
  if (typeof window === "undefined" || !tenantId) return 0;
  return storageValueToTimestamp(window.sessionStorage.getItem(clientOpenSyncStorageKey(tenantId, scope)));
}

export function writeClientOpenSyncQueuedAt(
  tenantId: string,
  timestamp: number,
  scope: ClientOpenSyncScope = "core"
) {
  if (typeof window === "undefined" || !tenantId) return;
  window.sessionStorage.setItem(clientOpenSyncStorageKey(tenantId, scope), String(timestamp));
}

export function clearClientOpenSyncQueuedAt(tenantId: string, scope: ClientOpenSyncScope = "core") {
  if (typeof window === "undefined" || !tenantId) return;
  window.sessionStorage.removeItem(clientOpenSyncStorageKey(tenantId, scope));
}

export function parseTimestamp(value: string | null | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isSyncFresh(lastSyncAt: string | null | undefined, now = Date.now()): boolean {
  const timestamp = parseTimestamp(lastSyncAt);
  return timestamp > 0 && now - timestamp < SYNC_STALE_INTERVAL_MS;
}
