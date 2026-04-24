import { decryptText, encryptText } from "@/lib/crypto";
import { env } from "@/lib/env";
import { createHostawayClient } from "@/lib/hostaway/client";
import { createDemoHostawayGateway } from "@/lib/hostaway/demo";
import { createSampleHostawayGateway } from "@/lib/hostaway/sample";
import { HostawayGateway } from "@/lib/hostaway/types";
import { prisma } from "@/lib/prisma";

function normalizeCsvPath(rawPath: string | undefined): string {
  const value = (rawPath ?? "").trim();
  if (!value) return "";

  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  return value;
}

function getDataMode(): string {
  return env.dataMode;
}

function tokenExpired(expiresAt: Date | null): boolean {
  if (!expiresAt) return true;
  return expiresAt.getTime() <= Date.now();
}

export async function getHostawayGatewayForTenant(tenantId: string): Promise<HostawayGateway> {
  const dataMode = getDataMode();

  if (dataMode === "sample") {
    const csvPath = normalizeCsvPath(process.env.SAMPLE_CSV_PATH);
    if (!csvPath) {
      throw new Error("SAMPLE_CSV_PATH is required when DATA_MODE=sample");
    }
    return createSampleHostawayGateway({ csvPath });
  }

  if (dataMode === "demo") {
    return createDemoHostawayGateway();
  }

  if (dataMode !== "live") {
    throw new Error(`Unsupported DATA_MODE value: ${dataMode}`);
  }

  const connection = await prisma.hostawayConnection.findUnique({
    where: { tenantId },
    select: {
      hostawayClientId: true,
      hostawayClientSecretEncrypted: true,
      hostawayAccessTokenEncrypted: true,
      hostawayAccessTokenExpiresAt: true,
      hostawayAccountId: true
    }
  });

  if (!connection?.hostawayClientId) {
    throw new Error("Missing live Hostaway client credentials. Update settings before running live sync.");
  }

  if (!connection.hostawayClientSecretEncrypted) {
    throw new Error("Missing Hostaway client secret. Update settings before running live sync.");
  }

  const hostawayClientId = connection.hostawayClientId;
  const hostawayClientSecret = decryptText(connection.hostawayClientSecretEncrypted);

  const tokenStore = {
    async read() {
      const latest = await prisma.hostawayConnection.findUnique({
        where: { tenantId },
        select: {
          hostawayAccessTokenEncrypted: true,
          hostawayAccessTokenExpiresAt: true
        }
      });

      if (!latest?.hostawayAccessTokenEncrypted || !latest.hostawayAccessTokenExpiresAt) {
        return { token: null, expiresAt: null };
      }

      if (tokenExpired(latest.hostawayAccessTokenExpiresAt)) {
        return { token: null, expiresAt: null };
      }

      try {
        return {
          token: decryptText(latest.hostawayAccessTokenEncrypted),
          expiresAt: latest.hostawayAccessTokenExpiresAt
        };
      } catch {
        return { token: null, expiresAt: null };
      }
    },

    async write(token: string | null, expiresAt: Date | null) {
      await prisma.hostawayConnection.update({
        where: { tenantId },
        data: {
          hostawayAccessTokenEncrypted: token ? encryptText(token) : null,
          hostawayAccessTokenExpiresAt: expiresAt
        }
      });
    }
  };

  return createHostawayClient({
    baseUrl: env.hostawayBaseUrl,
    accountId: connection.hostawayAccountId,
    clientId: hostawayClientId,
    clientSecret: hostawayClientSecret,
    tokenStore
  });
}
