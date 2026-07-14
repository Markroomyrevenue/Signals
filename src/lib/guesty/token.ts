/**
 * DB-backed Guesty token provider.
 *
 * Guesty's OAuth2 client-credentials grant issues AT MOST FIVE access
 * tokens per 24h per clientId, and a token lives 24h. The only safe
 * architecture is one shared token per connection, persisted in the
 * guesty_connections row (encrypted) so the Next.js web app and the
 * background worker reuse the same token and it survives restarts.
 *
 * Rules enforced here:
 *  - A token is fetched ONLY when there is no cached token that is still
 *    valid for at least REFRESH_MARGIN_MS (45 min) — i.e. proactive
 *    refresh close to expiry, lazy otherwise.
 *  - In-process concurrent callers share one in-flight fetch (promise
 *    lock) so a burst of requests can't multi-spend the quota.
 *  - refreshToken() (the 403 path in client.ts) re-reads the DB first:
 *    if another process already rotated the token, use theirs instead of
 *    issuing a new one.
 */

import { decryptText, encryptText } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";
import { fetchGuestyAccessToken, type GuestyTokenProvider } from "@/lib/guesty/client";

/** Refresh proactively when the cached token has less than this left. */
const REFRESH_MARGIN_MS = 45 * 60 * 1000;

type CachedToken = { token: string; expiresAt: Date };

async function readCachedToken(tenantId: string): Promise<CachedToken | null> {
  const row = await prisma.guestyConnection.findUnique({
    where: { tenantId },
    select: { accessTokenEncrypted: true, tokenExpiresAt: true }
  });
  if (!row?.accessTokenEncrypted || !row.tokenExpiresAt) return null;
  try {
    return { token: decryptText(row.accessTokenEncrypted), expiresAt: row.tokenExpiresAt };
  } catch {
    return null;
  }
}

function isFresh(cached: CachedToken | null): cached is CachedToken {
  return cached !== null && cached.expiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS;
}

async function readCredentials(tenantId: string): Promise<{ clientId: string; clientSecret: string }> {
  const row = await prisma.guestyConnection.findUnique({
    where: { tenantId },
    select: { clientIdEncrypted: true, clientSecretEncrypted: true }
  });
  if (!row?.clientIdEncrypted || !row.clientSecretEncrypted) {
    throw new Error(`guesty.token: tenant ${tenantId} GuestyConnection is missing credentials`);
  }
  try {
    return {
      clientId: decryptText(row.clientIdEncrypted),
      clientSecret: decryptText(row.clientSecretEncrypted)
    };
  } catch {
    // AES-GCM auth failure ("Unsupported state or unable to authenticate
    // data") means the row was encrypted under a DIFFERENT
    // API_ENCRYPTION_KEY than this process runs with — e.g. provisioned
    // from a laptop whose key differs from Railway's. Surface that
    // plainly instead of the cryptic node:crypto message.
    throw new Error(
      `guesty.token: tenant ${tenantId} credentials cannot be decrypted — they were encrypted ` +
        `under a different API_ENCRYPTION_KEY than this environment's. Re-save the credentials ` +
        `from this environment (or re-encrypt them with the correct key).`
    );
  }
}

/**
 * Persist a freshly-issued token on the connection row (encrypted).
 * Exported so the Add-Client credential validation can KEEP the token it
 * fetched as the cached one instead of wasting quota.
 */
export async function persistGuestyToken(
  tenantId: string,
  accessToken: string,
  expiresInSeconds: number
): Promise<void> {
  await prisma.guestyConnection.update({
    where: { tenantId },
    data: {
      accessTokenEncrypted: encryptText(accessToken),
      tokenExpiresAt: new Date(Date.now() + expiresInSeconds * 1000)
    }
  });
}

async function issueAndPersist(tenantId: string): Promise<string> {
  const creds = await readCredentials(tenantId);
  const issued = await fetchGuestyAccessToken(creds.clientId, creds.clientSecret);
  await persistGuestyToken(tenantId, issued.accessToken, issued.expiresIn);
  console.log(`[guesty.token] issued new access token for tenant ${tenantId} (quota: 5/24h per clientId)`);
  return issued.accessToken;
}

export function createDbGuestyTokenProvider(tenantId: string): GuestyTokenProvider {
  // Promise lock: concurrent in-process callers share one fetch.
  let inFlight: Promise<string> | null = null;

  async function getToken(): Promise<string> {
    const cached = await readCachedToken(tenantId);
    if (isFresh(cached)) return cached.token;
    if (!inFlight) {
      inFlight = issueAndPersist(tenantId).finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  async function refreshToken(): Promise<string> {
    // Another process may have rotated the token already — prefer theirs.
    const cached = await readCachedToken(tenantId);
    if (isFresh(cached)) return cached.token;
    if (!inFlight) {
      inFlight = issueAndPersist(tenantId).finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  return { getToken, refreshToken };
}
