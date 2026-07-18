import { ensureEnvLoaded } from "@/lib/load-env";

ensureEnvLoaded();

export const env = {
  databaseUrl: process.env.DATABASE_URL ?? "",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  nextAuthSecret: process.env.NEXTAUTH_SECRET ?? "",
  apiEncryptionKey: process.env.API_ENCRYPTION_KEY ?? "",
  webhookBasicUser: process.env.WEBHOOK_BASIC_USER ?? "",
  webhookBasicPass: process.env.WEBHOOK_BASIC_PASS ?? "",
  defaultTimezone: process.env.DEFAULT_TIMEZONE ?? "Europe/London",
  hostawayBaseUrl: process.env.HOSTAWAY_BASE_URL ?? "https://api.hostaway.com",
  // Per-request abort timeout for all Hostaway API calls. Without this, a slow
  // or hung response will block a sync-worker slot indefinitely, eventually
  // starving every other tenant's sync. 90s is generous — successful Hostaway
  // pages return in <5s normally — but keeps headroom for the largest pages.
  // Override per environment via HOSTAWAY_REQUEST_TIMEOUT_MS.
  hostawayRequestTimeoutMs: Number.parseInt(process.env.HOSTAWAY_REQUEST_TIMEOUT_MS ?? "90000", 10) || 90000,
  appBaseUrl: process.env.APP_BASE_URL ?? "http://localhost:3000",
  dataMode: (process.env.DATA_MODE ?? "demo").trim().toLowerCase(),
  // --- Pricing Recommendations page (internal-only, 2026-07-18) ---
  // Kill switch: the page, its nav links, and every /api/recs route are hidden
  // unless this is exactly "true". Absent = hidden (deliberate: a fresh env
  // never exposes the page by accident).
  recsPageEnabled: (process.env.RECS_PAGE_ENABLED ?? "").trim().toLowerCase() === "true",
  // Comma-separated allowlist of internal emails. Both conditions must hold to
  // see the page: session role === "admin" AND email is in this list.
  internalRecsEmails: (process.env.INTERNAL_RECS_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0),
  recsOversightEnabled: (process.env.RECS_OVERSIGHT_ENABLED ?? "").trim().toLowerCase() === "true",
  recsOversightModel: (process.env.RECS_OVERSIGHT_MODEL ?? "claude-fable-5").trim()
};
