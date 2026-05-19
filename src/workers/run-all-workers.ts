/**
 * Single-process entry that starts ALL BullMQ workers this app needs:
 *
 *   1. Sync worker (Hostaway reservation + calendar sync) — `sync-worker.ts`
 *   2. Pricing-comparison worker (KeyData trial daily run at 06:00 London +
 *      Day-14 summary one-shot) — `pricing-comparison-worker.ts`
 *
 * Running both in one process keeps the ops model simple: `worker.sh`
 * runs `npm run worker`, which runs this file, which spins up both.
 *
 * Until 2026-05-18 the `worker` npm script pointed only at the sync
 * worker, which is why the 06:00 pricing-comparison schedule never
 * fired in production — the queue had no consumer. This file is the
 * fix.
 */

// The sync worker registers itself at module load (Worker is constructed
// at the top level of sync-worker.ts), so a bare import is enough.
import "@/workers/sync-worker";

// The pricing-comparison worker exposes an explicit `startWorker` so it
// can be lazy-instantiated. Call it here.
import { startWorker as startPricingComparisonWorker } from "@/workers/pricing-comparison-worker";

startPricingComparisonWorker()
  .then(() => console.log("[run-all-workers] pricing-comparison worker started"))
  .catch((err) => {
    console.error("[run-all-workers] pricing-comparison worker failed to start", err);
    process.exit(1);
  });

console.log("[run-all-workers] sync worker started (via import side-effect)");
