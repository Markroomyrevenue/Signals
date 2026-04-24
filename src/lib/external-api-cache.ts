import { createHash } from "crypto";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

type CacheProvider = "airroi";

type CachedValue<T> = {
  value: T;
  fetchedAt: Date;
  expiresAt: Date;
  stale: boolean;
};

type CacheFailure = {
  errorMessage: string;
  fetchedAt: Date;
  expiresAt: Date;
};

type ExternalCacheOptions<T> = {
  provider: CacheProvider;
  requestLabel: string;
  cacheKeyParts: unknown[];
  ttlMs: number;
  forceRefresh?: boolean;
  allowLiveFetch?: boolean;
  fetcher: () => Promise<T>;
};

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(",")}}`;
}

function buildCacheKey(parts: unknown[]): string {
  const signature = stableStringify(parts);
  return createHash("sha256").update(signature).digest("hex");
}

async function readCache<T>(provider: CacheProvider, cacheKey: string): Promise<{
  success: CachedValue<T> | null;
  failure: CacheFailure | null;
}> {
  const row = await prisma.externalApiCache.findUnique({
    where: {
      provider_cacheKey: {
        provider,
        cacheKey
      }
    },
    select: {
      status: true,
      payload: true,
      errorMessage: true,
      fetchedAt: true,
      expiresAt: true
    }
  });

  if (!row) {
    return { success: null, failure: null };
  }

  const stale = row.expiresAt.getTime() <= Date.now();
  if (row.status === "success") {
    return {
      success: {
        value: row.payload as T,
        fetchedAt: row.fetchedAt,
        expiresAt: row.expiresAt,
        stale
      },
      failure: null
    };
  }

  return {
    success: null,
    failure: {
      errorMessage: row.errorMessage ?? "Cached upstream error",
      fetchedAt: row.fetchedAt,
      expiresAt: row.expiresAt
    }
  };
}

async function writeSuccess(provider: CacheProvider, cacheKey: string, requestLabel: string, value: unknown, ttlMs: number): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  await prisma.externalApiCache.upsert({
    where: {
      provider_cacheKey: {
        provider,
        cacheKey
      }
    },
    create: {
      provider,
      cacheKey,
      requestLabel,
      status: "success",
      payload: value as Prisma.InputJsonValue,
      errorMessage: null,
      fetchedAt: now,
      expiresAt
    },
    update: {
      requestLabel,
      status: "success",
      payload: value as Prisma.InputJsonValue,
      errorMessage: null,
      fetchedAt: now,
      expiresAt
    }
  });
}

async function writeFailure(provider: CacheProvider, cacheKey: string, requestLabel: string, errorMessage: string, ttlMs: number): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  await prisma.externalApiCache.upsert({
    where: {
      provider_cacheKey: {
        provider,
        cacheKey
      }
    },
    create: {
      provider,
      cacheKey,
      requestLabel,
      status: "error",
      payload: Prisma.JsonNull,
      errorMessage,
      fetchedAt: now,
      expiresAt
    },
    update: {
      requestLabel,
      status: "error",
      payload: Prisma.JsonNull,
      errorMessage,
      fetchedAt: now,
      expiresAt
    }
  });
}

export async function withExternalApiCache<T>(options: ExternalCacheOptions<T>): Promise<CachedValue<T>> {
  const cacheKey = buildCacheKey(options.cacheKeyParts);
  const cached = await readCache<T>(options.provider, cacheKey);
  const allowLiveFetch = options.allowLiveFetch !== false;

  if (cached.success && !options.forceRefresh) {
    return cached.success;
  }

  if (cached.failure && !options.forceRefresh) {
    throw new Error(cached.failure.errorMessage);
  }

  if (!allowLiveFetch) {
    throw new Error(`No cached ${options.provider} data available for ${options.requestLabel}`);
  }

  try {
    const value = await options.fetcher();
    await writeSuccess(options.provider, cacheKey, options.requestLabel, value, options.ttlMs);
    return {
      value,
      fetchedAt: new Date(),
      expiresAt: new Date(Date.now() + options.ttlMs),
      stale: false
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (cached.success) {
      console.warn("[external-cache] upstream fetch failed, serving stale cached payload", {
        provider: options.provider,
        requestLabel: options.requestLabel,
        error: errorMessage,
        fetchedAt: cached.success.fetchedAt.toISOString()
      });
      return {
        ...cached.success,
        stale: true
      };
    }

    await writeFailure(options.provider, cacheKey, options.requestLabel, errorMessage, options.ttlMs);
    throw error;
  }
}
