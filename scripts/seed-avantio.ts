/**
 * Onboards an Avantio sandbox (or production) tenant.
 *
 * Reads:
 *   AVANTIO_TENANT_ID         — Signals Tenant.id to upsert (e.g. "avantio-demo")
 *   AVANTIO_TENANT_NAME       — display name (default "Avantio Demo")
 *   AVANTIO_ADMIN_EMAIL       — admin user email
 *   AVANTIO_ADMIN_PASSWORD    — admin password (created on first run only)
 *   AVANTIO_API_KEY           — X-Avantio-Auth value
 *   AVANTIO_DEFAULT_CURRENCY  — default "EUR"
 *   AVANTIO_BASE_URL          — default "https://api.avantio.pro/pms"
 *
 * On success prints the Avantio company name (so it's obvious whether the
 * key matches the expected sandbox / production account).
 *
 * Tenant-isolated by construction: every Prisma upsert is keyed by the
 * tenantId from env. Re-runs are idempotent.
 */

import "dotenv/config";

import { prisma } from "../src/lib/prisma";
import { hashPassword } from "../src/lib/password";
import { encryptText } from "../src/lib/crypto";
import { createAvantioClient } from "../src/lib/avantio/client";

const DEFAULT_BASE_URL = "https://api.avantio.pro/pms";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required (set it in .env.local)`);
  return value;
}

async function main(): Promise<void> {
  const tenantId = requireEnv("AVANTIO_TENANT_ID");
  const tenantName = process.env.AVANTIO_TENANT_NAME?.trim() || "Avantio Demo";
  const adminEmail = (process.env.AVANTIO_ADMIN_EMAIL ?? "").trim().toLowerCase();
  const adminPassword = process.env.AVANTIO_ADMIN_PASSWORD ?? "";
  if (!adminEmail) throw new Error("AVANTIO_ADMIN_EMAIL is required");
  if (!adminPassword) throw new Error("AVANTIO_ADMIN_PASSWORD is required");
  const apiKey = requireEnv("AVANTIO_API_KEY");
  const defaultCurrency = process.env.AVANTIO_DEFAULT_CURRENCY?.trim() || "EUR";
  const baseUrl = process.env.AVANTIO_BASE_URL?.trim() || DEFAULT_BASE_URL;
  const timezone = process.env.DEFAULT_TIMEZONE?.trim() || "Europe/London";

  // 1. Upsert tenant with pmsType = "AVANTIO" so the PMS router resolves
  //    its gateway to Avantio on every sync.
  const tenant = await prisma.tenant.upsert({
    where: { id: tenantId },
    update: {
      name: tenantName,
      defaultCurrency,
      timezone,
      pmsType: "AVANTIO"
    },
    create: {
      id: tenantId,
      name: tenantName,
      defaultCurrency,
      timezone,
      pmsType: "AVANTIO"
    }
  });

  // 2. Admin user — created on first run, password unchanged on re-runs
  //    so the seed never silently rotates a real operator's credentials.
  const existingUser = await prisma.user.findUnique({
    where: { tenantId_email: { tenantId: tenant.id, email: adminEmail } }
  });
  if (!existingUser) {
    const passwordHash = await hashPassword(adminPassword);
    await prisma.user.create({
      data: { tenantId: tenant.id, email: adminEmail, passwordHash, role: "admin" }
    });
    console.log(`Created admin user ${adminEmail} on tenant ${tenant.id}`);
  } else {
    console.log(`Admin user ${adminEmail} already exists — password left unchanged`);
  }

  // 3. AvantioConnection — encrypted key + base URL. Re-runs replace
  //    both (rotating a key is just a re-seed).
  const apiKeyEncrypted = encryptText(apiKey);
  await prisma.avantioConnection.upsert({
    where: { tenantId: tenant.id },
    update: { apiKeyEncrypted, baseUrl, status: "active" },
    create: { tenantId: tenant.id, apiKeyEncrypted, baseUrl, status: "active" }
  });

  // 4. Probe whoami so we know the key actually works AND we capture the
  //    company id for support/debugging. Failing here is the right
  //    failure mode — better to fail seeding than to leave the operator
  //    with a tenant that 401s on the first sync.
  const client = createAvantioClient({ baseUrl, apiKey });
  const whoami = await client.whoami();
  const company = whoami?.data?.company ?? null;
  const companyId =
    company && (typeof company.id === "string" || typeof company.id === "number") ? String(company.id) : null;
  const companyName = typeof company?.name === "string" ? company.name : null;

  if (companyId) {
    await prisma.avantioConnection.update({
      where: { tenantId: tenant.id },
      data: { companyId }
    });
  }

  console.log("Seed complete", {
    tenantId: tenant.id,
    pmsType: "AVANTIO",
    avantioCompanyId: companyId,
    avantioCompanyName: companyName,
    avantioBaseUrl: baseUrl
  });
}

main()
  .catch((error) => {
    console.error("[seed-avantio] failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
