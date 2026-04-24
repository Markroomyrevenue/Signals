-- Creates the attention_task_suppressions table.
-- The model was defined in schema.prisma but no migration existed for it, so
-- any fresh database (like the first Railway Postgres) was missing the table.

CREATE TABLE IF NOT EXISTS attention_task_suppressions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  task_key TEXT NOT NULL,
  action TEXT NOT NULL,
  suppressed_until TIMESTAMP(3) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS attention_task_suppressions_tenant_id_listing_id_task_key_key
  ON attention_task_suppressions (tenant_id, listing_id, task_key);

CREATE INDEX IF NOT EXISTS attention_task_suppressions_tenant_id_suppressed_until_idx
  ON attention_task_suppressions (tenant_id, suppressed_until);

CREATE INDEX IF NOT EXISTS attention_task_suppressions_tenant_id_listing_id_idx
  ON attention_task_suppressions (tenant_id, listing_id);
