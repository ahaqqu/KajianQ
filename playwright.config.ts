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
    // exercise app behavior, not SW mechanics. The limiter gates every
    // request (SPA assets included — one shared Hono middleware stack), so
    // even a /v1-free scenario cannot avoid the multiplication. The update-
    // prompt flow (sw-update.tsx) this block once left untested (thermo-
    // review C2) is now pinned by unit coverage in
    // apps/web/src/lib/sw-update.test.ts. Staging that prompt in e2e
    // (route-rewriting the served sw.js so a byte-different worker installs)
    // is possible in Chromium but brittle, and it still pays the precache
    // multiplication; kept blocked on purpose.
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
