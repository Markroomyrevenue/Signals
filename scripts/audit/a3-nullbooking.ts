/**
 * Agent 3 follow-up — quantify NULL booking_created_at impact on YoY-as-at.
 * The report path (groupNightFactsDailyByListing with excludeMissingBookingCreatedAt:true)
 * DROPS night_facts whose booking_created_at IS NULL from the yoy_otb reference,
 * while pace.ts INCLUDES them. Measure how many LY occupied nights this hides.
 * READ-ONLY.
 */
import { prisma, getLiveTenants } from "./lib/ctx";

function d(date: Date): string { return date.toISOString().slice(0, 10); }

async function main() {
  const tenants = await getLiveTenants();
  const today = new Date();
  const lyFrom = d(new Date(Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), today.getUTCDate())));
  const lyTo = d(new Date(Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth() + 6, today.getUTCDate())));
  const cutoff = d(new Date(Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), today.getUTCDate())));

  console.log(`LY-as-at window ${lyFrom}..${lyTo}, cutoff ${cutoff}\n`);
  console.log("tenant".padEnd(26), "occ_nights".padStart(11), "null_booked".padStart(12), "null_but_<=cutoff".padStart(18), "% hidden".padStart(10));
  console.log("-".repeat(82));

  for (const t of tenants) {
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT
         COUNT(*) FILTER (WHERE nf.is_occupied) ::int AS occ,
         COUNT(*) FILTER (WHERE nf.is_occupied AND nf.booking_created_at IS NULL)::int AS occ_null,
         COUNT(*) FILTER (WHERE nf.is_occupied AND nf.booking_created_at IS NULL)::int AS occ_null_le_cutoff
       FROM night_facts nf
       WHERE nf.tenant_id = $1 AND nf.date >= $2::date AND nf.date <= $3::date`,
      t.id, lyFrom, lyTo
    );
    const occ = Number(rows[0].occ), occNull = Number(rows[0].occ_null);
    // occupied rows with NULL booking_created_at are ENTIRELY dropped from yoy_otb (they
    // can never satisfy booking_created_at IS NOT NULL), so they are unconditionally hidden.
    const pctHidden = occ > 0 ? (occNull / occ) * 100 : 0;
    console.log(
      t.name.slice(0, 25).padEnd(26),
      String(occ).padStart(11),
      String(occNull).padStart(12),
      String(occNull).padStart(18),
      pctHidden.toFixed(2).padStart(10)
    );
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
