import { defineConfig, devices } from "@playwright/test";
import { defineBddConfig } from "playwright-bdd";

const testDir = defineBddConfig({
  features: "tests/features/**/*.feature",
  steps: "tests/steps/**/*.ts",
});

export default defineConfig({
  testDir,
  timeout: 60_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:8787",
    trace: "on-first-retry",
    // The PWA service worker's precache multiplies per-context requests
    // against the dev worker's per-IP rate limiter (120/min); these tests
    // exercise app behavior, not SW mechanics. Known accepted gap (thermo-
    // review C2, recorded in SPECS §2.3): with SWs blocked here and no SW
    // unit test, the update-prompt flow (sw-update.tsx) is untested
    // everywhere — registration compiling is all "the build" proves.
    serviceWorkers: "block",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "bun run build && bun run --filter '@app/api' dev",
        url: "http://127.0.0.1:8787/v1/health",
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
      },
});
