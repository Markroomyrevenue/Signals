import { getHostawayGatewayForTenant } from "@/lib/hostaway";
import { prisma } from "@/lib/prisma";

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function isPlaceholderTenantName(name: string): boolean {
  const normalized = normalizeName(name).toLowerCase();
  if (!normalized) return true;
  if (normalized.includes("demo")) return true;
  if (/^account\s+\d+$/.test(normalized)) return true;
  if (normalized === "property manager") return true;
  if (normalized.endsWith("property manager")) return true;

  return (
    normalized === "demo" ||
    normalized === "demo tenant" ||
    normalized === "tenant demo" ||
    normalized === "client" ||
    normalized.startsWith("tenant_") ||
    normalized.startsWith("tenant ")
  );
}

function fallbackLabel(currentName: string, hostawayAccountId: string | null): string {
  const normalized = normalizeName(currentName);
  if (normalized && !isPlaceholderTenantName(normalized)) {
    return normalized;
  }
  if (hostawayAccountId) {
    return `Account ${hostawayAccountId}`;
  }
  return "Client";
}

export async function resolveTenantDisplayName(params: {
  tenantId: string;
  currentName: string;
  hostawayAccountId: string | null;
}): Promise<string> {
  const fallback = fallbackLabel(params.currentName, params.hostawayAccountId);
  if (!isPlaceholderTenantName(params.currentName)) {
    return fallback;
  }

  try {
    const gateway = await getHostawayGatewayForTenant(params.tenantId);
    if (typeof gateway.fetchAccountName !== "function") {
      return fallback;
    }

    const apiName = await gateway.fetchAccountName();
    const normalizedApiName = normalizeName(apiName ?? "");
    if (!normalizedApiName || isPlaceholderTenantName(normalizedApiName)) {
      return fallback;
    }

    if (normalizeName(params.currentName) !== normalizedApiName) {
      await prisma.tenant
        .update({
          where: { id: params.tenantId },
          data: { name: normalizedApiName }
        })
        .catch(() => undefined);
    }

    return normalizedApiName;
  } catch {
    return fallback;
  }
}
