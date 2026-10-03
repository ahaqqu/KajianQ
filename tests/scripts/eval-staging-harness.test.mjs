import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { disposePostgresPools } from "../../packages/infra/src/index";
import {
  CITATION_GRAMMAR,
  createStagingHarness,
  REFUSAL_MARKERS,
} from "../../packages/eval/scripts/staging-harness.mjs";
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

  it("delivers the grammar from the real composition root, not only declares it (review T2)", async () => {
    // R1 pinned the grammar OBJECT; this pins its DELIVERY. Deleting the one
    // `citationGrammar: CITATION_GRAMMAR,` line from `createStagingHarness`
    // still compiles and left every test in this suite green, so the scorer
    // silently lost the normalization/range semantics (a marker-spelling
    // variant scored 0 again). The assertion is behavioural and reads the
    // harness the CLIs actually receive: what it returns must be the grammar,
    // by identity, and it must still answer a naming question through the
    // scorer. The URL is never dialled — `resolvePostgresStore` builds a lazy
    // pool, so no staging secret is needed here — and the memoized pool is
    // released below so the run does not leak a handle.
    const harness = await createStagingHarness(
      { databaseUrl: "postgres://unused:unused@127.0.0.1:1/unused" },
      {},
    );
    try {
      expect(harness.citationGrammar).toBe(CITATION_GRAMMAR);
      // Through the harness's OWN reference, not the module constant: a dropped
      // delivery is `undefined` here, and the scorer's documented no-grammar
      // degradation then scores the marker spelling 0.
      const delivered = harness.citationGrammar;
      expect(delivered.addressesNamedBy("QS. 2:255-256")).toEqual(["QS. 2:255", "QS. 2:256"]);
      expect(citationValidity(["QS. 1:2"], "… Q.S. 1:2 …", { grammar: delivered })).toBe(1);
      expect(citationValidity(["QS. 1:2"], "… Q.S. 1:2 …", { grammar: delivered })).not.toBe(0);
    } finally {
      await disposePostgresPools();
    }
  });

  it("forwards the harness's grammar into the scorer in both eval CLIs (review T2)", () => {
    // The second half of the delivery: the harness can hold the grammar and
    // both entry points still drop it on the floor. They are `#!/usr/bin/env
    // bun` scripts that connect to staging on import, so the pass-through is
    // pinned where it lives — the same instrument this file already uses for
    // the refusal-marker drift between the two CLIs.
    for (const script of ["eval-run.mjs", "eval-smoke.mjs"]) {
      const source = readFileSync(resolve(process.cwd(), "packages/eval/scripts", script), "utf8");
      expect(source).toMatch(/citationGrammar:\s*harness\.citationGrammar,/);
    }
  });
});
