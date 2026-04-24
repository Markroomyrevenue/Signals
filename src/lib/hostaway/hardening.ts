import { env } from "@/lib/env";
import { createHostawayClient } from "@/lib/hostaway/client";
import { prisma } from "@/lib/prisma";

export class HostawayConnectionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostawayConnectionConflictError";
  }
}

export class HostawayConnectionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostawayConnectionValidationError";
  }
}

function normalizeIdentifier(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function joinLabels(labels: string[]): string {
  if (labels.length <= 1) {
    return labels[0] ?? "connection";
  }

  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]}`;
  }

  return `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}`;
}

export async function assertUniqueHostawayConnection(params: {
  tenantIdToExclude?: string | null;
  hostawayClientId?: string | null;
  hostawayAccountId?: string | null;
}): Promise<void> {
  const hostawayClientId = normalizeIdentifier(params.hostawayClientId);
  const hostawayAccountId = normalizeIdentifier(params.hostawayAccountId);

  const orClauses: Array<Record<string, string>> = [];
  if (hostawayClientId) {
    orClauses.push({ hostawayClientId });
  }
  if (hostawayAccountId) {
    orClauses.push({ hostawayAccountId });
  }

  if (orClauses.length === 0) {
    return;
  }

  const conflict = await prisma.hostawayConnection.findFirst({
    where: {
      ...(params.tenantIdToExclude ? { tenantId: { not: params.tenantIdToExclude } } : {}),
      OR: orClauses
    },
    select: {
      hostawayClientId: true,
      hostawayAccountId: true
    }
  });

  if (!conflict) {
    return;
  }

  const duplicateFields: string[] = [];
  if (hostawayClientId && conflict.hostawayClientId === hostawayClientId) {
    duplicateFields.push("API key");
  }
  if (hostawayAccountId && conflict.hostawayAccountId === hostawayAccountId) {
    duplicateFields.push("account ID");
  }

  throw new HostawayConnectionConflictError(
    `This Hostaway ${joinLabels(duplicateFields)} is already connected to another client.`
  );
}

export async function validateHostawayCredentials(params: {
  hostawayClientId: string;
  hostawayClientSecret: string;
  hostawayAccountId?: string | null;
}): Promise<void> {
  if (env.dataMode !== "live") {
    return;
  }

  const hostawayClientId = normalizeIdentifier(params.hostawayClientId);
  const hostawayClientSecret = params.hostawayClientSecret.trim();
  const hostawayAccountId = normalizeIdentifier(params.hostawayAccountId);

  if (!hostawayClientId || !hostawayClientSecret) {
    throw new HostawayConnectionValidationError("Hostaway credentials are required.");
  }

  try {
    const gateway = createHostawayClient({
      baseUrl: env.hostawayBaseUrl,
      accountId: hostawayAccountId,
      clientId: hostawayClientId,
      clientSecret: hostawayClientSecret,
      tokenStore: {
        async read() {
          return { token: null, expiresAt: null };
        },
        async write() {
          return;
        }
      }
    });

    await gateway.fetchListings(1);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Connection test failed.";
    if (message.includes("invalid_client")) {
      throw new HostawayConnectionValidationError(
        "Hostaway rejected this Client ID / Client Secret pair. Please check those credentials and try again."
      );
    }

    throw new HostawayConnectionValidationError(
      `Connection test failed: ${message}`
    );
  }
}
