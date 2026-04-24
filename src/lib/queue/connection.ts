import { env } from "@/lib/env";

export function redisConnectionOptions() {
  const url = new URL(env.redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || "6379")
  };
}
