import { describe, expect, it } from "vite-plus/test";
import {
  embedDirectionStats,
  embedExpansionAccuracy,
  type EmbedBenchRun,
  type EmbedBenchRunRecord,
} from "@app/contracts";
import { renderEmbedBenchReport } from "./embed-bench-report";
import type { EmbedBenchSeal } from "./embed-bench-store";

const seal: EmbedBenchSeal = {
  task: "embed-bench",
  version: 1,
  created: "2026-11-14T07:05:00Z",
  fixtures: {
    probes: { id: "embed-bench-probes-v0", status: "canonical" },
    expansion: { id: "expansion-cases-v0", status: "canonical" },
  },
  counts: { crossLingual: 200, monolingual: 200, expansion: 12 },
  hashes: { probes: "sha256:826bfc0d", expansion: "sha256:98efedc5" },
  fingerprints: { corpus: "fnv1a64:abcd:1500" },
  notes: ["The corpus fingerprint is the probe fixture's own pin."],
};

const rec = (
  probeId: string,
  direction: EmbedBenchRunRecord["direction"],
  passed: boolean,
  over: Partial<EmbedBenchRunRecord> = {},
): EmbedBenchRunRecord => ({
  probeId,
  direction,
  expected: direction === "expansion" ? "term-a" : ["d1", "d2"],
  got: passed ? ["d1", "d2", "d3"] : ["d3", "d4"],
  passed,
  ...over,
});

/** A gate-passing arm: full recall in both gate directions + a clean expansion. */
const PASSING_RECORDS: EmbedBenchRunRecord[] = [
  rec("xl-1", "secondary→primary", true),
  rec("pp-1", "primary→primary", true),
  rec("exp-1", "expansion", true),
];

/** A failing arm: its cross-lingual direction sits below the floor, plus one expansion miss. */
const FAILING_RECORDS: EmbedBenchRunRecord[] = [
  rec("xl-1", "secondary→primary", false, { got: ["d1", "d3"] }),
  rec("xl-2", "secondary→primary", false, { got: ["d3", "d4"] }),
  rec("pp-1", "primary→primary", true),
  rec("exp-1", "expansion", true),
  rec("exp-2", "expansion", false, { expected: "term-b", got: ["term-c"] }),
];

const runOf = (model: string, records: EmbedBenchRunRecord[], gatePass: boolean): EmbedBenchRun => {
  const stats = embedDirectionStats(records);
  const failedDirections = Object.entries({
    "secondary→primary": 0.7,
    "primary→primary": 0.75,
  })
    .filter(([d, floor]) => (stats[d]?.recallAt10 ?? 0) < floor)
    .map(([d]) => d);
  return {
    schema: 1,
    task: "embed-bench",
    model,
    samples: {
      version: 1,
      probesSha256: "sha256:826bfc0d",
      expansionSha256: "sha256:98efedc5",
      corpusFingerprint: "fnv1a64:abcd:1500",
    },
    budget: { capMicroUsd: null, plannedCalls: 9, totalMicroUsd: 6 },
    totals: {
      probes: Object.fromEntries(Object.entries(stats).map(([d, s]) => [d, s.probes])),
      recallAt10: Object.fromEntries(Object.entries(stats).map(([d, s]) => [d, s.recallAt10])),
      mrr: Object.fromEntries(Object.entries(stats).map(([d, s]) => [d, s.mrr])),
      expansionAccuracy: embedExpansionAccuracy(records),
    },
    gate: {
      gatePass,
      failedDirections: gatePass ? [] : failedDirections,
      floors: { crossLingual: 0.7, monolingual: 0.75 },
    },
    startedAt: "2026-11-14T00:00:00.000Z",
    finishedAt: "2026-11-14T00:00:01.000Z",
    records,
  };
};

const render = (runs: EmbedBenchRun[], supersededCount = 0) =>
  renderEmbedBenchReport({
    seal,
    runs,
    runsDir: "benchmarks/embeddings/runs",
    generatedAt: "2026-11-14T00:00:02.000Z",
    supersededCount,
  });

describe("embed-bench report", () => {
  it("an empty store renders the unmeasured state, honestly", () => {
    const md = render([]);
    expect(md).toContain("# Embedding benchmark report");
    expect(md).toContain("never hand-edited");
    expect(md).toContain("recall@10 ≥ 0.7 AND monolingual `primary→primary` recall@10 ≥ 0.75");
    expect(md).toContain("Seal **v1**");
    expect(md).toContain("200 cross-lingual, 200 monolingual");
    expect(md).toContain("**12** expansion cases");
    expect(md).toContain("`embed-bench-probes-v0` (canonical)");
    expect(md).toContain("sha256:826bfc0d");
    expect(md).toContain("fnv1a64:abcd:1500");
    expect(md).toContain("The corpus fingerprint is the probe fixture's own pin.");
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
    expect(md).toContain("`benchmarks/embeddings/runs/a-winner.json`");
    // Full recall renders with its MRR; the failing direction shows 25% (0.500).
    expect(md).toContain("100.0% (1.000)");
    expect(md).toContain("25.0% (0.500)");
    // The expansion cell is the mean pass rate over the run's expansion records.
    expect(md).toContain("| 100.0% |");
    expect(md).toContain("| 50.0% |");
    expect(md).toContain("**pass** |");
    expect(md).toContain("**fail** |");
    expect(md).toContain("recomputed from each run's records");
    expect(md).toContain("6 µUSD");
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
    expect(md).toContain("- `b/loser` (3):");
    expect(md).toContain("`secondary→primary/xl-1`: expected `d1, d2`, got `d1, d3`");
    expect(md).toContain("`secondary→primary/xl-2`: expected `d1, d2`, got `d3, d4`");
    expect(md).toContain("`expansion/exp-2`: expected `term-b`, got `term-c`");
    const passing = render([runOf("a/winner", PASSING_RECORDS, true)]);
    expect(passing).toContain("`a/winner`: none.");
  });

  it("an aborted run is evidence, never a pass", () => {
    const aborted = {
      ...runOf("c/dead", [rec("xl-1", "secondary→primary", true)], false),
      aborted: true,
      error: "budget cap exceeded",
    };
    const md = render([aborted]);
    expect(md).toContain("⚠ aborted (budget cap exceeded)");
    expect(md).toContain("No arm passes the gate at this seal.");
    expect(md).toContain("an arm that aborts is never a pass");
  });

  it("the superseded history line renders when the archive is non-empty", () => {
    const md = render([], 1);
    expect(md).toContain("## Superseded");
    expect(md).toContain("1 frozen result(s)");
    expect(md).toContain("never scored");
  });
});
