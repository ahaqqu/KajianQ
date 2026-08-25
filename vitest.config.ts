import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/**/src/**/*.{test,prop.test}.ts",
      "apps/**/src/**/*.{test,prop.test}.ts",
      "tests/scripts/**/*.test.mjs",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      // Policy: unit-test coverage for logic — packages, the API, and the
      // web lib layer. UI (components/**) and entry bootstraps (main.tsx)
      // are covered by Playwright-BDD + axe, not unit tests. Adding a logic
      // module under these globs means covering it — no curated opt-out.
      include: [
        "packages/**/src/**/*.ts",
        "apps/api/src/**/*.ts",
        "apps/web/src/lib/**/*.ts",
      ],
      exclude: [
        "**/*.{test,prop.test}.ts",
        "**/index.ts",
        "**/client.ts",
        "**/*.d.ts",
        "apps/api/src/cf-types.ts",
        "apps/api/src/test-utils/**",
        "apps/web/src/main.tsx",
        "apps/web/src/components/**",
        // The Neon RagStore adapter is an I/O shell over pure, unit-covered
        // helpers (rag-store-shared.ts) and the query builder
        // (rag-store-neon-query.ts). Its own methods are exercised by the
        // secret-gated `neon-contract` CI job (rag-store-neon.test.ts), which
        // needs NEON_DATABASE_URL and so cannot run in the default gate job
        // (or on fork PRs). Excluding it here keeps the gate's coverage
        // threshold meaningful for logic without requiring the secret.
        "packages/infra/src/rag-store-neon.ts",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
  },
});
