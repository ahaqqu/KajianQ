import { describe, expect, it } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { disposePostgresPools } from "../../packages/infra/src/index";
import {
  CITATION_GRAMMAR,
  CITATION_IDENTITY,
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
 * The shared staging bootstrap: `eval:run` and `eval:smoke` both build their
 * seams from this one module, so the two entry points cannot drift. The Neon
 * connection itself needs staging secrets, so what is pinned here is the refusal
 * markers, which must stay in step with the domain pack's own refusal text. A
 * script-side copy that disagreed with the pipeline would make the harness score
 * a real refusal as a failure (or a failure as a refusal).
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
 * The composition root's citation grammar. `staging-harness.mjs` is JavaScript,
 * so the engine's required `CitationGrammar.addressesNamedBy` cannot be enforced
 * by the type system there: deleting the one property line that injects it would
 * compile and pass every package test while the scorer silently scores a
 * grounded range 0 on the frame path. The declaration is therefore pinned here —
 * **identity with the domain pack's own function**, not a stub — and the engine's
 * grammar entry is exercised through the real composition root.
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
    // This pins the grammar's DELIVERY, not only its declaration: deleting the
    // one `citationGrammar: CITATION_GRAMMAR,` line from `createStagingHarness`
    // still compiles, so the assertion is behavioural and reads the harness the
    // CLIs actually receive — what it returns must be the grammar, by identity,
    // and it must still answer a naming question through the scorer. The URL is
    // never dialled — `resolvePostgresStore` builds a lazy pool, so no staging
    // secret is needed here — and the memoized pool is released below so the run
    // does not leak a handle.
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

/**
 * The composition root's Matn identity resolver. The harness is JavaScript, so
 * the engine's optional `citationIdentity` cannot be enforced by the type
 * system there: deleting the one property line that hands it to the CLIs would
 * compile and pass every package test while the release gate silently reverted
 * to exact-row scoring — a parallel narration of the required hadith then
 * scores 0. It is therefore pinned here, like the grammar: the delivery by
 * identity, the map's own behaviour through the delivered reference, and the
 * pass-through in both CLI sources.
 */
describe("CITATION_IDENTITY (shared staging harness)", () => {
  const frameOf = (labels) => ({ citations: labels.map((label) => ({ label })) });

  it("resolves a mapped pair of parallel chains to one identity, and nothing else", () => {
    const identity = CITATION_IDENTITY.identityOf("HR. Bukhari no. 191");
    expect(identity).not.toBeNull();
    // The map's own equivalence: 186 and 191 narrate the same report, so the
    // resolver answers the same identity for both — a plain identity function
    // (each label its own key) fails this.
    expect(CITATION_IDENTITY.identityOf("HR. Bukhari no. 186")).toBe(identity);
  });

  it("resolves a label outside the map to null — the fail-closed state", () => {
    expect(CITATION_IDENTITY.identityOf("HR. Bukhari no. 99999")).toBeNull();
  });

  it("delivers the identity from the real composition root, not only declares it", async () => {
    // Behavioural, through the harness's OWN reference: a dropped delivery is
    // `undefined`, and the scorer's documented no-identity degradation then
    // keeps the exact-label comparison and scores the parallel narration 0. The
    // URL is never dialled — `resolvePostgresStore` builds a lazy pool — and the
    // memoized pool is released below so the run does not leak a handle.
    const harness = await createStagingHarness(
      { databaseUrl: "postgres://unused:unused@127.0.0.1:1/unused" },
      {},
    );
    try {
      expect(harness.citationIdentity).toBe(CITATION_IDENTITY);
      const identity = harness.citationIdentity;
      const frame = frameOf(["HR. Bukhari no. 186"]);
      // The same evidence, with and without the delivery: only the delivered
      // resolver scores the parallel narration present.
      expect(
        citationValidity(["HR. Bukhari no. 191"], "", {
          frame,
          grammar: harness.citationGrammar,
          identity,
        }),
      ).toBe(1);
      expect(
        citationValidity(["HR. Bukhari no. 191"], "", { frame, grammar: harness.citationGrammar }),
      ).toBe(0);
      // A required label the map does not carry stays unmatched — the scorer
      // never guesses an identity for it.
      expect(
        citationValidity(["HR. Bukhari no. 99999"], "", {
          frame,
          grammar: harness.citationGrammar,
          identity,
        }),
      ).toBe(0);
    } finally {
      await disposePostgresPools();
    }
  });

  it("forwards the harness's identity into the scorer in both eval CLIs", () => {
    // The second half of the delivery: the harness can hold the identity and
    // both entry points still drop it on the floor. They are `#!/usr/bin/env
    // bun` scripts that connect to staging on import, so the pass-through is
    // pinned where it lives — the same instrument this file already uses for
    // the grammar and the refusal-marker drift between the two CLIs.
    for (const script of ["eval-run.mjs", "eval-smoke.mjs"]) {
      const source = readFileSync(resolve(process.cwd(), "packages/eval/scripts", script), "utf8");
      expect(source).toMatch(/citationIdentity:\s*harness\.citationIdentity,/);
    }
  });
});

/**
 * The smoke's coverage wiring. `selectSmokeSubset` enforces the required classes
 * and the held-out ids internally, but its caller is a `.mjs` entry typecheck
 * never sees: deleting the `requiredTags` argument would drop both product
 * classes, and deleting the `exclude` argument would sample the held-out cases
 * again, while every runtime suite stayed green — the selector's own tests pass
 * the arguments directly. The printed plan's held-out line must also come from
 * the selection, not a second copy of the caller's constant. The wiring is
 * therefore pinned in the source, the same instrument this file uses for the
 * citation-grammar pass-through.
 */
describe("the smoke's coverage wiring", () => {
  it("passes the coverage classes and the held-out ids to the selector", () => {
    const source = readFileSync(
      resolve(process.cwd(), "packages/eval/scripts/eval-smoke.mjs"),
      "utf8",
    );
    expect(source).toContain("requiredTags: SMOKE_COVERAGE_TAGS");
    expect(source).toContain("exclude: SMOKE_HELD_OUT_IDS");
    // One source of truth for the printed list: the selection, not the input.
    expect(source).toContain("formatSmokePlan(selection, fixture)");
    expect(source).not.toContain("SMOKE_HELD_OUT_IDS.join");
  });
});
