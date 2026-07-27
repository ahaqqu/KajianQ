import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/**/src/**/*.{test,prop.test}.ts",
      "apps/**/src/**/*.{test,prop.test}.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: [
        "packages/shared-zod/src/**/*.ts",
        "packages/sync-protocol/src/**/*.ts",
        "packages/infra/src/**/*.ts",
        "apps/api/src/env.ts",
        "apps/api/src/routes/**/*.ts",
        "apps/api/src/lib/auth.ts",
        "apps/api/src/lib/db.ts",
        "apps/api/src/lib/openapi.ts",
        "apps/api/src/lib/rate-limit-mw.ts",
        "apps/api/src/lib/notes-repo.ts",
        "apps/api/src/lib/context.ts",
        "apps/web/src/lib/i18n.ts",
        "apps/web/src/lib/health.ts",
        "apps/web/src/lib/store.ts",
        "apps/web/src/lib/session.ts",
        "apps/web/src/lib/persist.ts",
        "apps/web/src/lib/migrations.ts",
      ],
      exclude: ["**/*.{test,prop.test}.ts", "**/index.ts", "**/*.d.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
  },
});
