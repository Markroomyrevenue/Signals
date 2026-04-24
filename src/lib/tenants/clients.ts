import { prisma } from "@/lib/prisma";

export type TenantClientOption = {
  id: string;
  name: string;
  hostawayAccountId: string | null;
  membershipRole: "admin" | "viewer";
  canManage: boolean;
};

export async function listClientsForUserEmail(email: string): Promise<TenantClientOption[]> {
  const users = await prisma.user.findMany({
    where: {
      email: email.toLowerCase().trim()
    },
    select: {
      role: true,
      tenantId: true,
      tenant: {
        select: {
          id: true,
          name: true,
          hostaway: {
            select: {
              hostawayAccountId: true
            }
          }
        }
      }
    }
  });

  const seen = new Set<string>();
  const clientsRaw = users
    .map(
      (row) =>
        ({
          id: row.tenant.id,
          name: row.tenant.name,
          hostawayAccountId: row.tenant.hostaway?.hostawayAccountId ?? null,
          membershipRole: row.role === "admin" ? "admin" : "viewer",
          canManage: row.role === "admin"
        }) satisfies TenantClientOption
    )
    .filter((client) => {
      if (seen.has(client.id)) return false;
      seen.add(client.id);
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return clientsRaw;
}
