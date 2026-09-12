import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REFUSAL_MARKERS } from "../../packages/eval/scripts/staging-harness.mjs";
import { DEFAULT_REFUSALS } from "../../packages/kajianq-domain/src/chat-reviewer";

/**
 * The shared staging bootstrap (thermo-review B2): `eval:run` and `eval:smoke`
 * both build their seams from this one module, so the two entry points cannot
 * drift. The Neon connection itself needs staging secrets, so what is pinned
 * here is the part that drifted before — the refusal markers, which must stay
 * in step with the domain pack's own refusal text. A script-side copy that
 * disagreed with the pipeline would make the harness score a real refusal as a
 * failure (or a failure as a refusal).
 */
describe("REFUSAL_MARKERS (shared staging harness)", () => {
  it("matches the domain pack's refusal text for both languages", () => {
    expect(REFUSAL_MARKERS).toContain(DEFAULT_REFUSALS.id);
    expect(REFUSAL_MARKERS).toContain(DEFAULT_REFUSALS.en);
  });

  it("carries no empty marker (an empty string matches every answer)", () => {
    for (const marker of REFUSAL_MARKERS) {
      expect(marker.trim()).not.toBe("");
    }
  });

  it("is the only refusal-marker literal in the eval scripts", () => {
    // The drift this prevents: two copies of the markers, one per CLI. Both
    // entry points must import the constant rather than restate it.
    for (const script of ["eval-run.mjs", "eval-smoke.mjs"]) {
      const source = readFileSync(resolve(process.cwd(), "packages/eval/scripts", script), "utf8");
      expect(source).toContain("createStagingHarness");
      expect(source).not.toMatch(/const REFUSAL_MARKERS\s*=/);
      expect(source).not.toMatch(/could not find adequate evidence/);
    }
  });
});
