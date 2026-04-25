// Reservation fallback window controls how far back/forward we ask Hostaway
// for full reservation history when there is no `lastSyncAt` to anchor a delta
// pull. 365/365 keeps the working set small enough to finish on Railway's
// 1 GiB ephemeral disk; bump via env vars if a backfill needs more breathing
// room (see CLAUDE.md). Calendar fetch window is intentionally separate.
const DEFAULT_RESERVATION_BACK_DAYS = 365;
const DEFAULT_RESERVATION_FORWARD_DAYS = 365;

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

const reservationFallbackBackDays = readPositiveIntegerEnv(
  "SYNC_DAYS_BACK",
  DEFAULT_RESERVATION_BACK_DAYS
);
const reservationFallbackForwardDays = readPositiveIntegerEnv(
  "SYNC_DAYS_FORWARD",
  DEFAULT_RESERVATION_FORWARD_DAYS
);

export const SYNC_CONFIG = {
  calendarBackDays: 90,
  calendarForwardDays: 365,
  reservationFallbackBackDays,
  reservationFallbackForwardDays,
  calendarJobBatchSize: 1000,
  calendarJobConcurrencyTarget: 20
} as const;
