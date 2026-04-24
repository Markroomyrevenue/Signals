import { runPaceSnapshotForAllTenants } from "../src/lib/sync/pace";

async function main() {
  await runPaceSnapshotForAllTenants();
  console.log("Pace snapshot run complete");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
