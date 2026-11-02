/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  IndependentProbeLoadError,
  contentCheckPasses,
  foldProbeText,
  formatProbeRun,
  loadIndependentProbesJson,
  parseIndependentProbes,
  probeExitPolicy,
  runProbes,
  scoreProbe,
  type IndependentProbe,
  type IndependentProbeFixture,
} from "./independent-probes";
import type { CitationFrameLike, CitationGrammar } from "./harness-types";

/**
 * The independent probe suite is deterministic and model-free: a fixture of
 * known-answer questions, a citation check through the same reader the Golden Set
 * uses, a short content check, and a report. The structural test loads the real
 * fixture (naming none of its vocabulary); the behaviour tests use opaque labels.
 */

const FIXTURE_TEXT = readFileSync(
  new URL("../../../packages/kajianq-domain/fixtures/independent-probes-v1.json", import.meta.url),
  "utf8",
);

const GRAMMAR: CitationGrammar = {
  normalizeLabel: (label) => label.trim(),
  labelsInText: (text) => text.match(/L-\d+/g) ?? [],
  addressesNamedBy: (label) => [label],
};

const probe = (overrides: Partial<IndependentProbe> = {}): IndependentProbe => ({
  id: "probe-a",
  question: "ask a",
  language: "en",
  expectedCitations: ["L-1", "L-2"],
  expectedContent: [
    { label: "first", anyOf: ["alpha", "alef"] },
    { label: "second", anyOf: ["beta"] },
  ],
  ...overrides,
});

const frame = (...labels: string[]): CitationFrameLike => ({
  citations: labels.map((label) => ({ label })),
});

describe("independent probe fixture — structure", () => {
  it("loads the real fixture with unique probe ids and complete expectations", () => {
    const fixture = loadIndependentProbesJson(FIXTURE_TEXT, "independent-probes-v1.json");
    expect(fixture.id).toBe("independent-probes-v1");
    expect(fixture.probes).toHaveLength(5);
    expect(new Set(fixture.probes.map((p) => p.id)).size).toBe(5);
    for (const p of fixture.probes) {
      expect(p.question.trim()).not.toBe("");
      expect(p.language.trim()).not.toBe("");
      expect(p.expectedCitations.length).toBeGreaterThan(0);
      expect(p.expectedContent.length).toBeGreaterThan(0);
      for (const check of p.expectedContent) {
        expect(check.label.trim()).not.toBe("");
        expect(check.anyOf.length).toBeGreaterThan(0);
      }
    }
  });

  it("keeps the suite separate from a Golden Set: no question-set fields", () => {
    const raw = JSON.parse(FIXTURE_TEXT) as Record<string, unknown>;
    expect(raw.questions).toBeUndefined();
    expect(raw.status).toBeUndefined();
    expect(Array.isArray(raw.probes)).toBe(true);
  });

  it("rejects a duplicate probe id at the load boundary", () => {
    const raw = JSON.parse(FIXTURE_TEXT) as { id: string; probes: IndependentProbe[] };
    raw.probes.push(raw.probes[0]!);
    expect(() => parseIndependentProbes(raw, "duplicate.json")).toThrow(IndependentProbeLoadError);
    expect(() => parseIndependentProbes(raw, "duplicate.json")).toThrow(/unique/);
  });

  it("rejects a probe with no expected citation or no content check", () => {
    const fixture = (extra: Record<string, unknown>) => ({
      id: "set",
      probes: [{ ...probe(), ...extra }],
    });
    expect(() => parseIndependentProbes(fixture({ expectedCitations: [] }))).toThrow(
      IndependentProbeLoadError,
    );
    expect(() => parseIndependentProbes(fixture({ expectedContent: [] }))).toThrow(
      IndependentProbeLoadError,
    );
    expect(() => parseIndependentProbes(fixture({ language: "" }))).toThrow(
      IndependentProbeLoadError,
    );
  });

  it("rejects a language the chat client cannot ask in instead of coercing it", () => {
    const fixture = (language: string) => ({ id: "set", probes: [{ ...probe(), language }] });
    // The schema is the client's own union: `en-US`, `ar` and typos fail the load
    // with the field named, rather than being silently asked in Indonesian.
    for (const language of ["en-US", "ar", "EN", "idd"]) {
      expect(() => parseIndependentProbes(fixture(language))).toThrow(/language/);
    }
    // Both accepted values pass through unchanged — no coercion at the boundary.
    expect(parseIndependentProbes(fixture("en")).probes[0]?.language).toBe("en");
    expect(parseIndependentProbes(fixture("id")).probes[0]?.language).toBe("id");
  });

  it("rejects an empty anyOf term list", () => {
    const checks = [{ label: "first", anyOf: [] }];
    expect(() =>
      parseIndependentProbes({ id: "set", probes: [{ ...probe(), expectedContent: checks }] }),
    ).toThrow(IndependentProbeLoadError);
  });
});

describe("foldProbeText — generic Unicode fold", () => {
  it("folds case, diacritics and punctuation to single-spaced words", () => {
    expect(foldProbeText("  Café,  CAFÉ! ")).toBe("cafe cafe");
    expect(foldProbeText("alpha...beta")).toBe("alpha beta");
  });
});

describe("contentCheckPasses — whole-word and phrase checks", () => {
  it("matches a term case- and diacritic-insensitively", () => {
    expect(contentCheckPasses({ label: "x", anyOf: ["café"] }, "Cafe au lait")).toBe(true);
  });

  it("satisfies the check when any one alternative appears", () => {
    expect(contentCheckPasses({ label: "x", anyOf: ["gamma", "beta"] }, "alpha beta")).toBe(true);
  });

  it("does not match inside a longer word", () => {
    expect(contentCheckPasses({ label: "x", anyOf: ["amal"] }, "amalan")).toBe(false);
  });

  it("matches a multi-word phrase only as a contiguous run", () => {
    expect(contentCheckPasses({ label: "x", anyOf: ["orang tua"] }, "kepada orang tua")).toBe(true);
    expect(contentCheckPasses({ label: "x", anyOf: ["orang tua"] }, "orang dan tua")).toBe(false);
  });

  it("fails when the term is absent", () => {
    expect(contentCheckPasses({ label: "x", anyOf: ["gamma"] }, "alpha beta")).toBe(false);
  });
});

describe("scoreProbe — pass/fail, length, citation count", () => {
  it("passes when every expected citation is grounded and every content check matches", () => {
    const outcome = scoreProbe(
      probe(),
      { text: "alpha beta cites L-1 and L-2", citations: frame("L-1", "L-2", "L-9") },
      GRAMMAR,
    );
    expect(outcome).toMatchObject({
      probeId: "probe-a",
      passed: true,
      answerChars: 28,
      citationCount: 3,
      missingCitations: [],
    });
    expect(outcome.contentChecks).toEqual([
      { label: "first", passed: true },
      { label: "second", passed: true },
    ]);
  });

  it("fails and names only the missing citation", () => {
    const outcome = scoreProbe(
      probe(),
      { text: "alpha beta cites L-1", citations: frame("L-1") },
      GRAMMAR,
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.missingCitations).toEqual(["L-2"]);
  });

  it("fails and names the failed content check", () => {
    const outcome = scoreProbe(probe(), { text: "alpha", citations: frame("L-1", "L-2") }, GRAMMAR);
    expect(outcome.passed).toBe(false);
    expect(outcome.contentChecks).toEqual([
      { label: "first", passed: true },
      { label: "second", passed: false },
    ]);
  });

  it("keeps an empty answer a measured zero, not an absent measurement", () => {
    const outcome = scoreProbe(probe(), { text: "", citations: frame() }, GRAMMAR);
    expect(outcome.passed).toBe(false);
    expect(outcome.answerChars).toBe(0);
    expect(outcome.citationCount).toBe(0);
  });
});

describe("runProbes — one verdict per probe, transport failures contained", () => {
  const fixture: IndependentProbeFixture = {
    id: "set",
    probes: [probe({ id: "p1" }), probe({ id: "p2" }), probe({ id: "p3" })],
  };

  it("keeps going after a failed ask and reports exactly one outcome per probe", async () => {
    const outcomes = await runProbes(
      fixture,
      async (p) => {
        if (p.id === "p2") throw new Error("transport down");
        return { text: "alpha beta L-1 L-2", citations: frame("L-1", "L-2") };
      },
      GRAMMAR,
    );
    expect(outcomes.map((o) => [o.probeId, o.passed])).toEqual([
      ["p1", true],
      ["p2", false],
      ["p3", true],
    ]);
    // A failed call read no answer: its figures are absent, not zero, and the cause
    // is carried rather than a fabricated miss.
    expect(outcomes[1]).toMatchObject({
      answerChars: null,
      citationCount: null,
      missingCitations: [],
      contentChecks: [],
      error: "transport down",
    });
  });
});

describe("formatProbeRun / probeExitPolicy — the run report", () => {
  const fixture: IndependentProbeFixture = {
    id: "set",
    probes: [probe({ id: "p1" }), probe({ id: "p2" })],
  };

  it("prints pass/fail with answer length and citation count, and the failure evidence", async () => {
    const outcomes = await runProbes(
      fixture,
      async (p) =>
        p.id === "p1"
          ? { text: "alpha beta L-1 L-2", citations: frame("L-1", "L-2") }
          : { text: "alpha only", citations: frame("L-1") },
      GRAMMAR,
    );
    const lines = formatProbeRun(fixture, outcomes);
    expect(lines[0]).toContain("set");
    expect(lines[0]).toContain("2 independent probes");
    expect(lines[1]).toContain("PASS p1 [en]");
    expect(lines[1]).toContain("18 chars, 2 citations");
    expect(lines[2]).toContain("FAIL p2 [en]");
    expect(lines[2]).toContain("10 chars, 1 citation");
    expect(lines[2]).toContain("missing citations: L-2");
    expect(lines[2]).toContain("content: 1/2 checks (failed: second)");
    expect(lines[3]).toBe("eval:probes: 1 passed, 1 failed");
  });

  it("reports a transport failure as the probe's cause, not as a missing citation", async () => {
    const outcomes = await runProbes(fixture, async () => {
      throw new Error("socket closed");
    });
    const lines = formatProbeRun(fixture, outcomes);
    expect(lines[1]).toContain("FAIL p1 [en] — error: socket closed");
    expect(lines[1]).not.toContain("missing citations");
  });

  it("passes the exit policy only when every probe in the fixture passed", async () => {
    const allPass = await runProbes(
      fixture,
      async () => ({ text: "alpha beta L-1 L-2", citations: frame("L-1", "L-2") }),
      GRAMMAR,
    );
    expect(probeExitPolicy(fixture, allPass)).toEqual({
      ok: true,
      message: "eval:probes: PASSED",
    });

    const oneFails = await runProbes(
      fixture,
      async (p) =>
        p.id === "p1"
          ? { text: "alpha beta L-1 L-2", citations: frame("L-1", "L-2") }
          : { text: "alpha beta", citations: frame() },
      GRAMMAR,
    );
    expect(probeExitPolicy(fixture, oneFails)).toEqual({
      ok: false,
      message: "eval:probes: FAILED — p2",
    });
  });

  it("reddens on a truncated outcome list, naming the probes that never ran", async () => {
    const allPass = await runProbes(
      fixture,
      async () => ({ text: "alpha beta L-1 L-2", citations: frame("L-1", "L-2") }),
      GRAMMAR,
    );
    // A run that lost an outcome is not a pass: the fixture is the expected
    // enumeration, and the missing probe is named rather than silently dropped.
    expect(probeExitPolicy(fixture, allPass.slice(0, 1))).toEqual({
      ok: false,
      message: "eval:probes: FAILED — p2 (no outcome recorded)",
    });
    expect(probeExitPolicy(fixture, [])).toEqual({
      ok: false,
      message: "eval:probes: FAILED — p1 (no outcome recorded); p2 (no outcome recorded)",
    });
  });

  it("prints a measured-zero citation count and an unmeasured one differently", async () => {
    const measuredZero = await runProbes(
      fixture,
      async () => ({ text: "alpha beta L-1 L-2", citations: frame() }),
      GRAMMAR,
    );
    expect(formatProbeRun(fixture, measuredZero)[1]).toContain("0 citations");

    // No frame and no grammar: the count was never measured, so the line says so
    // rather than printing a zero the answer did not earn.
    const unmeasured = await runProbes(fixture, async () => ({
      text: "alpha beta L-1 L-2",
      citations: null,
    }));
    expect(formatProbeRun(fixture, unmeasured)[1]).toContain("citations unmeasured");
  });
});

describe("the real fixture scores offline", () => {
  it("passes every probe from its own expected citations and first content terms", () => {
    const fixture = loadIndependentProbesJson(FIXTURE_TEXT, "independent-probes-v1.json");
    for (const p of fixture.probes) {
      // A synthetic answer that names the fixture's own expectations: this proves
      // the fixture is scorable end to end without a model call, not that a real
      // model answer would match.
      const text = [
        ...p.expectedCitations,
        ...p.expectedContent.map((check) => check.anyOf[0]),
      ].join(" ");
      const answer = {
        text,
        citations: frame(...p.expectedCitations),
      };
      const outcome = scoreProbe(p, answer, {
        normalizeLabel: (label) => label.trim(),
        labelsInText: () => [],
        addressesNamedBy: (label) => [label],
      });
      expect({ id: p.id, passed: outcome.passed, missing: outcome.missingCitations }).toEqual({
        id: p.id,
        passed: true,
        missing: [],
      });
      expect(outcome.answerChars).toBeGreaterThan(0);
      expect(outcome.citationCount).toBeGreaterThanOrEqual(p.expectedCitations.length);
    }
  });
});
