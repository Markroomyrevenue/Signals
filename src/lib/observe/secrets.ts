/**
 * Secret-masking helpers for the observe-and-learn engine layer.
 *
 * Hard rule (SIGNALS-OBSERVE-LEARN-SPEC.md §11): API keys are NEVER printed,
 * echoed, logged, committed, or returned by any route/report. Every log line
 * and every connectivity-check field that could touch a key goes through these
 * helpers first. `maskSecret` reveals only whether a key is set and its length —
 * never a single character of it — and `redactSecrets` scrubs any raw key that
 * might otherwise slip into an error string (e.g. a fetch error that echoes a
 * URL or header).
 */

/**
 * Render a secret for human display without leaking any of its characters.
 * Returns "(unset)" for missing values and "(set: N chars)" otherwise. No
 * prefix/suffix of the key is exposed by design.
 */
export function maskSecret(secret: string | null | undefined): string {
  if (secret === null || secret === undefined) return "(unset)";
  const trimmed = String(secret).trim();
  if (trimmed.length === 0) return "(unset)";
  return `(set: ${trimmed.length} chars)`;
}

/**
 * Replace every occurrence of each known secret in `text` with a fixed
 * redaction marker. Used to sanitise error messages / log lines before they are
 * emitted, so even an upstream library that echoes a key cannot leak it.
 *
 * Pure. Empty/short secrets (< 6 chars) are skipped — they would over-redact
 * ordinary text and a real engine key is always far longer.
 */
export function redactSecrets(text: string, secrets: Array<string | null | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    const value = String(secret);
    if (value.length < 6) continue;
    out = out.split(value).join("***REDACTED***");
  }
  return out;
}

/**
 * Sanitise an unknown thrown value into a string with all known secrets
 * redacted. Convenience wrapper used in adapter catch blocks.
 */
export function safeErrorMessage(error: unknown, secrets: Array<string | null | undefined>): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message, secrets);
}
