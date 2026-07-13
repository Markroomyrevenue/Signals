/**
 * The single provisioning path for new clients, shared by the Add-Client
 * API route and scripts/provision-client.ts — validation and tenant
 * creation behave identically whether a client is added through the UI
 * or from the ops CLI.
 *
 * Order per PMS: uniqueness guard → server-side credential validation →
 * one transaction creating Tenant (with pmsType) + admin user clone +
 * connection row (credentials encrypted). For Guesty the validation
 * token is PERSISTED as the cached working token after the transaction
 * (five-tokens-per-24h quota — never validate-then-discard).
 */

import type { Prisma } from "@prisma/client";

import { encryptText } from "@/lib/crypto";
import { persistGuestyToken } from "@/lib/guesty/token";
import {
  assertUniqueHostawayConnection,
  validateHostawayCredentials
} from "@/lib/hostaway/hardening";
import {
  assertUniqueAvantioConnection,
  assertUniqueGuestyConnection,
  validateAvantioCredentials,
  validateGuestyCredentials
} from "@/lib/pms/hardening";
import { prisma } from "@/lib/prisma";

export const DEFAULT_AVANTIO_BASE_URL = "https://api.avantio.pro/pms";

export type ProvisionSourceUser = {
  email: string;
  passwordHash: string;
  role: string;
  displayName: string | null;
};

type ProvisionBase = {
  clientName: string;
  defaultCurrency: string;
  timezone: string;
  sourceUser: ProvisionSourceUser;
};

export type ProvisionClientInput =
  | (ProvisionBase & { pms: "hostaway"; apiKey: string; apiPin: string; accountPin?: string | null })
  | (ProvisionBase & { pms: "guesty"; guestyClientId: string; guestyClientSecret: string })
  | (ProvisionBase & { pms: "avantio"; avantioApiKey: string; avantioBaseUrl?: string });

async function createTenantWithUser(
  input: ProvisionBase,
  pmsType: "HOSTAWAY" | "GUESTY" | "AVANTIO",
  createConnection: (tx: Prisma.TransactionClient, tenantId: string) => Promise<void>
): Promise<{ id: string; name: string }> {
  return prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({
      data: {
        name: input.clientName,
        defaultCurrency: input.defaultCurrency,
        timezone: input.timezone,
        pmsType
      },
      select: { id: true, name: true }
    });

    await tx.user.create({
      data: {
        tenantId: tenant.id,
        email: input.sourceUser.email,
        passwordHash: input.sourceUser.passwordHash,
        role: input.sourceUser.role,
        displayName: input.sourceUser.displayName
      }
    });

    await createConnection(tx, tenant.id);
    return tenant;
  });
}

export async function validateAndProvisionClient(
  input: ProvisionClientInput
): Promise<{ id: string; name: string }> {
  if (input.pms === "guesty") {
    await assertUniqueGuestyConnection(input.guestyClientId);

    // ONE token fetch validates the pair AND becomes the cached working token.
    const issuedToken = await validateGuestyCredentials(input.guestyClientId, input.guestyClientSecret);

    const tenant = await createTenantWithUser(input, "GUESTY", async (tx, tenantId) => {
      await tx.guestyConnection.create({
        data: {
          tenantId,
          status: "active",
          clientIdEncrypted: encryptText(input.guestyClientId.trim()),
          clientSecretEncrypted: encryptText(input.guestyClientSecret.trim())
        }
      });
    });

    await persistGuestyToken(tenant.id, issuedToken.accessToken, issuedToken.expiresIn);
    return tenant;
  }

  if (input.pms === "avantio") {
    const baseUrl = input.avantioBaseUrl?.trim() || DEFAULT_AVANTIO_BASE_URL;
    await assertUniqueAvantioConnection(input.avantioApiKey);

    const companyName = await validateAvantioCredentials(input.avantioApiKey, baseUrl);
    console.log("[provision] Avantio credentials validated", {
      clientName: input.clientName,
      companyName
    });

    return createTenantWithUser(input, "AVANTIO", async (tx, tenantId) => {
      await tx.avantioConnection.create({
        data: {
          tenantId,
          status: "active",
          apiKeyEncrypted: encryptText(input.avantioApiKey.trim()),
          baseUrl
        }
      });
    });
  }

  await assertUniqueHostawayConnection({
    hostawayClientId: input.apiKey,
    hostawayAccountId: input.accountPin
  });

  await validateHostawayCredentials({
    hostawayClientId: input.apiKey,
    hostawayClientSecret: input.apiPin,
    hostawayAccountId: input.accountPin
  });

  return createTenantWithUser(input, "HOSTAWAY", async (tx, tenantId) => {
    await tx.hostawayConnection.create({
      data: {
        tenantId,
        status: "active",
        hostawayClientId: input.apiKey,
        hostawayClientSecretEncrypted: encryptText(input.apiPin),
        hostawayAccountId: input.accountPin?.trim() || null,
        hostawayAccessTokenEncrypted: null,
        hostawayAccessTokenExpiresAt: null
      }
    });
  });
}
