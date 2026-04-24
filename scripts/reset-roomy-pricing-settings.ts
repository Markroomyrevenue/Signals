import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { prisma } from "../src/lib/prisma";

type TenantSummary = {
  tenantId: string;
  tenantName: string;
  rows: number;
};

async function main(): Promise<void> {
  const rows = await prisma.pricingSetting.findMany({
    include: {
      tenant: {
        select: {
          id: true,
          name: true
        }
      }
    },
    orderBy: [{ tenantId: "asc" }, { scope: "asc" }, { scopeRef: "asc" }]
  });

  const backupDir = path.resolve(process.cwd(), ".codex-temp");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `roomy-pricing-settings-backup-${timestamp}.json`);

  await mkdir(backupDir, { recursive: true });
  await writeFile(
    backupPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        rowCount: rows.length,
        rows: rows.map((row) => ({
          id: row.id,
          tenantId: row.tenantId,
          tenantName: row.tenant.name,
          scope: row.scope,
          scopeRef: row.scopeRef,
          settings: row.settings,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString()
        }))
      },
      null,
      2
    )}\n`
  );

  const deleted = await prisma.pricingSetting.deleteMany();
  const remaining = await prisma.pricingSetting.count();
  const tenantSummaries = rows.reduce<Map<string, TenantSummary>>((summaryByTenant, row) => {
    const current = summaryByTenant.get(row.tenantId) ?? {
      tenantId: row.tenantId,
      tenantName: row.tenant.name,
      rows: 0
    };
    current.rows += 1;
    summaryByTenant.set(row.tenantId, current);
    return summaryByTenant;
  }, new Map<string, TenantSummary>());

  console.log("Backed up pricing settings to:", backupPath);
  console.log(
    "Reset pricing settings by tenant:",
    JSON.stringify(Array.from(tenantSummaries.values()), null, 2)
  );
  console.log(
    "Reset complete:",
    JSON.stringify(
      {
        deletedRows: deleted.count,
        remainingRows: remaining
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
