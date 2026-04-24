#!/usr/bin/env node
/**
 * Create (or update) a login for Signals.
 *
 * Usage:
 *   npm run user:create -- <email> <password> [role] [displayName]
 *
 * Examples:
 *   npm run user:create -- sam@roomyrevenue.com "TempPass123!" viewer "Sam"
 *   npm run user:create -- mark@roomyrevenue.com "NewPass!" admin "Mark"
 *
 * Rules:
 * - role must be either "admin" or "viewer". Defaults to "viewer" (reporting-only staff).
 * - If the email already exists for the tenant, the password, role, and
 *   display name are updated in place (i.e. this doubles as a reset).
 * - The tenant is chosen from SEED_TENANT_ID (or SAMPLE_TENANT_ID, then
 *   "tenant_demo"), so this works out of the box after setup:live.
 */

import { PrismaClient } from "@prisma/client";

import { hashPassword } from "../src/lib/password";

const prisma = new PrismaClient();

function usage(): never {
  console.error("Usage: npm run user:create -- <email> <password> [admin|viewer] [displayName]");
  process.exit(1);
}

function resolveTenantId(): string {
  return (
    process.env.SEED_TENANT_ID?.trim() ||
    process.env.SAMPLE_TENANT_ID?.trim() ||
    "tenant_demo"
  );
}

async function main(): Promise<void> {
  const [, , rawEmail, rawPassword, rawRole = "viewer", rawDisplayName] = process.argv;

  if (!rawEmail || !rawPassword) usage();

  const email = rawEmail.trim().toLowerCase();
  const role = rawRole === "admin" ? "admin" : rawRole === "viewer" ? "viewer" : null;

  if (!role) {
    console.error(`Invalid role "${rawRole}". Must be "admin" or "viewer".`);
    process.exit(1);
  }

  if (rawPassword.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  const tenantId = resolveTenantId();
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) {
    console.error(`Tenant "${tenantId}" not found. Run "npm run db:seed" first.`);
    process.exit(1);
  }

  const passwordHash = await hashPassword(rawPassword);
  const displayName = rawDisplayName?.trim() || null;

  const user = await prisma.user.upsert({
    where: {
      tenantId_email: { tenantId, email }
    },
    update: {
      passwordHash,
      role,
      displayName
    },
    create: {
      tenantId,
      email,
      passwordHash,
      role,
      displayName
    },
    select: { id: true, email: true, role: true, displayName: true }
  });

  console.log("");
  console.log("User saved:");
  console.log(`  tenant:       ${tenantId}`);
  console.log(`  email:        ${user.email}`);
  console.log(`  role:         ${user.role}`);
  console.log(`  displayName:  ${user.displayName ?? "(none)"}`);
  console.log("");
  console.log(`They can now log in at /login with the password you set.`);
}

main()
  .catch((error) => {
    console.error("Failed to create user:", error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
