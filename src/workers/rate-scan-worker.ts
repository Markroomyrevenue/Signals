import { Worker, type Job } from "bullmq";

import { redisConnectionOptions } from "@/lib/queue/connection";
import {
  RATE_SCAN_QUEUE_NAME,
  rateScanQueue,
  scheduleRateScanMidday,
  scheduleRateScanMorning
} from "@/lib/queue/queues";
import { prisma } from "@/lib/prisma";
import { scanTenant } from "@/lib/signals/scan-service";

/**
 * Signals rate-scan worker. Mirrors `rate-copy-push-worker.ts`.
 *
 * Read-only with respect to the rest of the tool: every job runs
 * `scanTenant`, which fetches live Hostaway calendar rates (GET only) and
 * writes solely to the four `signals` tables. `"scheduled"` jobs are the
 * 07:00 + 12:00 Europe/London repeatable runs; `"manual"` is a one-off
 * enqueued by hand for smoke-testing.
 */
type ScheduledJob = { tenantId: string; kind: "scheduled" | "manual" };

async function processJob(job: Job<ScheduledJob>): Promise<unknown> {
  const { tenantId, kind } = job.data;
  if (!tenantId) throw new Error("rate-scan: missing tenantId");
  console.log(`[rate-scan] starting tenant=${tenantId} kind=${kind}`);
  const result = await scanTenant({ tenantId, trigger: kind === "manual" ? "manual" : "scheduled" });
  console.log(
    `[rate-scan] done tenant=${tenantId} scan=${result.scanId} listings=${result.listingCount} ` +
      `changes=${result.changeCount} failed=${result.failedCount} status=${result.status}`
  );
  return result;
}

async function ensureSchedulesForLiveTenants(): Promise<void> {
  // Only tenants with an active Hostaway connection are scanned — the scan
  // calls Hostaway, so demo/sample-only tenants are skipped. Re-running this
  // is idempotent (jobIds stay stable per tenant); add/remove a tenant and it
  // is picked up on the next worker boot.
  const connections = await prisma.hostawayConnection.findMany({
    where: { status: "active" },
    select: { tenantId: true }
  });
  for (const connection of connections) {
    await scheduleRateScanMorning({ tenantId: connection.tenantId });
    await scheduleRateScanMidday({ tenantId: connection.tenantId });
  }
  console.log(
    `[rate-scan] registered 07:00 + 12:00 (Europe/London) scans for ${connections.length} live tenants`
  );
}

export async function startWorker(): Promise<Worker<ScheduledJob>> {
  const worker = new Worker<ScheduledJob>(RATE_SCAN_QUEUE_NAME, processJob, {
    connection: redisConnectionOptions(),
    concurrency: 1 // serialise — one tenant at a time so logs + Hostaway load stay sane
  });
  worker.on("completed", (job) => console.log(`[rate-scan] completed job ${job.id}`));
  worker.on("failed", (job, err) =>
    console.error(`[rate-scan] failed job ${job?.id}`, err instanceof Error ? err.message : err)
  );
  process.on("SIGTERM", async () => {
    await worker.close();
    await rateScanQueue.close();
    process.exit(0);
  });
  await ensureSchedulesForLiveTenants();
  return worker;
}

if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  startWorker()
    .then(() => console.log(`[rate-scan] worker started on queue ${RATE_SCAN_QUEUE_NAME}`))
    .catch((err) => {
      console.error("[rate-scan] failed to start", err);
      process.exit(1);
    });
}
