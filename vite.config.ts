import { defineConfig } from "vite-plus";

const byteExactFixtures = ["packages/kajianq-domain/src/fixtures/**"];

// Vendored skills are synced from their upstream and hand-merged, so the
// formatter must not rewrite them: a reformat turns every future sync into a
// noisy diff. Lint still runs on them.
const vendoredSkills = [".agents/skills/security-audit/**"];

export default defineConfig({
  lint: {
    ignorePatterns: [
      "**/dist/**",
      "**/coverage/**",
      "**/test-results/**",
      "**/playwright-report/**",
      ...byteExactFixtures,
      "bun.lock",
    ],
  },
  fmt: {
    ignorePatterns: vendoredSkills,
  },
});
