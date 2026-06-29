import { prisma, getLiveTenants } from "/Users/markmccracken/Documents/signals/scripts/audit/lib/ctx";
import { buildPropertyDeepDiveReport } from "@/lib/reports/service";
function d(x:Date){return x.toISOString().slice(0,10);}
async function main(){
  const ts=await getLiveTenants(); const lf=ts.find(t=>/little feather/i.test(t.name))!;
  const lid="cmoqx89cr01sbqs0o7ov4gs43"; // unit_count=100
  const today=new Date();
  const ps=d(new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth(),1)));
  const rep=await buildPropertyDeepDiveReport({tenantId:lf.id,request:{granularity:"month",compareMode:"yoy_otb",selectedPeriodStart:ps,listingIds:[lid],channels:[],statuses:[],includeFees:true,includeVat:true} as any,displayCurrency:"GBP"});
  const row=rep.rows.find(r=>r.listingId===lid)!;
  // raw nights ignoring unit_count
  const raw=await prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*)::int n, COALESCE(SUM(CASE WHEN COALESCE(nf.los_nights,0)>0 AND COALESCE(r.total,0)>0 THEN r.total/nf.los_nights ELSE nf.revenue_allocated END),0)::float rev FROM night_facts nf LEFT JOIN reservations r ON r.id=nf.reservation_id WHERE nf.tenant_id=$1 AND nf.listing_id=$2 AND nf.is_occupied=true AND nf.date>=$3::date AND nf.date<=$4::date`,lf.id,lid,rep.period.start,rep.period.end);
  console.log("multi-unit(100) period",rep.period.start,rep.period.end,"mode",rep.period.mode);
  console.log("report current nights",row.current.nights,"adr",row.current.adr,"occ",row.current.occupancy);
  console.log("raw nights",raw[0].n,"adr",(raw[0].rev/raw[0].n).toFixed(2));
  console.log("reference nights",row.reference.nights,"adr",row.reference.adr,"deltaAdrPct",row.delta.adrPct);
  await prisma.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1);});
