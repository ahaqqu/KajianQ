import { defineConfig, devices } from "@playwright/test";
import { defineBddConfig } from "playwright-bdd";
import { E2E_ADMIN_PASSWORD } from "./tests/support/admin-fixture";

const testDir = defineBddConfig({
  features: "tests/features/**/*.feature",
  steps: "tests/steps/**/*.ts",
});

export default defineConfig({
  testDir,
  // The admin browser feature is LOCAL-ONLY: it signs in against the embedded host with a
  // fixture credential and stubs the trace endpoints, so an external run has neither that
  // credential nor the fixture rows. The feature carries `@local`; this filter is what skips
  // it, rather than a run against staging failing red on a host it was never built to drive.
  grepInvert: process.env.E2E_BASE_URL ? /@local/ : undefined,
  timeout: 60_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:8787",
    trace: "on-first-retry",
    // These tests exercise app behavior, not SW mechanics: the PWA service
    // worker's precache multiplies per-context requests, so the worker is
    // blocked here. The update-prompt flow (sw-update.tsx) is pinned by unit
    // coverage in apps/web/src/lib/sw-update.test.ts — staging that prompt in
    // e2e (route-rewriting the served sw.js so a byte-different worker
    // installs) is possible in Chromium but brittle.
    serviceWorkers: "block",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // The suite boots the API as the plain Bun process the VPS runs
  // (`apps/api/src/boot.ts`, ADR-0044), which is the same serving entry the
  // deploy ships and the same one the middleware/route unit tests compose — so
  // e2e exercises the host that serves production, not a runtime shim.
  // `KAJIANQ_WEB_ROOT` points the disk-backed ASSETS handle at the build
  // `bun run build` just produced. No DATABASE_URL is set, so the store-backed
  // routes answer 503 and the suites' route interception (fixture streams,
  // zero LLM spend) provides the behaviour they assert.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "bun run build && bun apps/api/src/boot.ts",
        url: "http://127.0.0.1:8787/v1/health",
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        env: {
          KAJIANQ_WEB_ROOT: "apps/web/dist",
          PORT: "8787",
          APP_ENV: "development",
          // The admin browser is enabled per deployment by its credential; the e2e host
          // enables it so the sign-in scenarios exercise the real guard. The value lives in
          // one place — tests/support/admin-fixture.ts, which the steps import too.
          ADMIN_PASSWORD: E2E_ADMIN_PASSWORD,
        },
      },
});
