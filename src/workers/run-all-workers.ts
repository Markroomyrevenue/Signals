/**
 * Single-process entry that starts ALL BullMQ workers this app needs:
 *
 *   1. Sync worker (Hostaway reservation + calendar sync) — `sync-worker.ts`
 *   2. Pricing-comparison worker (KeyData trial daily run at 06:00 London +
 *      Day-14 summary one-shot) — `pricing-comparison-worker.ts`
 *   3. Rate-copy push worker (HOURLY source-sync on the hour + delta-only
 *      push at :30 past the hour of derived rates to Hostaway for
 *      rate_copy-enabled listings) — `rate-copy-push-worker.ts`
 *   4. Rate-scan worker (read-only Signals scanner: 07:00 + 12:00 snapshot
 *      of live Hostaway rates into the signals tables) —
 *      `rate-scan-worker.ts`
 *
 * Running them all in one process keeps the ops model simple: `worker.sh`
 * runs `npm run worker`, which runs this file, which spins them all up.
 *
 * Until 2026-05-18 the `worker` npm script pointed only at the sync
 * worker, which is why the 06:00 pricing-comparison schedule never
 * fired in production — the queue had no consumer. The rate-copy
 * worker had the same problem (queue + schedule existed but worker
 * was never booted); fixed 2026-06-01 by adding the import here.
 */

// The sync worker registers itself at module load (Worker is constructed
// at the top level of sync-worker.ts), so a bare import is enough.
import "@/workers/sync-worker";

// The pricing-comparison worker exposes an explicit `startWorker` so it
// can be lazy-instantiated. Call it here.
import { startWorker as startPricingComparisonWorker } from "@/workers/pricing-comparison-worker";
import { startWorker as startRateCopyPushWorker } from "@/workers/rate-copy-push-worker";
import { startWorker as startRateScanWorker } from "@/workers/rate-scan-worker";
import { startWorker as startObserveWorker } from "@/workers/observe-worker";

startPricingComparisonWorker()
  .then(() => console.log("[run-all-workers] pricing-comparison worker started"))
  .catch((err) => {
    console.error("[run-all-workers] pricing-comparison worker failed to start", err);
    process.exit(1);
  });

startRateCopyPushWorker()
  .then(() => console.log("[run-all-workers] rate-copy-push worker started"))
  .catch((err) => {
    console.error("[run-all-workers] rate-copy-push worker failed to start", err);
    process.exit(1);
  });

startRateScanWorker()
  .then(() => console.log("[run-all-workers] rate-scan worker started"))
  .catch((err) => {
    console.error("[run-all-workers] rate-scan worker failed to start", err);
    process.exit(1);
  });

startObserveWorker()
  .then(() => console.log("[run-all-workers] observe-learn worker started"))
  .catch((err) => {
    console.error("[run-all-workers] observe-learn worker failed to start", err);
    process.exit(1);
  });

console.log("[run-all-workers] sync worker started (via import side-effect)");
