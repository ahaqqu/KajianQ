import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CITATION_GRAMMAR, REFUSAL_MARKERS } from "../../packages/eval/scripts/staging-harness.mjs";
import { DEFAULT_REFUSALS } from "../../packages/kajianq-domain/src/chat-reviewer";
import {
  addressesNamedBy,
  citationCandidatesIn,
  normalizeCitationLabel,
} from "../../packages/kajianq-domain/src/index";
import { citationValidity } from "../../packages/eval/src/scorers";
import { requireCitationGrammar } from "../../packages/eval/src/citation-grammar";

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

/**
 * The composition root's citation grammar (review R1 of the #274 fix round).
 * `staging-harness.mjs` is JavaScript, so the engine's now-required
 * `CitationGrammar.addressesNamedBy` cannot be enforced by the type system
 * there: deleting the one property line that injects it would compile, pass
 * every package test, and silently return the scorer to the string-only
 * comparison that scored a grounded range 0 on the frame path (A1's defect).
 * The declaration is therefore pinned here — **identity with the domain pack's
 * own function**, not a stub — and the engine's grammar entry is exercised
 * through the real composition root.
 */
describe("CITATION_GRAMMAR (shared staging harness)", () => {
  it("injects the domain pack's own functions, the naming declaration included", () => {
    expect(CITATION_GRAMMAR.normalizeLabel).toBe(normalizeCitationLabel);
    expect(CITATION_GRAMMAR.labelsInText).toBe(citationCandidatesIn);
    expect(CITATION_GRAMMAR.addressesNamedBy).toBe(addressesNamedBy);
  });

  it("passes the engine's grammar entry, which refuses the same object without it", () => {
    expect(() => requireCitationGrammar(CITATION_GRAMMAR)).not.toThrow();
    const { addressesNamedBy: omitted, ...withoutDeclaration } = CITATION_GRAMMAR;
    expect(omitted).toBeTypeOf("function");
    expect(() => requireCitationGrammar(withoutDeclaration)).toThrow(/addressesNamedBy/);
  });

  it("names a range's whole address list through the real domain declaration", () => {
    expect(CITATION_GRAMMAR.addressesNamedBy("QS. 2:255-256")).toEqual(["QS. 2:255", "QS. 2:256"]);
  });

  it("scores a grounded range 1 on the frame, events and text paths", () => {
    const answer = "Dalilnya QS. 2:255-256 tentang hal ini.";
    const frame = { citations: [{ label: "QS. 2:255-256" }] };
    const events = [
      {
        kind: "review",
        stage: "reviewer",
        detail: { verdict: "{}", grounded: ["QS. 2:255", "QS. 2:256"] },
      },
    ];
    expect(citationValidity(["QS. 2:255"], answer, { frame, grammar: CITATION_GRAMMAR })).toBe(1);
    expect(citationValidity(["QS. 2:256"], answer, { grammar: CITATION_GRAMMAR })).toBe(1);
    expect(citationValidity(["QS. 2:255"], answer, { events, grammar: CITATION_GRAMMAR })).toBe(1);
  });
});
