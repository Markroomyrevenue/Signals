-- Guesty PMS support: credentials table mirroring hostaway_connections /
-- avantio_connections, plus a DB-cached OAuth2 access token. The token is
-- persisted (encrypted) with its expiry because Guesty issues at most FIVE
-- tokens per 24h per clientId — every process (web + worker) must reuse the
-- same cached token instead of fetching its own.
CREATE TABLE "guesty_connections" (
    "tenant_id" TEXT NOT NULL,
    "client_id_encrypted" TEXT,
    "client_secret_encrypted" TEXT,
    "access_token_encrypted" TEXT,
    "token_expires_at" TIMESTAMP(3),
    "account_name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "last_sync_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guesty_connections_pkey" PRIMARY KEY ("tenant_id")
);

-- Mirrors the other connection tables: indexed on status so dormant/failed
-- accounts can be surfaced cheaply.
CREATE INDEX "guesty_connections_status_idx" ON "guesty_connections"("status");

-- Cascade-delete the connection row when the parent tenant is removed,
-- matching the Hostaway/Avantio-side relationships.
ALTER TABLE "guesty_connections" ADD CONSTRAINT "guesty_connections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
