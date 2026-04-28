/**
 * Separate BullMQ queue for the KeyData trial pricing-comparison work.
 * NOT shared with the sync queue per spec §10 ("don't modify the sync queue").
 */
import { Queue } from "bullmq";
import { redisConnectionOptions } from "@/lib/queue/connection";

export const PRICING_COMPARISON_QUEUE_NAME = "pricing-comparison";

export const PRICING_COMPARISON_JOB_NAMES = {
  DAILY_RUN: "comparison-daily-run",
  AUDIT_FOLLOW_UP: "defensibility-audit-follow-up"
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
