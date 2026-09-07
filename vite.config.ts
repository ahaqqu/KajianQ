import { defineConfig } from "vite-plus";

// Vite+ (vp) owns the check layer (lint via Oxlint, format via Oxfmt) plus
// the web dev/build/test surface (ADR-0029): apps/web scripts and the root
// test run via vp. apps/api stays bun + Alchemy (ADR-0027/0028); bun stays
// package manager and script router.
//
// No template-sync manifest exists (ADR-0030); project-owned files are the
// only ones in the lint/format corpus. Byte-exact fixture dirs are excluded
// below.
const byteExactFixtures = [
  "packages/kajianq-domain/src/fixtures/**",
  "scripts/role-gh-identity/fixtures/**",
  "scripts/iteration-guardrail/fixtures/**",
];

export default defineConfig({
  lint: {
    ignorePatterns: [
      "**/dist/**",
      "**/coverage/**",
      "**/test-results/**",
      "**/playwright-report/**",
      ...byteExactFixtures,
      // Harness config is project-owned (ADR-0030).
      ".zcode/**",
      "bun.lock",
    ],
  },
});
