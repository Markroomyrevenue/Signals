import { existsSync, renameSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const distDir = path.resolve(process.cwd(), ".roomy-smoke");

if (existsSync(distDir)) {
  const archivedDir = path.resolve(process.cwd(), `.roomy-smoke-archive-${Date.now()}`);
  renameSync(distDir, archivedDir);

  const cleanup = spawn("rm", ["-rf", archivedDir], {
    detached: true,
    stdio: "ignore"
  });
  cleanup.unref();
}
