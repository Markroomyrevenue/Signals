-- Add role, display name, and last_login_at to users so we can
-- distinguish admins (who can see Calendar/pricing + manage staff)
-- from reporting-only viewers.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "role" TEXT NOT NULL DEFAULT 'viewer',
  ADD COLUMN IF NOT EXISTS "display_name" TEXT,
  ADD COLUMN IF NOT EXISTS "last_login_at" TIMESTAMPTZ;

-- Any user that exists today was created by the owner during setup —
-- promote them to admin so they don't lose access to Calendar/pricing.
UPDATE "users" SET "role" = 'admin' WHERE "role" = 'viewer';

CREATE INDEX IF NOT EXISTS "users_tenant_id_role_idx" ON "users" ("tenant_id", "role");
