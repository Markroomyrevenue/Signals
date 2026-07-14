/**
 * Provision a new client tenant from the CLI through the SAME code path
 * as the Add-Client UI (src/lib/tenants/provision.ts): uniqueness guard →
 * server-side credential validation → tenant + admin-user clone +
 * encrypted connection row. Optionally runs the first full sync
 * (core + extended → listings, reservations, night facts, calendar,
 * pace snapshot) to completion, inline.
 *
 * Credentials are read from env vars NAMED on the command line (never
 * from argv values), so no secret ever appears in shell history or logs.
 *
 * Usage:
 *   npx tsx scripts/provision-client.ts \
 *     --pms=guesty --name="Cityscape" \
 *     --client-id-env=GUEST_CLIENTID_CITYSCAPE --secret-env=GUESTY_KEY_CITYSCAPE \
 *     --admin-email=mark@roomyrevenue.com [--currency=GBP] [--timezone=Europe/London] [--sync]
 *
 *   npx tsx scripts/provision-client.ts \
 *     --pms=avantio --name="Avantio Sandbox (delete me)" \
 *     --api-key-env=AVANTIO_API_KEY --admin-email=mark@roomyrevenue.com [--sync]
 *
 * Target DB is whatever DATABASE_URL resolves to — run with
 * DATABASE_URL="$DATABASE_PUBLIC_URL" to provision against prod.
 */

import dotenv from "dotenv";

// .env first, then .env.local (dotenv never overrides already-set vars,
// and an explicit DATABASE_URL on the command line wins over both).
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local" });

import { prisma } from "../src/lib/prisma";
import { runTenantSync } from "../src/lib/sync/engine";
import { buildExtendedSyncReason } from "../src/lib/sync/stages";
import { validateAndProvisionClient, DEFAULT_AVANTIO_BASE_URL } from "../src/lib/tenants/provision";

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    if (eq === -1) {
      args[raw.slice(2)] = true;
    } else {
      args[raw.slice(2, eq)] = raw.slice(eq + 1);
    }
  }
  return args;
}

function requireString(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`--${key}=<value> is required`);
  }
  return value.trim();
}

function requireEnvByName(envName: string): string {
  const value = process.env[envName]?.trim();
  if (!value) {
    throw new Error(`env var ${envName} is empty or unset (check .env / .env.local)`);
  }
  return value;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pms = requireString(args, "pms");
  const clientName = requireString(args, "name");

  // Credentials are encrypted with API_ENCRYPTION_KEY, and the TARGET
  // environment's services must be able to decrypt them. Provisioning a
  // remote DB with a laptop's key produces rows the prod worker cannot
  // decrypt (AES-GCM "Unsupported state or unable to authenticate data" —
  // this bit us live on 2026-07-14). So when DATABASE_URL is remote,
  // require the target key to be named explicitly.
  const dbUrl = process.env.DATABASE_URL ?? "";
  const isRemoteDb = dbUrl !== "" && !/localhost|127\.0\.0\.1/.test(dbUrl);
  if (isRemoteDb) {
    const keyEnv = args["encryption-key-env"];
    if (typeof keyEnv === "string" && keyEnv.trim() !== "") {
      process.env.API_ENCRYPTION_KEY = requireEnvByName(keyEnv.trim());
    } else if (args["allow-local-key"] !== true) {
      throw new Error(
        "DATABASE_URL points at a remote host. Pass --encryption-key-env=<ENV_VAR> naming a var " +
          "that holds the TARGET environment's API_ENCRYPTION_KEY (e.g. export " +
          "PROD_API_ENCRYPTION_KEY from `railway variables` first), or --allow-local-key if the " +
          "keys are known to match."
      );
    }
  }
  const adminEmail = requireString(args, "admin-email").toLowerCase();
  const currency = typeof args.currency === "string" ? args.currency : "GBP";
  const timezone = typeof args.timezone === "string" ? args.timezone : "Europe/London";
  const runSync = args.sync === true;

  // Clone the named admin's user record into the new tenant, exactly like
  // the UI does with the calling admin.
  const sourceUser = await prisma.user.findFirst({
    where: { email: adminEmail, role: "admin" },
    orderBy: { createdAt: "desc" },
    select: { email: true, passwordHash: true, role: true, displayName: true }
  });
  if (!sourceUser) {
    throw new Error(`No admin user found with email ${adminEmail} in the target DB`);
  }

  let tenant: { id: string; name: string };
  if (pms === "guesty") {
    const clientId = requireEnvByName(requireString(args, "client-id-env"));
    const clientSecret = requireEnvByName(requireString(args, "secret-env"));
    tenant = await validateAndProvisionClient({
      pms: "guesty",
      clientName,
      guestyClientId: clientId,
      guestyClientSecret: clientSecret,
      defaultCurrency: currency,
      timezone,
      sourceUser
    });
  } else if (pms === "avantio") {
    const apiKey = requireEnvByName(requireString(args, "api-key-env"));
    const baseUrl = typeof args["base-url"] === "string" ? (args["base-url"] as string) : DEFAULT_AVANTIO_BASE_URL;
    tenant = await validateAndProvisionClient({
      pms: "avantio",
      clientName,
      avantioApiKey: apiKey,
      avantioBaseUrl: baseUrl,
      defaultCurrency: currency,
      timezone,
      sourceUser
    });
  } else if (pms === "hostaway") {
    const apiKey = requireEnvByName(requireString(args, "client-id-env"));
    const apiPin = requireEnvByName(requireString(args, "secret-env"));
    tenant = await validateAndProvisionClient({
      pms: "hostaway",
      clientName,
      apiKey,
      apiPin,
      defaultCurrency: currency,
      timezone,
      sourceUser
    });
  } else {
    throw new Error(`Unknown --pms=${pms} (expected hostaway | guesty | avantio)`);
  }

  console.log(`[provision-client] provisioned tenant "${tenant.name}" id=${tenant.id} pms=${pms}`);

  if (runSync) {
    console.log(`[provision-client] running first CORE sync (this can take a while)...`);
    const core = await runTenantSync({
      tenantId: tenant.id,
      reason: "provision_first_sync",
      forceFull: true,
      syncMode: "core",
      queueExtendedAfter: false // extended runs inline below, no worker needed
    });
    console.log(
      `[provision-client] core sync complete: listings=${core.listingsSynced} reservations=${core.reservationsSynced}`
    );

    console.log(`[provision-client] running EXTENDED sync (calendar + pace snapshot)...`);
    const extended = await runTenantSync({
      tenantId: tenant.id,
      reason: buildExtendedSyncReason("provision_first_sync"),
      syncMode: "extended"
    });
    console.log(
      `[provision-client] extended sync complete: calendarListings=${extended.calendarListingsSynced}`
    );
  }

  await prisma.$disconnect();
}

// Importing the sync engine pulls in the BullMQ queues, whose Redis
// connections keep the event loop alive after main() returns — exit
// explicitly so the process doesn't hang forever once the work is done.
void main()
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error("[provision-client] FAILED:", error instanceof Error ? error.message : error);
    await prisma.$disconnect();
    process.exit(1);
  });
