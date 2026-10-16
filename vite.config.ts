import { defineConfig } from "vite-plus";

const byteExactFixtures = ["packages/kajianq-domain/src/fixtures/**"];

export default defineConfig({
  lint: {
    ignorePatterns: [
      "**/dist/**",
      "**/coverage/**",
      "**/test-results/**",
      "**/playwright-report/**",
      ...byteExactFixtures,
      ".zcode/**",
      "bun.lock",
    ],
  },
});
