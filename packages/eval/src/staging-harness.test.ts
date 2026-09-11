import { describe, expect, it } from "vitest";
import { REFUSAL_MARKERS } from "./staging-harness";
import { DEFAULT_REFUSALS } from "@app/kajianq-domain";

/**
 * The shared staging bootstrap (thermo-review B2): `eval:run` and `eval:smoke`
 * both build their seams from one function, so the two entry points cannot
 * drift. The Neon connection itself needs staging secrets, so what is pinned
 * here is the part that drifted before: the refusal markers must stay in step
 * with the domain pack's own refusal text — a script-side copy that disagrees
 * with the pipeline would make the harness score a real refusal as a failure
 * (or a failure as a refusal).
 */
describe("REFUSAL_MARKERS", () => {
  it("matches the domain pack's refusal text for both languages", () => {
    expect(REFUSAL_MARKERS).toContain(DEFAULT_REFUSALS.id);
    expect(REFUSAL_MARKERS).toContain(DEFAULT_REFUSALS.en);
  });

  it("carries no empty marker (an empty string matches every answer)", () => {
    for (const marker of REFUSAL_MARKERS) {
      expect(marker.trim()).not.toBe("");
    }
  });
});
