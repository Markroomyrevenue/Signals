/**
 * Add-Client hardening for the non-Hostaway PMSes: server-side credential
 * validation BEFORE provisioning, and per-PMS uniqueness guards mirroring
 * `assertUniqueHostawayConnection`.
 *
 * Guesty quota note: `validateGuestyCredentials` spends ONE token from the
 * five-per-24h-per-clientId budget and RETURNS it — the caller must persist
 * it on the new connection row (via persistGuestyToken) so the validation
 * token becomes the cached working token instead of wasted quota.
 *
 * Uniqueness for Guesty/Avantio can't be a WHERE clause because the
 * identifiers are encrypted at rest; with a handful of connection rows we
 * decrypt-and-compare instead.
 */

import { createAvantioClient } from "@/lib/avantio/client";
import { decryptText } from "@/lib/crypto";
import { fetchGuestyAccessToken, type GuestyTokenResponse } from "@/lib/guesty/client";
import { prisma } from "@/lib/prisma";

export class PmsConnectionConflictError extends Error {}
export class PmsConnectionValidationError extends Error {}

function safeDecrypt(value: string | null): string | null {
  if (!value) return null;
  try {
    return decryptText(value);
  } catch {
    return null;
  }
}

export async function assertUniqueGuestyConnection(clientId: string): Promise<void> {
  const normalized = clientId.trim();
  if (!normalized) return;

  const connections = await prisma.guestyConnection.findMany({
    select: {
      tenantId: true,
      clientIdEncrypted: true,
      tenant: { select: { name: true } }
    }
  });

  const conflict = connections.find((row) => safeDecrypt(row.clientIdEncrypted) === normalized);
  if (!conflict) return;

  const tenantName = conflict.tenant?.name?.trim();
  throw new PmsConnectionConflictError(
    `This Guesty Client ID is${
      tenantName
        ? ` already in use by "${tenantName}". Open that client and remove it first, or contact support if you can't see it.`
        : " already connected to another client."
    }`
  );
}

/** Tenant ids whose Guesty connection uses this clientId (for orphan cleanup). */
export async function findGuestyConnectionTenantIds(clientId: string): Promise<string[]> {
  const normalized = clientId.trim();
  if (!normalized) return [];
  const connections = await prisma.guestyConnection.findMany({
    select: { tenantId: true, clientIdEncrypted: true }
  });
  return connections
    .filter((row) => safeDecrypt(row.clientIdEncrypted) === normalized)
    .map((row) => row.tenantId);
}

/**
 * ONE token fetch — both the validation and the working token. Never retried
 * here; a rejection surfaces immediately so quota isn't burned guessing.
 */
export async function validateGuestyCredentials(
  clientId: string,
  clientSecret: string
): Promise<GuestyTokenResponse> {
  const normalizedId = clientId.trim();
  const normalizedSecret = clientSecret.trim();
  if (!normalizedId || !normalizedSecret) {
    throw new PmsConnectionValidationError("Guesty Client ID and Client Secret are required.");
  }

  try {
    return await fetchGuestyAccessToken(normalizedId, normalizedSecret);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Connection test failed.";
    if (message.includes("(400)") || message.includes("(401)") || message.includes("invalid")) {
      throw new PmsConnectionValidationError(
        "Guesty rejected this Client ID / Client Secret pair. Please check those credentials and try again."
      );
    }
    throw new PmsConnectionValidationError(`Guesty connection test failed: ${message}`);
  }
}

export async function assertUniqueAvantioConnection(apiKey: string): Promise<void> {
  const normalized = apiKey.trim();
  if (!normalized) return;

  const connections = await prisma.avantioConnection.findMany({
    select: {
      tenantId: true,
      apiKeyEncrypted: true,
      tenant: { select: { name: true } }
    }
  });

  const conflict = connections.find((row) => safeDecrypt(row.apiKeyEncrypted) === normalized);
  if (!conflict) return;

  const tenantName = conflict.tenant?.name?.trim();
  throw new PmsConnectionConflictError(
    `This Avantio API key is${
      tenantName
        ? ` already in use by "${tenantName}". Open that client and remove it first, or contact support if you can't see it.`
        : " already connected to another client."
    }`
  );
}

/** Tenant ids whose Avantio connection uses this API key (for orphan cleanup). */
export async function findAvantioConnectionTenantIds(apiKey: string): Promise<string[]> {
  const normalized = apiKey.trim();
  if (!normalized) return [];
  const connections = await prisma.avantioConnection.findMany({
    select: { tenantId: true, apiKeyEncrypted: true }
  });
  return connections
    .filter((row) => safeDecrypt(row.apiKeyEncrypted) === normalized)
    .map((row) => row.tenantId);
}

/**
 * One cheap authenticated GET (whoami). Returns the Avantio company name so
 * the operator can confirm the key matches the expected account.
 */
export async function validateAvantioCredentials(apiKey: string, baseUrl: string): Promise<string | null> {
  const normalized = apiKey.trim();
  if (!normalized) {
    throw new PmsConnectionValidationError("Avantio API key is required.");
  }

  try {
    const client = createAvantioClient({ baseUrl, apiKey: normalized });
    const response = await client.whoami();
    const company = response?.data?.company;
    return typeof company?.name === "string" ? company.name : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Connection test failed.";
    if (message.includes("(401)") || message.includes("(403)")) {
      throw new PmsConnectionValidationError(
        "Avantio rejected this API key. Please check the key and try again."
      );
    }
    throw new PmsConnectionValidationError(`Avantio connection test failed: ${message}`);
  }
}
