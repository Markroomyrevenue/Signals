export const SYNC_JOB_NAMES = {
  TENANT_SYNC: "tenant-sync",
  CALENDAR_SYNC_LISTING: "calendar-sync-listing",
  PACE_SNAPSHOT: "pace-snapshot",
  /**
   * Estate-wide daily fan-out for non-Hostaway tenants (Guesty/Avantio).
   * Hostaway tenants stay fresh via webhooks + the hourly rate-copy
   * source-sync; pull-only PMSes need a scheduled daily delta sync or a
   * client's dashboard silently goes stale. Enumerates tenants at RUN
   * time (like the observe reconcile), so tenants added after worker
   * boot are picked up without a restart.
   */
  PMS_DAILY_SYNC: "pms-daily-sync"
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
