import { defineConfig, devices } from "@playwright/test";

/**
 * E2E tests run against an already-running stack (API :4000, worker, web :3000):
 *   pnpm db:up   ·   pnpm dev   (or the built apps)   ·   pnpm test:e2e
 * Set ORBIX_E2E_BASE_URL to target another deployment.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.ORBIX_E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
});
