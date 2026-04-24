import { listClientsForUserEmail, type TenantClientOption } from "@/lib/tenants/clients";
import { prisma } from "@/lib/prisma";

export type TeamManagedClientOption = TenantClientOption;

export type TeamAccessClientMembership = {
  id: string;
  name: string;
  role: "admin" | "viewer";
};

export type TeamAccessUser = {
  email: string;
  role: "admin" | "viewer" | "mixed";
  displayName: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  clients: TeamAccessClientMembership[];
};

export async function listManageableClientsForUserEmail(email: string): Promise<TeamManagedClientOption[]> {
  const clients = await listClientsForUserEmail(email);
  return clients.filter((client) => client.canManage);
}

export async function listTeamUsersForManagerEmail(email: string): Promise<TeamAccessUser[]> {
  const manageableClients = await listManageableClientsForUserEmail(email);
  if (manageableClients.length === 0) return [];

  const users = await prisma.user.findMany({
    where: {
      tenantId: { in: manageableClients.map((client) => client.id) }
    },
    select: {
      email: true,
      role: true,
      displayName: true,
      lastLoginAt: true,
      createdAt: true,
      tenantId: true,
      tenant: {
        select: {
          name: true
        }
      }
    }
  });

  const byEmail = new Map<string, TeamAccessUser>();
  const clientNameById = new Map(manageableClients.map((client) => [client.id, client.name]));

  for (const user of users) {
    const emailKey = user.email.toLowerCase().trim();
    const existing = byEmail.get(emailKey);
    const membershipRole = user.role === "admin" ? "admin" : "viewer";
    const membership = {
      id: user.tenantId,
      name: clientNameById.get(user.tenantId) ?? user.tenant.name,
      role: membershipRole
    } satisfies TeamAccessClientMembership;

    if (!existing) {
      byEmail.set(emailKey, {
        email: emailKey,
        role: membershipRole,
        displayName: user.displayName ?? null,
        lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
        createdAt: user.createdAt.toISOString(),
        clients: [membership]
      });
      continue;
    }

    existing.clients.push(membership);
    if (existing.displayName === null && user.displayName) {
      existing.displayName = user.displayName;
    }

    if (existing.role !== membershipRole) {
      existing.role = "mixed";
    }

    const existingLastLogin = existing.lastLoginAt ? Date.parse(existing.lastLoginAt) : 0;
    const candidateLastLogin = user.lastLoginAt ? user.lastLoginAt.getTime() : 0;
    if (candidateLastLogin > existingLastLogin) {
      existing.lastLoginAt = user.lastLoginAt?.toISOString() ?? null;
    }

    if (user.createdAt.getTime() < Date.parse(existing.createdAt)) {
      existing.createdAt = user.createdAt.toISOString();
    }
  }

  return [...byEmail.values()]
    .map((user) => ({
      ...user,
      clients: [...user.clients].sort((left, right) => left.name.localeCompare(right.name, "en-GB", { sensitivity: "base" }))
    }))
    .sort((left, right) => {
      const roleRank = (value: TeamAccessUser["role"]) => (value === "admin" ? 0 : value === "mixed" ? 1 : 2);
      return roleRank(left.role) - roleRank(right.role) || left.email.localeCompare(right.email, "en-GB", { sensitivity: "base" });
    });
}
