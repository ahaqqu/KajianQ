import { readFileSync } from "node:fs";
import { defineConfig } from "vite-plus";

// Vite+ (vp) owns lint (Oxlint), format (Oxfmt), and type-aware checking.
// Scope is ADR-0029: the check layer only — builds stay on Vite, tests on
// Vitest under Bun, deploys on Alchemy (apps/api is not a Vite project).
//
// Template-owned files (template-sync.json `overwrite`) must stay
// byte-identical to upstream, so they are excluded from both lint (here)
// and format (.prettierignore — keep the two lists aligned with
// template-sync.json).
const templateOwned = (
  JSON.parse(readFileSync(new URL("./template-sync.json", import.meta.url), "utf8")) as {
    overwrite: string[];
  }
).overwrite;

export default defineConfig({
  lint: {
    ignorePatterns: [
      "**/dist/**",
      "**/coverage/**",
      "**/test-results/**",
      "**/playwright-report/**",
      // Raw source fixtures are byte-exact copies of source data
      // (AGENTS.md data-integrity rules) — formatters must never touch them.
      "**/fixtures/**",
      // Harness config follows the template as a merge path (ADR-0024);
      // keep it out of the formatting/lint corpus to avoid merge churn.
      ".zcode/**",
      "bun.lock",
      ...templateOwned.map((p) => (p.endsWith("/") ? `${p}**` : p)),
    ],
  },
});
