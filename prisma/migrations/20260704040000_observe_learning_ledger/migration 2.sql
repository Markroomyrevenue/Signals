-- Append-only learning ledger: one row per (run, learning #1-#7) with the
-- sample count used or the reason the learning produced nothing. Makes
-- learning starvation visible (prod ran six green runs with pricing power
-- null for every client because daily_aggs was empty, and nothing showed it).
CREATE TABLE "observe_learning_ledger" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_key" TEXT NOT NULL,
    "run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "learning" TEXT NOT NULL,
    "sample_count" INTEGER,
    "null_reason" TEXT,

    CONSTRAINT "observe_learning_ledger_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "observe_learning_ledger_tenant_id_run_at_idx" ON "observe_learning_ledger"("tenant_id", "run_at");

CREATE INDEX "observe_learning_ledger_tenant_id_learning_run_at_idx" ON "observe_learning_ledger"("tenant_id", "learning", "run_at");

ALTER TABLE "observe_learning_ledger" ADD CONSTRAINT "observe_learning_ledger_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
