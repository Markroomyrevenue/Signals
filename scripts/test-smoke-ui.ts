import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import { loadEnvConfig } from "@next/env";
import { chromium } from "playwright";

loadEnvConfig(process.cwd());

const HOST = "127.0.0.1";
const PORT = Number.parseInt(process.env.ROOMY_SMOKE_PORT ?? "3101", 10);
const BASE_URL = `http://${HOST}:${PORT}`;
const email = process.env.SEED_ADMIN_EMAIL ?? "";
const password = process.env.SEED_ADMIN_PASSWORD ?? "";

assert(email, "SEED_ADMIN_EMAIL must be set to run the UI smoke test.");
assert(password, "SEED_ADMIN_PASSWORD must be set to run the UI smoke test.");

type SmokeServerProcess = ChildProcessByStdio<null, Readable, Readable>;

function spawnServer(): SmokeServerProcess {
  return spawn("npm", ["start"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function waitForServer(server: SmokeServerProcess): Promise<void> {
  let output = "";

  server.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`Smoke server exited early.\n${output}`);
    }

    try {
      const response = await fetch(`${BASE_URL}/login`, {
        redirect: "manual"
      });
      if (response.ok || response.status === 307 || response.status === 308) {
        return;
      }
    } catch {
      // Retry until the server is ready.
    }

    await delay(500);
  }

  throw new Error(`Timed out waiting for smoke server at ${BASE_URL}.\n${output}`);
}

async function main(): Promise<void> {
  const server = spawnServer();
  let browser;

  try {
    await waitForServer(server);

    browser = await chromium.launch({ headless: true });

    const desktopContext = await browser.newContext({
      baseURL: BASE_URL,
      viewport: { width: 1440, height: 1100 }
    });
    const desktopPage = await desktopContext.newPage();

    await desktopPage.goto("/login", { waitUntil: "domcontentloaded" });
    await desktopPage.waitForSelector("form");

    const placeholder = await desktopPage.locator('input[type="email"]').getAttribute("placeholder");
    assert.equal(placeholder, "you@company.com", "Expected the neutral login placeholder.");

    await desktopPage.locator('input[type="email"]').fill(email);
    await desktopPage.locator('input[type="password"]').fill(password);
    await Promise.all([
      desktopPage.waitForURL(/\/dashboard(\/select-client)?/, { timeout: 90000, waitUntil: "domcontentloaded" }),
      desktopPage.getByRole("button", { name: /sign in/i }).click()
    ]);

    if (desktopPage.url().includes("/dashboard/select-client")) {
      const clientSearch = desktopPage.locator('input[type="search"]');
      await clientSearch.waitFor({ state: "visible" });
      assert.equal(
        await clientSearch.isVisible(),
        true,
        "Expected client search controls on the selector."
      );

      await Promise.all([
        desktopPage.waitForURL((url) => url.pathname === "/dashboard", { timeout: 90000 }),
        desktopPage.getByRole("button", { name: /open workspace/i }).first().click()
      ]);
    }

    await desktopPage.goto("/dashboard/settings", { waitUntil: "domcontentloaded" });
    const hostawayHeading = desktopPage.getByRole("heading", { name: "Hostaway connection" });
    const portfolioHeading = desktopPage.getByRole("heading", { name: "Portfolio list" });
    await hostawayHeading.waitFor({ state: "visible", timeout: 15000 });
    await portfolioHeading.waitFor({ state: "visible", timeout: 15000 });
    assert.equal(
      await hostawayHeading.isVisible(),
      true,
      "Expected Hostaway connection controls in settings."
    );
    assert.equal(
      await portfolioHeading.isVisible(),
      true,
      "Expected portfolio controls in settings."
    );

    await desktopPage.goto("/dashboard", { waitUntil: "domcontentloaded" });
    const saveViewButton = desktopPage.getByRole("button", { name: /save view/i }).first();
    await saveViewButton.waitFor({ state: "visible", timeout: 30000 });
    assert.equal(
      await saveViewButton.isVisible(),
      true,
      "Expected Save view controls on the dashboard."
    );

    const calendarView = Buffer.from(JSON.stringify({ tab: "calendar" })).toString("base64");
    await desktopPage.goto(`/dashboard?view=${encodeURIComponent(calendarView)}&calendarWorkspace=1`, {
      waitUntil: "domcontentloaded"
    });
    await desktopPage.waitForSelector("text=Calendar Workspace", { timeout: 20000 });
    assert.equal(
      await desktopPage.getByText(/Last sync:/).isVisible(),
      true,
      "Expected the calendar workspace sync status chip."
    );
    const marketStatusChip = desktopPage.locator("text=/need setup|using backup pricing|Market ready/i").first();
    await marketStatusChip.waitFor({ state: "visible", timeout: 15000 });
    assert.equal(
      await marketStatusChip.isVisible(),
      true,
      "Expected market readiness messaging in the calendar workspace."
    );
    assert.equal(
      await desktopPage.getByRole("button", { name: /refresh market data/i }).isVisible().catch(() => false),
      false,
      "Refresh Market Data should stay hidden while live market refresh is disabled."
    );

    const mobileContext = await browser.newContext({
      baseURL: BASE_URL,
      viewport: { width: 390, height: 844 }
    });
    await mobileContext.addCookies(await desktopContext.cookies());
    const mobilePage = await mobileContext.newPage();
    await mobilePage.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await mobilePage.waitForLoadState("domcontentloaded");
    const mobileMenuButton = mobilePage.locator('button[aria-controls="dashboard-sidebar"]').first();
    await mobileMenuButton.waitFor({ state: "visible", timeout: 30000 });

    assert.equal(
      await mobileMenuButton.isVisible(),
      true,
      "Expected the mobile navigation toggle."
    );

    await mobileContext.close();
    await desktopContext.close();

    console.log("UI smoke passed.");
  } finally {
    await browser?.close();

    server.kill("SIGINT");
    await delay(500);

    if (server.exitCode === null) {
      server.kill("SIGKILL");
    }
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "UI smoke failed.");
  process.exitCode = 1;
});
