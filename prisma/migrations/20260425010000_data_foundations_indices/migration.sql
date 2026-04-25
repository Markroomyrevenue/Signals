-- Adds indices on hot query paths discovered during the 2026-04-25 data
-- foundations review. None of these change behaviour; they only speed up
-- queries that already exist.
--
-- Pattern notes for future maintainers:
--  - Every index includes tenant_id as the leading column to keep
--    multi-tenant isolation efficient (most queries already filter by
--    tenant_id, and Postgres can use the leading prefix on its own).
--  - night_facts is partitioned by date, so CREATE INDEX automatically
--    creates child indices on every existing partition and any new
--    partition created by ensure_monthly_partition().

-- 1. night_facts(tenant_id, reservation_id)
--    Sync engine deletes/rebuilds night_facts by reservation id during
--    every sync (`prisma.nightFact.deleteMany({ where: { tenantId,
--    reservationId: { in: chunk } } })`). Without this index the delete
--    has to scan every partition that overlaps the working set.
CREATE INDEX IF NOT EXISTS idx_night_facts_tenant_reservation
  ON night_facts (tenant_id, reservation_id);

-- 2. reservations(tenant_id, source_updated_at)
--    Hostaway delta-sync uses source_updated_at to detect changes and we
--    will sort by it during webhook reconciliation. Cheap to add now and
--    avoids a future migration.
CREATE INDEX IF NOT EXISTS idx_reservations_tenant_source_updated_at
  ON reservations (tenant_id, source_updated_at);

-- 3. reservations(tenant_id, listing_id, arrival)
--    Composite index for the common "all reservations for a listing
--    arriving in a window" pattern used by reports/service.ts. The
--    existing (tenant_id, listing_id, arrival, departure) index covers
--    this, but Postgres prefers a smaller leading prefix when departure
--    is not part of the predicate. We mirror the existing index here as
--    a comment-only no-op so schema.prisma stays in lockstep without
--    requiring a duplicate.

-- 4. sync_runs(tenant_id, status, finished_at DESC)
--    /api/sync/status finds the latest extended-sync success ordered by
--    finished_at descending; without this index it sequentially scans
--    every sync_run row for the tenant.
CREATE INDEX IF NOT EXISTS idx_sync_runs_tenant_status_finished_at
  ON sync_runs (tenant_id, status, finished_at DESC);

-- 5. sync_runs(tenant_id, job_type)
--    Same /api/sync/status query also filters job_type ENDS WITH
--    "__extended". A btree index supports the equality form which we
--    will move to once the job_type column gets a small enum domain.
CREATE INDEX IF NOT EXISTS idx_sync_runs_tenant_job_type
  ON sync_runs (tenant_id, job_type);

-- 6. listings(tenant_id) — plain leading-only index for the very common
--    "all listings for tenant" query. The existing
--    (tenant_id, status) and (tenant_id, timezone) composites cover it
--    via prefix, but having a dedicated narrow index keeps planner cost
--    predictable when the table grows past a few thousand rows.
CREATE INDEX IF NOT EXISTS idx_listings_tenant
  ON listings (tenant_id);
