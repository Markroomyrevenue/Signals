/**
 * Shared, read-only HTTP helper for the engine adapters.
 *
 * - Auth header is set per engine (`X-API-Key` / `X-Integration-Api-Key`); the
 *   key value is NEVER logged. Any error string is run through `redactSecrets`
 *   so an upstream message that echoes the URL/header cannot leak it.
 * - Retries on 429 + 5xx with exponential backoff + jitter (Wheelhouse caps at
 *   20 req/min). 4xx other than 429 fail fast (e.g. 401 invalid key → dormant).
 * - GET/HEAD/OPTIONS and non-mutating POST only. No PUT/DELETE is ever issued —
 *   the whole observation phase is read-only (spec §0, §9).
 */

import { redactSecrets } from "@/lib/observe/secrets";

export type EngineHttpMethod = "GET" | "POST";

export class EngineHttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "EngineHttpError";
    this.status = status;
  }
}

export type EngineFetchArgs = {
  url: string;
  method?: EngineHttpMethod;
  headerName: string;
  apiKey: string;
  body?: unknown;
  /** Max attempts including the first. Default 4. */
  maxAttempts?: number;
  /** Base backoff in ms (doubles each retry). Default 1500. */
  baseDelayMs?: number;
  /** Per-request timeout in ms. Default 30000. */
  timeoutMs?: number;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to a real timer. */
  sleepImpl?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with full jitter, given the attempt index (0-based). */
export function backoffDelayMs(attempt: number, baseDelayMs: number): number {
  const ceiling = baseDelayMs * Math.pow(2, attempt);
  return Math.round(Math.random() * ceiling);
}

/**
 * Perform one read-only JSON request against an engine, with key-safe errors and
 * backoff retries. Throws `EngineHttpError` (status attached) with the key
 * redacted from the message.
 */
export async function engineFetchJson<T = unknown>(args: EngineFetchArgs): Promise<T> {
  const {
    url,
    method = "GET",
    headerName,
    apiKey,
    body,
    maxAttempts = 4,
    baseDelayMs = 1500,
    timeoutMs = 30000,
    fetchImpl = fetch,
    sleepImpl = defaultSleep
  } = args;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method,
        headers: {
          [headerName]: apiKey,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {})
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });

      if (response.ok) {
        return (await response.json()) as T;
      }

      // Retry only on rate-limit + transient server errors.
      const retryable = response.status === 429 || response.status >= 500;
      const detail = redactSecrets(await safeText(response), [apiKey]);
      const err = new EngineHttpError(
        `HTTP ${response.status} from engine: ${detail.slice(0, 300)}`,
        response.status
      );
      if (!retryable || attempt === maxAttempts - 1) throw err;
      lastError = err;
    } catch (error) {
      if (error instanceof EngineHttpError && (error.status < 500 && error.status !== 429)) {
        throw error; // non-retryable status already decided above
      }
      const message = redactSecrets(error instanceof Error ? error.message : String(error), [apiKey]);
      lastError = error instanceof EngineHttpError ? error : new Error(message);
      if (attempt === maxAttempts - 1) {
        throw lastError;
      }
    } finally {
      clearTimeout(timer);
    }

    await sleepImpl(backoffDelayMs(attempt, baseDelayMs));
  }

  throw lastError ?? new Error("engineFetchJson: exhausted attempts");
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
