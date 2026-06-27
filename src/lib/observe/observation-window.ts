/**
 * The 30-day holding window per client (SIGNALS-OBSERVE-LEARN-SPEC.md §7).
 *
 * Each client gets one `ObservationWindow` with a fresh 30-day clock on
 * onboarding. The daily job runs from day 1 but stays SILENT until
 * `daysObserved >= 30`, then graduates. Pure date logic is split out so it is
 * unit-testable; the DB wrappers are tenant-scoped.
 */

import { prisma } from "@/lib/prisma";

import { OBSERVATION_WINDOW_DAYS, defaultClientKey } from "./config";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole UTC days elapsed from `startedAt` to `now` (never negative). Pure. */
export function daysObserved(startedAt: Date, now: Date): number {
  const start = Date.UTC(startedAt.getUTCFullYear(), startedAt.getUTCMonth(), startedAt.getUTCDate());
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.max(0, Math.floor((end - start) / DAY_MS));
}

/** Whether the window has reached graduation. Pure. */
export function hasGraduated(startedAt: Date, now: Date, windowDays = OBSERVATION_WINDOW_DAYS): boolean {
  return daysObserved(startedAt, now) >= windowDays;
}

export type ObservationWindowRow = {
  id: string;
  tenantId: string;
  clientKey: string;
  startedAt: Date;
  daysObserved: number;
  status: string;
  graduatedAt: Date | null;
  backfilledAt: Date | null;
};

/**
 * Create the window with a fresh clock if absent, else return the existing one.
 * Tenant-scoped. `clientKey` defaults to the tenant id (one client per tenant).
 */
export async function ensureObservationWindow(args: {
  tenantId: string;
  clientKey?: string;
  now?: Date;
}): Promise<ObservationWindowRow> {
  const clientKey = args.clientKey ?? defaultClientKey(args.tenantId);
  const now = args.now ?? new Date();
  const existing = await prisma.observationWindow.findUnique({
    where: { tenantId_clientKey: { tenantId: args.tenantId, clientKey } }
  });
  if (existing) return existing;

  return prisma.observationWindow.create({
    data: { tenantId: args.tenantId, clientKey, startedAt: now, daysObserved: 0, status: "observing" }
  });
}

/**
 * Recompute `daysObserved`, stamp `lastRunAt`, and flip to `graduated` the first
 * day the window crosses the threshold. Returns whether THIS run graduated it
 * (the edge), which Phase 4 uses to fire the one-time day-30 readout.
 */
export async function advanceObservationWindow(args: {
  tenantId: string;
  clientKey?: string;
  now?: Date;
}): Promise<{ window: ObservationWindowRow; graduatedNow: boolean }> {
  const clientKey = args.clientKey ?? defaultClientKey(args.tenantId);
  const now = args.now ?? new Date();
  const window = await ensureObservationWindow({ tenantId: args.tenantId, clientKey, now });

  const days = daysObserved(window.startedAt, now);
  const shouldGraduate = days >= OBSERVATION_WINDOW_DAYS;
  const wasObserving = window.status !== "graduated";
  const graduatedNow = shouldGraduate && wasObserving;

  const updated = await prisma.observationWindow.update({
    where: { tenantId_clientKey: { tenantId: args.tenantId, clientKey } },
    data: {
      daysObserved: days,
      lastRunAt: now,
      status: shouldGraduate ? "graduated" : "observing",
      graduatedAt: graduatedNow ? now : window.graduatedAt
    }
  });

  return { window: updated, graduatedNow };
}

/** Mark the window as backfilled (one-time warm start). Tenant-scoped. */
export async function markBackfilled(args: {
  tenantId: string;
  clientKey?: string;
  now?: Date;
}): Promise<void> {
  const clientKey = args.clientKey ?? defaultClientKey(args.tenantId);
  await prisma.observationWindow.update({
    where: { tenantId_clientKey: { tenantId: args.tenantId, clientKey } },
    data: { backfilledAt: args.now ?? new Date() }
  });
}
