import { prisma } from "@/lib/prisma";

type RepairResult = {
  id: string;
  tenantId: string;
  role: string;
  displayName: string | null;
};

/**
 * Older client creation copied the owner into the new tenant without carrying
 * the admin role across. If we find a matching admin membership with the same
 * email + password hash in another tenant, we can safely promote this clone.
 */
export async function maybePromoteClonedOwnerMembership(userId: string): Promise<RepairResult | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      tenantId: true,
      email: true,
      role: true,
      passwordHash: true,
      displayName: true
    }
  });

  if (!user) return null;
  if (user.role === "admin") {
    return {
      id: user.id,
      tenantId: user.tenantId,
      role: user.role,
      displayName: user.displayName
    };
  }

  const matchingAdmin = await prisma.user.findFirst({
    where: {
      email: user.email,
      role: "admin",
      passwordHash: user.passwordHash,
      NOT: { id: user.id }
    },
    orderBy: { createdAt: "asc" },
    select: {
      displayName: true
    }
  });

  if (!matchingAdmin) {
    return {
      id: user.id,
      tenantId: user.tenantId,
      role: user.role,
      displayName: user.displayName
    };
  }

  const repaired = await prisma.user.update({
    where: { id: user.id },
    data: {
      role: "admin",
      displayName: user.displayName ?? matchingAdmin.displayName
    },
    select: {
      id: true,
      tenantId: true,
      role: true,
      displayName: true
    }
  });

  return repaired;
}
