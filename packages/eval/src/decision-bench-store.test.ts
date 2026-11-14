import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { parseDecisionBenchRun, type DecisionBenchRun } from "@app/contracts";
import { loadDecisionBenchFixtureJson } from "./decision-bench-config";
import {
  countSupersededResults,
  decisionBenchPromptsPin,
  decisionBenchRunFilePath,
  decisionBenchRunSlug,
  loadDecisionBenchRuns,
  loadDecisionBenchSeal,
  writeDecisionBenchRun,
} from "./decision-bench-store";

const CASES_PATH = fileURLToPath(
  new URL("../../../benchmarks/decisions/samples/cases.json", import.meta.url),
);
const SEAL_PATH = fileURLToPath(
  new URL("../../../benchmarks/decisions/samples/version.json", import.meta.url),
);

/** A minimal self-consistent run for one arm, overridable per test. */
const runOf = (model: string, over: Partial<DecisionBenchRun> = {}): DecisionBenchRun => ({
  schema: 1,
  task: "decision-bench",
  model,
  samples: { version: 1, casesSha256: "sha256:830df54" },
  promptsSha256: "sha256:abc123",
  budget: { capMicroUsd: null, plannedCases: 3, totalMicroUsd: 5 },
  totals: { cases: 3, scored: 2, passed: 1, accuracy: 0.5 },
  gate: {
    gatePass: false,
    overallAccuracy: 0.5,
    failedLanguages: ["ar"],
    floors: { overall: 0.85, perLanguage: 0.75, minCasesPerLanguage: 3 },
  },
  startedAt: "2026-11-14T00:00:00.000Z",
  finishedAt: "2026-11-14T00:00:01.000Z",
  records: [
    {
      caseId: "rel-ar-01",
      task: "relevance",
      language: "ar",
      expected: true,
      got: 0.9,
      passed: true,
      cost: { modelId: model, tokensIn: 100, tokensOut: 10, latencyMs: 50, costMicroUsd: 5 },
    },
    {
      caseId: "rr-ar-01",
      task: "rerank",
      language: "ar",
      expected: "c0",
      got: "c1",
      passed: false,
    },
  ],
  ...over,
});

describe("decision-bench store — the committed seal", () => {
  const fixture = loadDecisionBenchFixtureJson(readFileSync(CASES_PATH, "utf8"), CASES_PATH);

  it("the committed seal verifies against the committed case bytes", () => {
    const seal = loadDecisionBenchSeal(SEAL_PATH, CASES_PATH, fixture);
    expect(seal.version).toBe(1);
    expect(seal.task).toBe("decision-bench");
    expect(seal.counts.cases).toBe(21);
    expect(seal.fixture.id).toBe("decision-bench-v0");
  });

  it("cases bytes that no longer match the seal fail before any spend", () => {
    const dir = mkdtempSync(join(tmpdir(), "decision-bench-store-"));
    try {
      const tampered = join(dir, "cases.json");
      writeFileSync(tampered, readFileSync(CASES_PATH, "utf8").replace("v0-draft", "v0-draf"));
      expect(() => loadDecisionBenchSeal(SEAL_PATH, tampered, fixture)).toThrow(
        /cases hash mismatch.*re-seal before running/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("decision-bench store — run files", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "decision-bench-runs-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("slugifies a config row id once, slashes and tildes included", () => {
    expect(decisionBenchRunSlug("~acme/score-latest")).toBe("acme-score-latest");
    expect(decisionBenchRunSlug("acme/score-v1.3")).toBe("acme-score-v1-3");
    expect(decisionBenchRunFilePath("/runs", "~acme/score-latest")).toBe(
      join("/runs", "acme-score-latest.json"),
    );
  });

  it("writes a run once, refuses an overwrite without force, replaces with it", () => {
    writeDecisionBenchRun(dir, runOf("a/one"));
    expect(readFileSync(decisionBenchRunFilePath(dir, "a/one"), "utf8")).toMatch(/"a\/one"/);
    expect(() => writeDecisionBenchRun(dir, runOf("a/one"))).toThrow(/already exists.*--force/);
    writeDecisionBenchRun(dir, runOf("a/one", { promptsSha256: "sha256:re-run" }), { force: true });
    expect(readFileSync(decisionBenchRunFilePath(dir, "a/one"), "utf8")).toContain("re-run");
  });

  it("loads committed runs in file-name order and refuses a stale samples pin", () => {
    writeDecisionBenchRun(dir, runOf("b/two"));
    writeDecisionBenchRun(dir, runOf("a/one"));
    const seal = {
      task: "decision-bench",
      version: 1,
      created: "2026-11-13T23:04:04Z",
      fixture: { id: "decision-bench-v0", status: "v0-draft" },
      counts: { cases: 21, relevance: 12, rerank: 3, citation: 6 },
      languages: { ar: 7, en: 7, id: 7 },
      hashes: { cases: "sha256:830df54" },
    };
    const runs = loadDecisionBenchRuns(dir, seal);
    expect(runs.map((r) => r.model)).toEqual(["a/one", "b/two"]);
    writeDecisionBenchRun(
      dir,
      runOf("c/stale", { samples: { version: 2, casesSha256: "sha256:different-bytes" } }),
      { force: true },
    );
    expect(() => loadDecisionBenchRuns(dir, seal)).toThrow(
      /pins samples v2.*archive it under superseded/,
    );
  });

  it("refuses a run whose totals disagree with its own records", () => {
    const drifted = runOf("a/one", { totals: { cases: 3, scored: 2, passed: 2, accuracy: 1 } });
    expect(() => parseDecisionBenchRun(drifted)).toThrow(
      /totals\.passed 2 does not match the 1 passing/,
    );
    const overstated = runOf("a/one", {
      totals: { cases: 3, scored: 5, passed: 1, accuracy: 0.5 },
    });
    expect(() => parseDecisionBenchRun(overstated)).toThrow(/scored 5 cases exceeds/);
    const abortedSilently = runOf("a/one", { aborted: true });
    expect(() => parseDecisionBenchRun(abortedSilently)).toThrow(
      /aborted without an error message/,
    );
    const errorWithoutAbort = runOf("a/one", { error: "vendor 500" });
    expect(() => parseDecisionBenchRun(errorWithoutAbort)).toThrow(
      /carries an error but is not aborted/,
    );
  });

  it("the prompts pin is a deterministic sha256 of the identity string", () => {
    expect(decisionBenchPromptsPin("wording")).toBe(decisionBenchPromptsPin("wording"));
    expect(decisionBenchPromptsPin("wording")).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(decisionBenchPromptsPin("wording")).not.toBe(decisionBenchPromptsPin("wording v2"));
  });

  it("counts superseded results in nested archive directories", () => {
    expect(countSupersededResults(dir)).toBe(0);
    const nested = join(dir, "superseded", "pre-seal");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(dir, "superseded", "history.json"), "{}");
    writeFileSync(join(nested, "old-run.json"), "{}");
    expect(countSupersededResults(dir)).toBe(2);
  });
});
