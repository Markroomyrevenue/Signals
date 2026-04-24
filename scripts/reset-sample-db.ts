import { prisma } from "../src/lib/prisma";

async function main(): Promise<void> {
  const nodeEnv = (process.env.NODE_ENV ?? "development").toLowerCase();
  if (nodeEnv === "production") {
    throw new Error("Refusing to reset sample data when NODE_ENV=production");
  }

  const [nightFacts, paceSnapshots, calendarRates, dailyAggs, reservations, listings, syncRuns] = await prisma.$transaction([
    prisma.nightFact.deleteMany(),
    prisma.paceSnapshot.deleteMany(),
    prisma.calendarRate.deleteMany(),
    prisma.dailyAgg.deleteMany(),
    prisma.reservation.deleteMany(),
    prisma.listing.deleteMany(),
    prisma.syncRun.deleteMany()
  ]);

  console.log("Sample data reset complete", {
    nightFacts: nightFacts.count,
    paceSnapshots: paceSnapshots.count,
    calendarRates: calendarRates.count,
    dailyAggs: dailyAggs.count,
    reservations: reservations.count,
    listings: listings.count,
    syncRuns: syncRuns.count
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
