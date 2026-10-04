import { defineConfig } from "vite-plus";

// Vite+ (vp) owns the check layer (lint via Oxlint, format via Oxfmt) plus
// the web dev/build/test surface: apps/web scripts and the root test run via
// vp, version-coupled to vp's own bundled Vite/Vitest (`scripts/check-vp-vite-pin.mjs`
// is the guard). apps/api stays bun on the VPS (ADR-0027, ADR-0044); bun stays
// package manager and script router.
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
