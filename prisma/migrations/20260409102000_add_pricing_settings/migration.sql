CREATE TABLE IF NOT EXISTS pricing_settings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  scope_ref TEXT,
  settings JSONB NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS pricing_settings_tenant_id_scope_scope_ref_key
  ON pricing_settings (tenant_id, scope, scope_ref);

CREATE INDEX IF NOT EXISTS pricing_settings_tenant_id_scope_idx
  ON pricing_settings (tenant_id, scope);
