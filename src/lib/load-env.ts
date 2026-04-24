import { loadEnvConfig } from "@next/env";

declare global {
  // eslint-disable-next-line no-var
  var __hostawayEnvLoaded: boolean | undefined;
}

export function ensureEnvLoaded(): void {
  if (globalThis.__hostawayEnvLoaded) {
    return;
  }

  loadEnvConfig(process.cwd());
  globalThis.__hostawayEnvLoaded = true;
}
