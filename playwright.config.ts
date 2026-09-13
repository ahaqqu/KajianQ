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
    // The PWA service worker's precache multiplies per-context requests;
    // these tests exercise app behavior, not SW mechanics. (It also once
    // 429'd suites against the dev worker's per-IP limiter — that limiter
    // now meters the /v1 surface only, ADR-0041, so assets are unmetered —
    // but the SW block stays: the update-prompt flow (sw-update.tsx) this
    // block once left untested (thermo-review C2) is pinned by unit
    // coverage in apps/web/src/lib/sw-update.test.ts, and staging that
    // prompt in e2e (route-rewriting the served sw.js so a byte-different
    // worker installs) is possible in Chromium but brittle.)
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
