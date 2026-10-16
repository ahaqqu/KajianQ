import { defineConfig } from "vite-plus";

// Vite+ (vp) owns the toolchain: the check layer (lint via Oxlint, format via
// Oxfmt) and the web dev/build/test surface. `vite.config.ts`,
// `vitest.config.ts`, `apps/web/vite.config.ts` and every test import vp, so
// the `vite-plus` devDependency is the only version lever; the revisions it
// carries that the project still names separately live in `package.json`'s
// `overrides` and have to be moved with it. apps/api stays bun on the VPS
// (ADR-0027, ADR-0044); bun stays package manager and script router.
//
// only ones in the lint/format corpus. Byte-exact fixture dirs are excluded
// below.
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
