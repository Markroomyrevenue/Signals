/**
 * Observe-and-learn tunables (single source of truth).
 *
 * The observation loop is read-only: it captures the engine's levers, diffs them
 * into change events, manages each client's 30-day holding window, and stays
 * SILENT (proposes/pushes nothing) until graduation. Every knob the loop depends
 * on lives here.
 */

/** Length of the holding window before a client graduates (spec §7). */
export const OBSERVATION_WINDOW_DAYS = 30;

/** Per-tenant client key default: one client == one tenant for now (spec §4). */
export function defaultClientKey(tenantId: string): string {
  return tenantId;
}

/** Ignore sub-epsilon price noise so float dust is not logged as an engine move. */
export const ENGINE_CHANGE_EPSILON = 0.01;

/**
 * A detected engine change is attributed to the engine itself when its timing is
 * within this many hours of the engine's own `last_refreshed_at` / a
 * `recent_changes` event (spec §6 change-source inference).
 */
export const SOURCE_MATCH_WINDOW_HOURS = 24;

/** Days forward to pull the engine price-calendar when capturing per-date levers. */
export const ENGINE_CALENDAR_DAYS = 180;

/** BullMQ cron for the daily observe run (before the 07:00 rate-scan). */
export const OBSERVE_DAILY_CRON = "30 5 * * *";

/** BullMQ cron for the weekly settle (learning #6, net realised rate). */
export const OBSERVE_WEEKLY_SETTLE_CRON = "0 6 * * 1";

/** Timezone for all observe schedules. */
export const OBSERVE_TZ = "Europe/London";
