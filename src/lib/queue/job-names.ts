export const SYNC_JOB_NAMES = {
  TENANT_SYNC: "tenant-sync",
  CALENDAR_SYNC_LISTING: "calendar-sync-listing",
  PACE_SNAPSHOT: "pace-snapshot"
} as const;

export type TenantSyncMode = "core" | "extended";

export type TenantSyncJobPayload = {
  tenantId: string;
  reason?: string;
  forceFull?: boolean;
  syncMode?: TenantSyncMode;
  queueExtendedAfter?: boolean;
};

export type CalendarSyncJobPayload = {
  tenantId: string;
  listingId: string;
  dateFrom: string;
  dateTo: string;
};

export type PaceSnapshotJobPayload = {
  tenantId: string;
  snapshotDate?: string;
  backfillDays?: number;
};
