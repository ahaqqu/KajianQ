import { describe, expect, it } from "vite-plus/test";
import type { DecisionBenchRun, DecisionBenchRunRecord } from "@app/contracts";
import { renderDecisionBenchReport } from "./decision-bench-report";
import type { DecisionBenchSeal } from "./decision-bench-store";

const seal: DecisionBenchSeal = {
  task: "decision-bench",
  version: 1,
  created: "2026-11-13T23:04:04Z",
  fixture: { id: "decision-bench-v0", status: "v0-draft" },
  counts: { cases: 21, relevance: 12, rerank: 3, citation: 6 },
  languages: { ar: 7, en: 7, id: 7 },
  hashes: { cases: "sha256:830df54" },
  notes: ["The seal covers the case fixture only."],
};

const rec = (
  caseId: string,
  task: DecisionBenchRunRecord["task"],
  language: string,
  passed: boolean,
): DecisionBenchRunRecord => ({
  caseId,
  task,
  language,
  expected: true,
  got: passed ? 0.9 : 0.3,
  passed,
  cost: {
    modelId: "m",
    tokensIn: 100,
    tokensOut: 10,
    latencyMs: passed ? 40 : 80,
    costMicroUsd: 4,
  },
});

/**
 * A gate-passing arm: ar has its 3-case minimum all passing, the lone id
 * case is reported but under the floor's minimum, and overall is 100%.
 */
const PASSING_RECORDS = [
  rec("rel-ar-01", "relevance", "ar", true),
  rec("rel-ar-02", "relevance", "ar", true),
  rec("rel-ar-03", "relevance", "ar", true),
  rec("cit-id-01", "citation", "id", true),
];

/** A failing arm: one pass, one confident miss. */
const FAILING_RECORDS = [
  rec("rel-ar-01", "relevance", "ar", true),
  rec("cit-id-01", "citation", "id", false),
];

const runOf = (
  model: string,
  records: DecisionBenchRunRecord[],
  gatePass: boolean,
): DecisionBenchRun => {
  const passed = records.filter((r) => r.passed).length;
  const accuracy = passed / records.length;
  return {
    schema: 1,
    task: "decision-bench",
    model,
    samples: { version: 1, casesSha256: "sha256:830df54" },
    promptsSha256: "sha256:abc123",
    budget: { capMicroUsd: null, plannedCases: 21, totalMicroUsd: 16 },
    totals: { cases: 21, scored: records.length, passed, accuracy },
    gate: {
      gatePass,
      overallAccuracy: accuracy,
      failedLanguages: gatePass ? [] : ["id"],
      floors: { overall: 0.85, perLanguage: 0.75, minCasesPerLanguage: 3 },
    },
    startedAt: "2026-11-14T00:00:00.000Z",
    finishedAt: "2026-11-14T00:00:01.000Z",
    records,
  };
};

const render = (runs: DecisionBenchRun[], supersededCount = 0) =>
  renderDecisionBenchReport({
    seal,
    runs,
    runsDir: "benchmarks/decisions/runs",
    generatedAt: "2026-11-14T00:00:02.000Z",
    supersededCount,
  });

describe("decision-bench report", () => {
  it("an empty store renders the unmeasured state, honestly", () => {
    const md = render([]);
    expect(md).toContain("# Decision benchmark report");
    expect(md).toContain("never hand-edited");
    expect(md).toContain("overall ≥ 0.85 AND every language ≥ 0.75");
    expect(md).toContain("Seal **v1**");
    expect(md).toContain("12 relevance, 3 rerank, 6 citation");
    expect(md).toContain("ar (7), en (7), id (7)");
    expect(md).toContain("sha256:830df54");
    expect(md).toContain("The seal covers the case fixture only.");
    expect(md).toContain("No runs at the committed seal yet");
    expect(md).toContain("adding a model never re-runs the others");
    expect(md).toContain("No arm passes the gate at this seal.");
    expect(md).not.toContain("## Superseded");
  });

  it("arms are derived from records, not from the run's own totals", () => {
    const md = render([
      runOf("a/winner", PASSING_RECORDS, true),
      runOf("b/loser", FAILING_RECORDS, false),
    ]);
    expect(md).toContain("| `a/winner` |");
    expect(md).toContain("| `b/loser` |");
    expect(md).toContain("`benchmarks/decisions/runs/a-winner.json`");
    expect(md).toContain("| 4/21 |");
    expect(md).toContain("| 2/21 |");
    expect(md).toContain("| 100.0% |");
    expect(md).toContain("| 50.0% |");
    expect(md).toContain("ar 100.0% |");
    expect(md).toContain("id 0.0% |");
    expect(md).toContain("**pass** |");
    expect(md).toContain("**fail** |");
    expect(md).toContain("recomputed from each run's records");
    expect(md).toContain("16 µUSD total");
    expect(md).toContain("| 40 ms |");
    expect(md).toContain("Gate-passing arms at this seal: `a/winner`.");
  });

  it("an arm whose pinned gate disagrees with its records is flagged", () => {
    const md = render([runOf("a/liar", FAILING_RECORDS, true)]);
    expect(md).toContain("(pinned gate disagrees)");
    expect(md).toContain("No arm passes the gate at this seal.");
  });

  it("misses list every failed record with its expectation", () => {
    const md = render([runOf("b/loser", FAILING_RECORDS, false)]);
    expect(md).toContain("## Misses");
    expect(md).toContain("- `b/loser` (1):");
    expect(md).toContain("`citation/cit-id-01` (id): expected `true`, got `0.3`");
    const passing = render([runOf("a/winner", PASSING_RECORDS, true)]);
    expect(passing).toContain("`a/winner`: none.");
  });

  it("an aborted run is evidence, never a pass", () => {
    const aborted = {
      ...runOf("c/dead", FAILING_RECORDS.slice(0, 1), false),
      aborted: true,
      error: "vendor 500 on rel-ar-01",
    };
    const md = render([aborted]);
    expect(md).toContain("⚠ aborted (vendor 500 on rel-ar-01)");
    expect(md).toContain("No arm passes the gate at this seal.");
    expect(md).toContain("an arm that aborts is never a pass");
  });

  it("an aborted arm whose records would pass still never renders as a pass", () => {
    const aborted = {
      ...runOf("d/aborted", PASSING_RECORDS, true),
      aborted: true,
      error: "vendor 500",
    };
    const md = render([aborted]);
    expect(md).toContain("**abort** ⚠ aborted (vendor 500)");
    expect(md).not.toContain("**pass** ⚠ aborted");
  });

  it("the superseded history line renders when the archive is non-empty", () => {
    const md = render([], 1);
    expect(md).toContain("## Superseded");
    expect(md).toContain("1 frozen result(s)");
    expect(md).toContain("never scored");
  });
});
