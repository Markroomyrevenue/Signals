import { env } from "@/lib/env";

export function redisConnectionOptions() {
  const url = new URL(env.redisUrl);

  const username = url.username ? decodeURIComponent(url.username) : undefined;
  const password = url.password ? decodeURIComponent(url.password) : undefined;
  const useTls = url.protocol === "rediss:";

  const options: {
    host: string;
    port: number;
    username?: string;
    password?: string;
    tls?: Record<string, never>;
    maxRetriesPerRequest: null;
  } = {
    host: url.hostname,
    port: Number(url.port || "6379"),
    // BullMQ requires this to be null so blocking commands aren't aborted.
    maxRetriesPerRequest: null
  };

  if (username) options.username = username;
  if (password) options.password = password;
  if (useTls) options.tls = {};

  return options;
}
