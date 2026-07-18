/**
 * Gate for the internal Pricing Recommendations page + every /api/recs route.
 *
 * TWO conditions, both required (2026-07-18 spec):
 *   1. the session's role is "admin" for the currently-active tenant, AND
 *   2. the session email is in INTERNAL_RECS_EMAILS (comma-separated env).
 * Plus the kill switch: RECS_PAGE_ENABLED must be exactly "true" — absent or
 * anything else hides the page entirely (no redeploy needed to kill it).
 *
 * Client-tenant admins must NEVER see the page, a nav link to it, or any
 * /api/recs data. API routes answer 404 (not 401/403) to non-internal users so
 * the route's existence is not advertised — mirroring how the page simply does
 * not exist for them.
 *
 * This is session auth — deliberately NOT the OBSERVE_READOUT_KEY ?key= pattern
 * (those two routes stay exactly as they are).
 */

import { env } from "@/lib/env";
import { getAuthContext, type AuthContext } from "@/lib/auth";

export type InternalRecsAuth = AuthContext;

/** Pure check so nav rendering and route gates share one definition. */
export function isInternalRecsUser(auth: { role: string; email: string } | null): boolean {
  if (!env.recsPageEnabled) return false;
  if (!auth) return false;
  if (auth.role !== "admin") return false;
  return env.internalRecsEmails.includes(auth.email.trim().toLowerCase());
}

/**
 * Resolve the session and apply the internal gate. Returns the auth context
 * when the caller may see the recs surface, null otherwise (callers 404 / hide).
 */
export async function getInternalRecsAuth(): Promise<InternalRecsAuth | null> {
  const auth = await getAuthContext();
  return isInternalRecsUser(auth) ? auth : null;
}
