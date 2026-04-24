#!/usr/bin/env node
/**
 * List every login that exists for the current tenant.
 *
 * Usage:  npm run user:list
 *
 * Handy when you're about to add a staff member and want to double-check
 * who already has access.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function resolveTenantId(): string {
  return (
    process.env.SEED_TENANT_ID?.trim() ||
    process.env.SAMPLE_TENANT_ID?.trim() ||
    "tenant_demo"
  );
}

async function main(): Promise<void> {
  const tenantId = resolveTenantId();
  const users = await prisma.user.findMany({
    where: { tenantId },
    orderBy: [{ role: "asc" }, { email: "asc" }],
    select: {
      email: true,
      role: true,
      displayName: true,
      lastLoginAt: true,
      createdAt: true
    }
  });

  if (users.length === 0) {
    console.log(`No users yet for tenant "${tenantId}".`);
    return;
  }

  console.log(`\nUsers for tenant "${tenantId}":\n`);
  const rows = users.map((user) => ({
    Email: user.email,
    Role: user.role,
    Name: user.displayName ?? "-",
    "Last login": user.lastLoginAt ? user.lastLoginAt.toISOString() : "never",
    Created: user.createdAt.toISOString()
  }));
  console.table(rows);
}

main()
  .catch((error) => {
    console.error("Failed to list users:", error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
