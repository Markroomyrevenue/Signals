#!/usr/bin/env node

import { execSync } from "node:child_process";

import { PrismaClient } from "@prisma/client";

import { encryptText } from "../src/lib/crypto";
import { env } from "../src/lib/env";

const prisma = new PrismaClient();

type ExitCode = 0 | 1;

function run(cmd: string): void {
  console.log(`\n> ${cmd}`);
  execSync(cmd, {
    stdio: "inherit",
    shell: "/bin/sh"
  });
}

function asRequiredEnv(value: string | undefined): string | null {
  const normalized = value?.trim() ?? "";
  if (!normalized) return null;
  if (normalized.includes("[")) return null;
  return normalized;
}

function resolveSeedTenantId(): string {
  const fromSeedTenantId = process.env.SEED_TENANT_ID?.trim();
  if (fromSeedTenantId) return fromSeedTenantId;

  const fromSampleTenantId = process.env.SAMPLE_TENANT_ID?.trim();
  if (fromSampleTenantId) return fromSampleTenantId;

  return "tenant_demo";
}

async function bootstrapTenantConnection(): Promise<void> {
  const tenantId = resolveSeedTenantId();
  const hostawayClientId = asRequiredEnv(process.env.HOSTAWAY_CLIENT_ID);
  const hostawayClientSecret = asRequiredEnv(process.env.HOSTAWAY_CLIENT_SECRET);
  const webhookBasicUser = asRequiredEnv(process.env.WEBHOOK_BASIC_USER);
  const webhookBasicPass = asRequiredEnv(process.env.WEBHOOK_BASIC_PASS);

  if (!hostawayClientId || !hostawayClientSecret) {
    console.log("\nSkipping Hostaway credential bootstrap: HOSTAWAY_CLIENT_ID / HOSTAWAY_CLIENT_SECRET not set.");
    return;
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) {
    console.log(`\nTenant ${tenantId} not found. Run seed first before bootstrap.`);
    return;
  }

  const updateData: {
    hostawayClientId?: string;
    hostawayClientSecretEncrypted?: string;
    hostawayAccessTokenEncrypted?: string | null;
    hostawayAccessTokenExpiresAt?: Date | null;
    webhookBasicUser?: string | null;
    webhookBasicPassEncrypted?: string | null;
  } = {
    hostawayClientId,
    hostawayClientSecretEncrypted: encryptText(hostawayClientSecret),
    hostawayAccessTokenEncrypted: null,
    hostawayAccessTokenExpiresAt: null
  };

  if (webhookBasicUser) {
    updateData.webhookBasicUser = webhookBasicUser;
  }

  if (webhookBasicPass) {
    updateData.webhookBasicPassEncrypted = encryptText(webhookBasicPass);
  }

  await prisma.hostawayConnection.upsert({
    where: { tenantId },
    create: {
      tenantId,
      status: "active",
      ...updateData
    },
    update: updateData
  });

  console.log(`\nHostaway connection bootstrapped for ${tenantId} from environment.`);
}

async function main(): Promise<ExitCode> {
  try {
    console.log("");
    console.log("========================================");
    console.log("  Signals by Roomy Revenue — Live Setup");
    console.log("========================================");
    console.log("");

    console.log("Step 1/5: Starting database and Redis...");
    run("docker compose up -d postgres redis");

    console.log("\nStep 2/5: Applying database migrations...");
    run("npm run db:deploy");

    console.log("\nStep 3/5: Generating Prisma client...");
    run("npx prisma generate");

    console.log("\nStep 4/5: Seeding default data...");
    run("npm run db:seed");

    console.log("\nStep 5/5: Setting up Hostaway credentials...");
    await bootstrapTenantConnection();

    const baseUrl = (process.env.APP_BASE_URL || env.appBaseUrl || "http://localhost:3000").replace(/\/+$/, "");
    const dataMode = env.dataMode;

    console.log("");
    console.log("========================================");
    console.log("  Setup complete!");
    console.log("========================================");
    console.log("");
    console.log("  Next steps:");
    console.log(`  1. Start the app:        npm run dev`);
    console.log(`  2. Start the worker:     npm run worker:sh`);
    console.log(`  3. Open in browser:      ${baseUrl}/login`);
    console.log(`  4. Log in with:          the SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD values from .env`);
    console.log(`  5. Click 'Run Sync' to pull your Hostaway data`);
    console.log("");
    console.log(`  Data mode: ${dataMode}`);
    console.log(`  Settings page: ${baseUrl}/dashboard/settings`);
    console.log("");

    return 0;
  } catch (error) {
    console.error("");
    console.error("========================================");
    console.error("  Setup failed!");
    console.error("========================================");
    console.error("");
    console.error("Error:", error instanceof Error ? error.message : error);
    console.error("");
    console.error("Common fixes:");
    console.error("  - Is Docker Desktop running?");
    console.error("  - Did you copy .env.example to .env?");
    console.error("  - Are your HOSTAWAY_CLIENT_ID and HOSTAWAY_CLIENT_SECRET correct?");
    console.error("");
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().then((code) => process.exit(code));
