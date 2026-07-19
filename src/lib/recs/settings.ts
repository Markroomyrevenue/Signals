/**
 * Per-client recs settings + per-listing snoozes (Mark's asks, 2026-07-19).
 *
 * Stored as `recs_evidence` rows (clientKey = tenantId) so no migration is
 * needed and everything stays tenant-scoped + cascade-deleted:
 *   - kind "client-settings"            → { allowBelowFloor, updatedBy, updatedAt }
 *   - kind "listing-snooze:<listingId>" → { until, byEmail, at }
 *
 * Deliberately NOT in `pricing_settings` — that table's property rows are
 * full-replaced by two different editors (the 2026-06-30 Edge clobber) and
 * recs state must never be collateral damage.
 *
 * allowBelowFloor (default OFF): when a client's operator routinely prices
 * below the resolved floor (Yo's), the toggle lets recs propose — and pushes
 * carry — values below it. The floor stays displayed on every row and each
 * below-floor row is flagged; the fat-finger bound on edited prices (≥50% of
 * the night's basis) still applies. Snoozes ("don't raise this listing for 30
 * days") hide a listing from the surface WITHOUT stopping generation or
 * decision memory, and expire on their own so a listing can't be forgotten.
 */

import { prisma } from "@/lib/prisma";

export type ClientRecsSettings = { allowBelowFloor: boolean };

const SETTINGS_KIND = "client-settings";
const SNOOZE_PREFIX = "listing-snooze:";
export const SNOOZE_DEFAULT_DAYS = 30;

export async function readClientRecsSettings(tenantId: string): Promise<ClientRecsSettings> {
  const row = await prisma.recsEvidence.findFirst({
    where: { tenantId, clientKey: tenantId, kind: SETTINGS_KIND },
    select: { payload: true }
  });
  const payload = row?.payload as { allowBelowFloor?: unknown } | null;
  return { allowBelowFloor: payload?.allowBelowFloor === true };
}

export async function writeClientRecsSettings(args: {
  tenantId: string;
  allowBelowFloor: boolean;
  byEmail: string;
}): Promise<void> {
  const payload = { allowBelowFloor: args.allowBelowFloor, updatedBy: args.byEmail, updatedAt: new Date().toISOString() };
  await prisma.recsEvidence.upsert({
    where: { tenantId_clientKey_kind: { tenantId: args.tenantId, clientKey: args.tenantId, kind: SETTINGS_KIND } },
    create: {
      tenantId: args.tenantId,
      clientKey: args.tenantId,
      kind: SETTINGS_KIND,
      provenance: "live-observed",
      payload
    },
    update: { payload, computedAt: new Date() }
  });
}

/** listingId → ISO date the snooze runs until (only future snoozes returned). */
export async function readListingSnoozes(tenantId: string, now = new Date()): Promise<Map<string, string>> {
  const rows = await prisma.recsEvidence.findMany({
    where: { tenantId, clientKey: tenantId, kind: { startsWith: SNOOZE_PREFIX } },
    select: { kind: true, payload: true }
  });
  const out = new Map<string, string>();
  for (const row of rows) {
    const listingId = row.kind.slice(SNOOZE_PREFIX.length);
    const until = (row.payload as { until?: unknown } | null)?.until;
    if (typeof until === "string" && Date.parse(until) > now.getTime()) out.set(listingId, until);
  }
  return out;
}

export async function snoozeListing(args: {
  tenantId: string;
  listingId: string;
  byEmail: string;
  days?: number;
  now?: Date;
}): Promise<{ until: string }> {
  const now = args.now ?? new Date();
  const days = Math.min(365, Math.max(1, Math.round(args.days ?? SNOOZE_DEFAULT_DAYS)));
  const until = new Date(now.getTime() + days * 86_400_000).toISOString();
  const payload = { until, byEmail: args.byEmail, at: now.toISOString() };
  await prisma.recsEvidence.upsert({
    where: {
      tenantId_clientKey_kind: {
        tenantId: args.tenantId,
        clientKey: args.tenantId,
        kind: `${SNOOZE_PREFIX}${args.listingId}`
      }
    },
    create: {
      tenantId: args.tenantId,
      clientKey: args.tenantId,
      kind: `${SNOOZE_PREFIX}${args.listingId}`,
      provenance: "live-observed",
      payload
    },
    update: { payload, computedAt: now }
  });
  return { until };
}

export async function unsnoozeListing(args: { tenantId: string; listingId: string }): Promise<void> {
  await prisma.recsEvidence.deleteMany({
    where: { tenantId: args.tenantId, clientKey: args.tenantId, kind: `${SNOOZE_PREFIX}${args.listingId}` }
  });
}
