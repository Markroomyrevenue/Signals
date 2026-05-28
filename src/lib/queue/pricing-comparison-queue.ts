/**
 * Separate BullMQ queue for the KeyData trial pricing-comparison work.
 * NOT shared with the sync queue per spec §10 ("don't modify the sync queue").
 */
import { Queue } from "bullmq";
import { redisConnectionOptions } from "@/lib/queue/connection";

export const PRICING_COMPARISON_QUEUE_NAME = "pricing-comparison";

export const PRICING_COMPARISON_JOB_NAMES = {
  DAILY_RUN: "comparison-daily-run",
  AUDIT_FOLLOW_UP: "defensibility-audit-follow-up",
  DAY14_SUMMARY: "comparison-day14-summary",
  /**
   * 2026-05-28 trial-pause work. Daily 07:00 BST job that spawns
   * `scripts/snapshot-trial-final.ts` as a child process. Writes a
   * rolling archive to `cache/trial-final-{YYYY-MM-DD}/` so we have
   * a fresh, self-contained snapshot every morning during the trial
   * pause window.
   */
  SNAPSHOT_TRIAL_FINAL: "snapshot-trial-final"
} as const;

export type PricingComparisonDailyRunPayload = {
  snapshotDate?: string;
  reason?: string;
};

export type DefensibilityAuditFollowUpPayload = {
  snapshotDate: string;
  tenantId: string;
  runId: string;
};

export type Day14SummaryPayload = {
  /** Snapshot date the summary is anchored to (typically trial end date). */
  reportDate: string;
  reason?: string;
};

export type SnapshotTrialFinalPayload = {
  reason?: string;
};

let _queue: Queue | null = null;
export function pricingComparisonQueue(): Queue {
  if (_queue) return _queue;
  _queue = new Queue(PRICING_COMPARISON_QUEUE_NAME, {
    connection: redisConnectionOptions(),
    defaultJobOptions: {
      removeOnComplete: 30,
      removeOnFail: 60,
      attempts: 2,
      backoff: { type: "exponential", delay: 5000 }
    }
  });
  return _queue;
}
