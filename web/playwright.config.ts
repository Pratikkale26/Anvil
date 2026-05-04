import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the Anvil workbench (#20 / H7).
 *
 * The workbench fetches from the API at NEXT_PUBLIC_API_URL (defaults
 * http://localhost:8080). Local e2e runs need both:
 *   1. API server: `cd api && bun src/index.ts`
 *   2. Web dev server: `cd web && bun next dev`
 *
 * The webServer block below auto-spawns the dev server. The API isn't
 * spawned automatically (it has a heavier startup cost and depends on
 * cargo toolchain detection that doesn't matter for the workbench
 * smoke flows here) — the test reporter explicitly checks for it and
 * skips the affected test groups when unreachable so a developer
 * running these locally without the API doesn't see a wall of failures.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: process.env.E2E_NO_WEBSERVER
    ? undefined
    : {
        command: "bun next dev --port 3000",
        url: "http://localhost:3000",
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
});
