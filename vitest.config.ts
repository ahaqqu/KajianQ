import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    dedupe: ["effect"],
  },
  test: {
    // The real-Postgres contract suites share one database and mutate its schema
    // (the erasure suite drops a foreign key and installs BEFORE DELETE triggers),
    // so two of them must never run at once. They only exist when a database is
    // configured, which is exactly when the runner has to serialize the files; the
    // DB-less gate keeps full parallelism. The serial property therefore belongs to
    // the configuration, not to whoever remembers to pass a flag.
    fileParallelism: !process.env.DATABASE_URL,
    // @fast-check/vitest reaches into Vitest's TestRunner for the current suite,
    // and that state lives in the module instance the runner loads. Externalized,
    // the package would import its own copy of Vitest and `test.prop` would throw
    // "failed to find the current suite"; inlining keeps it in the runner's module
    // graph.
    server: {
      deps: {
        inline: ["@fast-check/vitest"],
      },
    },
    include: [
      "packages/**/src/**/*.{test,prop.test}.ts",
      "apps/**/src/**/*.{test,prop.test}.ts",
      "tests/scripts/**/*.test.mjs",
      // Cross-package specs (the client↔server rule-copy parity guard and the
      // smoke's fixture↔selector membership pin): the one tree where both an
      // app's and a package's source may be imported without an app→package
      // dependency edge.
      "tests/parity/**/*.test.mjs",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      // Policy: unit-test coverage for logic — packages, the API, and the
      // web lib layer. UI (components/**) and entry bootstraps
      // (`main.tsx`, `boot.ts`, `cleanup.ts`) are covered by Playwright-BDD +
      // axe, not unit tests: a process entry point is exercised by booting it,
      // and its logic lives in the `lib/` modules those entries call. Adding a
      // logic module under these globs means covering it — no curated opt-out.
      include: ["packages/**/src/**/*.ts", "apps/api/src/**/*.ts", "apps/web/src/lib/**/*.ts"],
      exclude: [
        "**/*.{test,prop.test}.ts",
        "**/index.ts",
        "**/client.ts",
        "**/*.d.ts",
        "packages/rate/src/test-utils/**",
        "apps/api/src/boot.ts",
        "apps/api/src/cleanup.ts",
        "apps/web/src/main.tsx",
        "apps/web/src/components/**",
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
