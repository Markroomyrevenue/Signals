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
  airroiBaseUrl: process.env.AIRROI_BASE_URL ?? "https://api.airroi.com",
  airroiApiKey: process.env.AIRROI_API_KEY ?? "",
  airroiCacheTtlDays: Number.parseInt(process.env.AIRROI_CACHE_TTL_DAYS ?? "14", 10) || 14,
  appBaseUrl: process.env.APP_BASE_URL ?? "http://localhost:3000",
  dataMode: (process.env.DATA_MODE ?? "demo").trim().toLowerCase()
};
