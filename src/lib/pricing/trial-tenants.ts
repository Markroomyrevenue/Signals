/**
 * Tenant-level feature flag for the KeyData trial.
 *
 * Two trial tenants per spec: Stay Belfast and Little Feather.
 * - `KEYDATA_TRIAL_TENANT_IDS` (CUIDs, comma-separated) overrides the slug match.
 * - `KEYDATA_TRIAL_TENANTS` (slugs, comma-separated) matches against tenant
 *   `name` after lower-casing and replacing whitespace with `-`. So "Stay Belfast"
 *   → "stay-belfast" and "Little Feather Management" → "little-feather-management"
 *   (we also accept a prefix match to handle the "little-feather" config value).
 *
 * Outside the trial, callers receive `false` and the new pricing logic is dead code
 * for that tenant.
 */

import { prisma } from "@/lib/prisma";

function readEnvList(name: string): string[] {
  const raw = process.env[name] ?? "";
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

export function tenantNameSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

export type TrialTenantInfo = {
  id: string;
  name: string;
  slug: string;
};

export function isTrialTenant(tenant: { id: string; name: string }): boolean {
  const idAllow = readEnvList("KEYDATA_TRIAL_TENANT_IDS");
  if (idAllow.includes(tenant.id.toLowerCase())) return true;
  const slugAllow = readEnvList("KEYDATA_TRIAL_TENANTS");
  if (slugAllow.length === 0) return false;
  const slug = tenantNameSlug(tenant.name);
  return slugAllow.some((target) => slug === target || slug.startsWith(`${target}-`) || target === slug.split("-")[0]);
}

/** Resolve the actual trial tenant rows from the DB for use by workers/scripts. */
export async function listTrialTenants(): Promise<TrialTenantInfo[]> {
  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true } });
  return tenants
    .filter((t) => isTrialTenant(t))
    .map((t) => ({ id: t.id, name: t.name, slug: tenantNameSlug(t.name) }));
}

export function trialDateWindow(): { start: string; end: string } {
  return {
    start: process.env.KEYDATA_TRIAL_START ?? "2026-04-29",
    end: process.env.KEYDATA_TRIAL_END ?? "2026-05-13"
  };
}
