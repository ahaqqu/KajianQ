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
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command:
          "bun run build && bunx wrangler d1 migrations apply DB --local -c apps/api/wrangler.toml && bunx wrangler dev -c apps/api/wrangler.toml --ip 127.0.0.1 --port 8787",
        url: "http://127.0.0.1:8787/v1/health",
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
      },
});
