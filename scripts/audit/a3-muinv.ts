import { prisma } from "/Users/markmccracken/Documents/signals/scripts/audit/lib/ctx";
async function main(){
  const lid="cmoqx89cr01sbqs0o7ov4gs43";
  const tid="cmoeuax4x000ery6qv2emihce";
  // calendar_rates count current month vs LY month
  for (const [lbl,f,t] of [["CUR","2026-06-01","2026-06-30"],["LY","2025-06-01","2025-06-30"]] as any){
    const cr=await prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*)::int c FROM calendar_rates WHERE tenant_id=$1 AND listing_id=$2 AND date>=$3::date AND date<=$4::date`,tid,lid,f,t);
    const nf=await prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*)::int occ, COUNT(DISTINCT date)::int dd FROM night_facts WHERE tenant_id=$1 AND listing_id=$2 AND is_occupied=true AND date>=$3::date AND date<=$4::date`,tid,lid,f,t);
    console.log(lbl,"calendar_rates rows:",cr[0].c,"  occ night_facts:",nf[0].occ,"  distinct stay dates:",nf[0].dd);
  }
  const meta=await prisma.$queryRawUnsafe<any[]>(`SELECT unit_count, created_at FROM listings WHERE id=$1`,lid);
  console.log("listing unit_count:",meta[0].unit_count,"created_at:",meta[0].created_at);
  await prisma.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1);});
