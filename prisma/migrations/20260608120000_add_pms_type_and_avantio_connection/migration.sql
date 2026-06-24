-- Multi-PMS support: tag every tenant with its PMS, and give Avantio its own
-- credentials table mirroring hostaway_connections. Backwards-compatible:
-- existing tenants default to pms_type 'HOSTAWAY' so the Hostaway path is
-- unchanged. Listings + reservations keep the same hostaway_id column;
-- it now stores whichever external PMS id is correct per tenant.pms_type.

-- 1. Tenant gets a pms_type discriminator. NOT NULL DEFAULT keeps existing rows
--    on the Hostaway path automatically.
ALTER TABLE "tenants" ADD COLUMN "pms_type" TEXT NOT NULL DEFAULT 'HOSTAWAY';

-- 2. New table holding Avantio API credentials. One row per tenant, same 1:1
--    shape as hostaway_connections so the connection-loader pattern can be
--    shared. base_url defaults to Avantio's production PMS endpoint.
CREATE TABLE "avantio_connections" (
    "tenant_id" TEXT NOT NULL,
    "api_key_encrypted" TEXT,
    "base_url" TEXT NOT NULL DEFAULT 'https://api.avantio.pro/pms',
    "company_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "last_sync_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "avantio_connections_pkey" PRIMARY KEY ("tenant_id")
);

-- Mirrors hostaway_connections: indexed on status so dormant/failed
-- accounts can be surfaced cheaply.
CREATE INDEX "avantio_connections_status_idx" ON "avantio_connections"("status");

-- Cascade-delete the connection row when the parent tenant is removed,
-- matching the Hostaway-side relationship.
ALTER TABLE "avantio_connections" ADD CONSTRAINT "avantio_connections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
