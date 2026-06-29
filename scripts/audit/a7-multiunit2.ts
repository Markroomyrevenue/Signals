import { readFileSync } from "node:fs";
import { prisma } from "./lib/ctx";
import { buildSalesReport } from "@/lib/reports/service";

const SCRATCH = "/private/tmp/claude-501/-Users-markmccracken-Documents-signals/2fb77a7b-d5a9-4f51-b197-f092c4606a27/scratchpad/a7";
const TENANT = "cmoeuax4x000ery6qv2emihce";
const NON_BOOKED = new Set(["cancelled","canceled","no-show","no_show","declined","expired","inquiry","inquirypreapproved","inquirynotpossible"]);
function parseUTC(s: string): Date { return new Date(`${s.slice(0,10)}T00:00:00Z`); }
function nightsInMonth(a: string, d: string, from: string, to: string): number {
  const lo=parseUTC(from),hi=parseUTC(to),dep=parseUTC(d); let n=0;
  for (let c=parseUTC(a); c<dep; c.setUTCDate(c.getUTCDate()+1)) if (c>=lo&&c<=hi) n+=1;
  return n;
}
async function main() {
  const cache = JSON.parse(readFileSync(`${SCRATCH}/resv-${TENANT}.json`, "utf8"));
  const reservations: any[] = cache.reservations;
  const targets = [
    { hwId: "515526", name: "Studio Apartment at The Edge (uc=100)" },
    { hwId: "514009", name: "Alma Place Short Stays (uc=20)" }
  ];
  // Use a window that definitely has activity. Try Mar-2026 then a full trailing year.
  for (const t of targets) {
    const l = await prisma.listing.findFirst({ where: { tenantId: TENANT, hostawayId: t.hwId }, select: { id: true, unitCount: true } });
    if (!l) continue;
    for (const win of [["2026-03-01","2026-03-31"],["2025-07-01","2026-06-29"]] as [string,string][]) {
      const [from,to]=win;
      let hwN=0,hwR=0;
      for (const r of reservations) {
        if (String(r.listingMapId)!==t.hwId) continue;
        if (NON_BOOKED.has((r.status??"").toLowerCase())) continue;
        const computed=Math.max(0,Math.round((parseUTC(r.departureDate).getTime()-parseUTC(r.arrivalDate).getTime())/86400000));
        if (computed<=0) continue;
        const los=r.nights>0?r.nights:computed;
        const nm=nightsInMonth(r.arrivalDate,r.departureDate,from,to);
        if (nm>0){hwN+=nm;hwR+=(Number(r.totalPrice)||0)/los*nm;}
      }
      const db = await prisma.$queryRawUnsafe<any[]>(
        `SELECT COUNT(*)::int AS nights, COALESCE(SUM(CASE WHEN COALESCE(nf.los_nights,0)>0 AND COALESCE(r.total,0)>0 THEN COALESCE(r.total,0)/nf.los_nights ELSE COALESCE(nf.revenue_allocated,0) END),0)::float AS revenue
         FROM night_facts nf LEFT JOIN reservations r ON r.id=nf.reservation_id
         WHERE nf.tenant_id=$1 AND nf.listing_id=$2 AND nf.is_occupied=true AND nf.date>=$3::date AND nf.date<=$4::date`,
        TENANT, l.id, from, to);
      const report = await buildSalesReport({ tenantId: TENANT, request: { stayDateFrom: from, stayDateTo: to, granularity:"month", listingIds:[l.id], channels:[], statuses:[], includeFees:true, includeVat:true, barMetric:"revenue", compareMode:"yoy_otb" } as any, displayCurrency:"GBP" });
      const repN=report.current.nights.reduce((a:number,b:number)=>a+b,0);
      const repR=report.current.revenue.reduce((a:number,b:number)=>a+b,0);
      const repInv=report.current.inventory.reduce((a:number,b:number)=>a+b,0);
      console.log(`\n${t.name}  window ${from}..${to}`);
      console.log(`  HW-truth : nights=${hwN} rev=${hwR.toFixed(2)}`);
      console.log(`  DB nf    : nights=${db[0].nights} rev=${Number(db[0].revenue).toFixed(2)}`);
      console.log(`  Report   : nights=${repN} rev=${repR.toFixed(2)} inventory=${repInv} occ%=${repInv>0?(repN/repInv*100).toFixed(1):"-"}`);
      console.log(`  DELTA report-HW: nights ${repN-hwN}, rev ${(repR-hwR).toFixed(2)}`);
    }
  }
  await prisma.$disconnect();
}
main().catch((e)=>{console.error("FATAL",e);process.exit(1);});
