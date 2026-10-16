import { defineConfig } from "vite-plus";

// Vite+ (vp) owns the toolchain: the check layer (lint via Oxlint, format via
// Oxfmt) and the web dev/build/test surface. `vite.config.ts`,
// `vitest.config.ts`, `apps/web/vite.config.ts` and every test import vp, so
// the `vite-plus` devDependency is the version lever. The one name left that
// tracks it is the `@vitest/coverage-v8` pin — vp ships no coverage provider
// and fails the run when that pin does not match its bundled Vitest. apps/api
// stays bun on the VPS (ADR-0027, ADR-0044); bun stays package manager and
// script router.
//
// Byte-exact fixture dirs are excluded from the lint/format corpus below: they
// are pinned artifacts, and reformatting them would change the data the tests
// assert on.
const byteExactFixtures = ["packages/kajianq-domain/src/fixtures/**"];

export default defineConfig({
  lint: {
    ignorePatterns: [
      "**/dist/**",
      "**/coverage/**",
      "**/test-results/**",
      "**/playwright-report/**",
      ...byteExactFixtures,
      // Harness config is project-owned (template-sync is retired).
      ".zcode/**",
      "bun.lock",
    ],
  },
});
