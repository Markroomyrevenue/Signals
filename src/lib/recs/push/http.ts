/**
 * WRITE-capable HTTP helper for the recs push adapters — the ONLY HTTP path in
 * the product that issues PUT/DELETE against an external pricing engine.
 *
 * Differences from the read-only `engineFetchJson` (src/lib/observe/engine/http.ts):
 * - Supports GET/POST/PUT/DELETE.
 * - Takes multiple auth headers (Wheelhouse writes need BOTH
 *   `X-Integration-Api-Key` and `X-User-Api-Key`). EVERY header value is treated
 *   as a secret and redacted from every error string.
 * - Retries on 429 + 5xx as before, plus 409 ONLY when the caller opts in via
 *   `retryOn409` (Wheelhouse returns 409 for a concurrent request on the same
 *   listing; bounded retry is the documented remedy).
 * - Handles a DELETE-style 204 / empty-body success by returning `null`.
 *
 * Shared pieces (backoff, browser UA, error type, redaction) are imported from
 * the observe layer so there is one behaviour, not two drifting copies. The
 * browser UA goes on every call — api.pricelabs.co sits behind Cloudflare and
 * 403s non-browser UAs.
 */

import { backoffDelayMs, ENGINE_USER_AGENT, EngineHttpError } from "@/lib/observe/engine/http";
import { redactSecrets } from "@/lib/observe/secrets";

export type RecsHttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export type RecsEngineFetchArgs = {
  url: string;
  method?: RecsHttpMethod;
  /** Auth headers, e.g. { "X-API-Key": key }. Every VALUE is redacted from errors. */
  authHeaders: Record<string, string>;
  body?: unknown;
  /** Max attempts including the first. Default 4. */
  maxAttempts?: number;
  /** Base backoff in ms (doubles each retry). Default 1500. */
  baseDelayMs?: number;
  /** Per-request timeout in ms. Default 30000. */
  timeoutMs?: number;
  /** Opt-in bounded retry on 409 (Wheelhouse concurrent-write). Default false. */
  retryOn409?: boolean;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to a real timer. */
  sleepImpl?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Perform one JSON request against an engine with key-safe errors and backoff
 * retries. Returns the parsed JSON, or `null` for a 204 / empty-body success
 * (Wheelhouse DELETE custom_rates → 204). Throws `EngineHttpError` (status
 * attached) with every auth-header value redacted from the message.
 */
export async function recsEngineFetch<T = unknown>(args: RecsEngineFetchArgs): Promise<T | null> {
  const {
    url,
    method = "GET",
    authHeaders,
    body,
    maxAttempts = 4,
    baseDelayMs = 1500,
    timeoutMs = 30000,
    retryOn409 = false,
    fetchImpl = fetch,
    sleepImpl = defaultSleep
  } = args;

  const secrets = Object.values(authHeaders);
  const isRetryableStatus = (status: number): boolean =>
    status === 429 || status >= 500 || (retryOn409 && status === 409);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method,
        headers: {
          ...authHeaders,
          Accept: "application/json",
          "User-Agent": ENGINE_USER_AGENT,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {})
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });

      if (response.ok) {
        if (response.status === 204) return null;
        const text = await safeText(response);
        if (text.trim().length === 0) return null;
        try {
          return JSON.parse(text) as T;
        } catch {
          // Non-JSON 2xx body: fail fast (status < 500 ⇒ not retried below).
          throw new EngineHttpError(
            `Non-JSON ${response.status} body from engine: ${redactSecrets(text, secrets).slice(0, 300)}`,
            response.status
          );
        }
      }

      const detail = redactSecrets(await safeText(response), secrets);
      const err = new EngineHttpError(
        `HTTP ${response.status} from engine: ${detail.slice(0, 300)}`,
        response.status
      );
      if (!isRetryableStatus(response.status) || attempt === maxAttempts - 1) throw err;
      lastError = err;
    } catch (error) {
      if (error instanceof EngineHttpError) {
        if (!isRetryableStatus(error.status) || attempt === maxAttempts - 1) throw error;
        lastError = error;
      } else {
        // Network / abort errors: message may echo the URL or headers — redact.
        const message = redactSecrets(error instanceof Error ? error.message : String(error), secrets);
        lastError = new Error(message);
        if (attempt === maxAttempts - 1) throw lastError;
      }
    } finally {
      clearTimeout(timer);
    }

    await sleepImpl(backoffDelayMs(attempt, baseDelayMs));
  }

  throw lastError ?? new Error("recsEngineFetch: exhausted attempts");
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
