import { readFileSync } from "node:fs";
import { defineConfig } from "vite-plus";

// Vite+ (vp) owns the check layer (lint via Oxlint, format via Oxfmt) plus
// the web dev/build/test surface (ADR-0029): apps/web scripts and the root
// test run via vp. apps/api stays bun + Alchemy (ADR-0027/0028); bun stays
// package manager and script router.
//
// Template-owned files (template-sync.json `overwrite`) must stay
// byte-identical to upstream, so they are excluded from both lint (here)
// and format (.prettierignore — a manual mirror; vp's fmt stage cannot
// read this derived config, and template-gate in CI backstops drift).
const templateOwned = (
  JSON.parse(readFileSync(new URL("./template-sync.json", import.meta.url), "utf8")) as {
    overwrite: string[];
  }
).overwrite;

// Byte-exact copies of source data (AGENTS.md data-integrity rules) — the
// only byte-exact fixture dirs in the repo. Hand-written test data elsewhere
// stays linted/formatted.
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
      // Harness config follows the template as a merge path (ADR-0024);
      // keep it out of the formatting/lint corpus to avoid merge churn.
      ".zcode/**",
      "bun.lock",
      ...templateOwned.map((p) => (p.endsWith("/") ? `${p}**` : p)),
    ],
  },
});
