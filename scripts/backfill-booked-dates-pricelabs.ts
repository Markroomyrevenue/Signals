/**
 * Backfill true booking dates from PriceLabs onto reservations whose
 * PMS stamped imported history with the import date (Guesty does this on
 * migration — every pre-migration reservation's createdAt becomes the
 * import day, which zeroes "Booked vs LY" and "Pace vs LY").
 *
 * PriceLabs' RM Partner API (`/rm/v1/reservation_data`) returns each
 * reservation with `booked_date` = when the booking was actually made.
 * This script matches PL rows to ours by listing + check-in + check-out
 * (PL mirrors the Guesty connection, so listing ids are the Guesty ids),
 * and sets `Reservation.bookedAtOverride` ONLY where:
 *   - our createdAt is on/after the import-stamp date (default 2026-06-20), AND
 *   - PriceLabs' booked_date is EARLIER than our createdAt.
 * Genuine post-migration bookings keep their real dates. The override
 * column is outside the sync write-set, so nightly re-syncs can't undo it.
 * After applying, night facts are rebuilt for the touched reservations
 * (lead time + pace read nf.booking_created_at) and a fresh pace
 * snapshot is taken.
 *
 * DRY RUN by default — pass --apply to write.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/backfill-booked-dates-pricelabs.ts \
 *     --tenant-id=<id> --pl-user-id=250029 [--key-env=PRICELABS_KEY_RM] \
 *     [--pms=guesty] [--import-stamp-start=2026-06-20] [--apply]
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local" });

import { prisma } from "../src/lib/prisma";
import { rebuildNightFactsForReservations } from "../src/lib/sync/nightfact";
import { runPaceSnapshotForTenant } from "../src/lib/sync/pace";

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    if (eq === -1) args[raw.slice(2)] = true;
    else args[raw.slice(2, eq)] = raw.slice(eq + 1);
  }
  return args;
}

function requireString(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`--${key}=<value> is required`);
  return value.trim();
}

type PlReservation = {
  listing_id?: string | number;
  reservation_id?: string | number;
  booked_date?: string;
  check_in?: string;
  check_out?: string;
  booking_status?: string;
};

async function fetchAllPlReservations(params: {
  apiKey: string;
  plUserId: string;
  pms: string;
}): Promise<PlReservation[]> {
  const all: PlReservation[] = [];
  let offset = 0;
  while (true) {
    const url =
      `https://api.pricelabs.co/rm/v1/reservation_data?pms=${encodeURIComponent(params.pms)}` +
      `&start_date=2015-01-01&end_date=2035-01-01&limit=100&offset=${offset}`;
    const response = await fetch(url, {
      headers: {
        "X-API-Key": params.apiKey,
        "PL-User-Id": params.plUserId,
        Accept: "application/json"
      }
    });
    if (!response.ok) {
      throw new Error(`PriceLabs reservation_data failed (${response.status}): ${(await response.text()).slice(0, 200)}`);
    }
    const body = (await response.json()) as { reservations?: PlReservation[]; data?: PlReservation[]; next_page?: boolean };
    const rows = Array.isArray(body) ? (body as PlReservation[]) : body.reservations ?? body.data ?? [];
    all.push(...rows);
    if (!body.next_page || rows.length === 0) break;
    offset += rows.length;
    await new Promise((resolve) => setTimeout(resolve, 300)); // be polite
  }
  return all;
}

/** cancelled-vs-live alignment so a rebooked identical stay can't cross-match. */
function statusBucket(status: string): "cancelled" | "live" {
  const normalized = status.toLowerCase();
  return normalized === "cancelled" || normalized === "canceled" ? "cancelled" : "live";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tenantId = requireString(args, "tenant-id");
  const plUserId = requireString(args, "pl-user-id");
  const keyEnv = typeof args["key-env"] === "string" ? (args["key-env"] as string) : "PRICELABS_KEY_RM";
  const pms = typeof args.pms === "string" ? (args.pms as string) : "guesty";
  const importStampStart = new Date(
    typeof args["import-stamp-start"] === "string" ? (args["import-stamp-start"] as string) : "2026-06-20"
  );
  const apply = args.apply === true;

  const apiKey = process.env[keyEnv]?.trim();
  if (!apiKey) throw new Error(`env var ${keyEnv} is empty or unset`);

  const plRows = await fetchAllPlReservations({ apiKey, plUserId, pms });
  console.log(`[backfill-booked] PriceLabs returned ${plRows.length} reservations for PL user ${plUserId}`);

  const ours = await prisma.reservation.findMany({
    where: { tenantId },
    select: {
      id: true,
      status: true,
      createdAt: true,
      bookedAtOverride: true,
      arrival: true,
      departure: true,
      listing: { select: { hostawayId: true } }
    }
  });
  console.log(`[backfill-booked] tenant has ${ours.length} reservations`);

  // Group both sides by listing|check-in|check-out|status-bucket; only
  // 1:1 groups match (a rebooked identical stay stays untouched).
  type OurRow = (typeof ours)[number];
  const ourGroups = new Map<string, OurRow[]>();
  for (const row of ours) {
    const key = `${row.listing.hostawayId}|${row.arrival.toISOString().slice(0, 10)}|${row.departure
      .toISOString()
      .slice(0, 10)}|${statusBucket(row.status)}`;
    ourGroups.set(key, [...(ourGroups.get(key) ?? []), row]);
  }

  const plGroups = new Map<string, PlReservation[]>();
  for (const row of plRows) {
    if (!row.listing_id || !row.check_in || !row.check_out || !row.booked_date) continue;
    const key = `${row.listing_id}|${row.check_in}|${row.check_out}|${statusBucket(row.booking_status ?? "")}`;
    plGroups.set(key, [...(plGroups.get(key) ?? []), row]);
  }

  let matched = 0;
  let ambiguous = 0;
  let repairable: Array<{ id: string; bookedAt: Date }> = [];
  for (const [key, plGroup] of plGroups) {
    const ourGroup = ourGroups.get(key);
    if (!ourGroup) continue;
    if (plGroup.length !== 1 || ourGroup.length !== 1) {
      ambiguous += 1;
      continue;
    }
    matched += 1;
    const our = ourGroup[0];
    const plBooked = new Date(plGroup[0].booked_date!);
    if (Number.isNaN(plBooked.getTime())) continue;
    const alreadySet =
      our.bookedAtOverride !== null && Math.abs(our.bookedAtOverride.getTime() - plBooked.getTime()) < 1000;
    if (our.createdAt >= importStampStart && plBooked < our.createdAt && !alreadySet) {
      repairable.push({ id: our.id, bookedAt: plBooked });
    }
  }

  console.log(
    `[backfill-booked] matched 1:1 = ${matched}, ambiguous groups skipped = ${ambiguous}, ` +
      `repairable (import-stamped, PL earlier) = ${repairable.length}`
  );

  if (!apply) {
    console.log("[backfill-booked] DRY RUN — pass --apply to write overrides + rebuild night facts");
    await prisma.$disconnect();
    return;
  }

  for (const item of repairable) {
    await prisma.reservation.update({
      where: { id: item.id },
      data: { bookedAtOverride: item.bookedAt }
    });
  }
  console.log(`[backfill-booked] wrote ${repairable.length} bookedAtOverride values`);

  const rebuild = await rebuildNightFactsForReservations(
    tenantId,
    repairable.map((item) => item.id)
  );
  console.log(`[backfill-booked] night facts rebuilt: ${rebuild.rowsUpserted} rows`);

  await runPaceSnapshotForTenant(tenantId, new Date(), 0);
  console.log(`[backfill-booked] pace snapshot refreshed`);

  await prisma.$disconnect();
}

void main().catch(async (error) => {
  console.error("[backfill-booked] FAILED:", error instanceof Error ? error.message : error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
