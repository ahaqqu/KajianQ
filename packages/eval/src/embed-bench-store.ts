import {
  EMBED_BENCH_GATE_FLOOR_KEY,
  embedDirectionStats,
  embedExpansionAccuracy,
  parseEmbedBenchRun,
  type CostRecord,
  type EmbedBenchRun,
  type EmbedBenchRunRecord,
  type EmbedDirectionStats,
} from "@app/contracts";
import {
  assertSealCount,
  assertSealHash,
  BenchStoreError,
  benchFail,
  benchRunFilePath,
  benchRunSlug,
  loadBenchRuns,
  readBenchSeal,
  writeBenchRun,
} from "./bench-store";
import type { BenchCell } from "./embed-bench";
import type { BenchProbeSet, ExpansionCaseSet } from "./embed-bench-fixtures";

/**
 * The embed-bench store (issue #9, ADR-0013/0014/0036): the append-only run
 * files and the samples seal under `benchmarks/embeddings/`, on the same
 * invariants as the decision-bench store — a run file is written once and an
 * overwrite is refused without force; every run pins the samples seal
 * (version + probe/expansion hashes + corpus fingerprint) it measured; and
 * loading refuses any run whose pin does not match the committed seal, so a
 * run measured against different bytes than the committed samples is stale
 * evidence, loudly. The run-file mechanics are the shared bench-store
 * helpers; what is embed-specific is the seal and the pins it hands out.
 */

export { BenchStoreError as EmbedBenchStoreError };

const fail = benchFail("embed-bench store");

/** The samples seal (`benchmarks/embeddings/samples/version.json`). */
export type EmbedBenchSeal = {
  task: string;
  version: number;
  created: string;
  fixtures: {
    probes: { id: string; status: string };
    expansion: { id: string; status: string };
  };
  counts: { crossLingual: number; monolingual: number; expansion: number };
  hashes: { probes: string; expansion: string };
  fingerprints: { corpus: string };
  notes?: string[];
};

/** The run file name for a candidate: the model id, slugified once. */
export function embedBenchRunSlug(modelId: string): string {
  return benchRunSlug(modelId, fail);
}

export function embedBenchRunFilePath(runsDir: string, modelId: string): string {
  return benchRunFilePath(runsDir, modelId, fail);
}

/**
 * Write one run file. Refuses an existing file without `force` — the one
 * documented escape hatch, for a deliberate re-run that replaces its own
 * committed measurement in the same PR that says so.
 */
export function writeEmbedBenchRun(
  runsDir: string,
  run: EmbedBenchRun,
  opts: { force?: boolean } = {},
): string {
  return writeBenchRun(runsDir, run, opts, fail);
}

/**
 * The seal, verified against the sample bytes it claims to cover: both
 * hashes must match the files on disk, the corpus fingerprint must be the
 * probe fixture's own pin, and the counts must match the parsed fixtures —
 * a seal that disagrees with its own samples fails here, before any spend,
 * not in the report.
 */
export function loadEmbedBenchSeal(
  sealPath: string,
  probesPath: string,
  expansionPath: string,
  probes: BenchProbeSet,
  expansion: ExpansionCaseSet,
): EmbedBenchSeal {
  const seal = readBenchSeal<EmbedBenchSeal>({ sealPath, task: "embed-bench", fail });
  for (const [name, pinned, path] of [
    ["probes", seal.hashes?.probes, probesPath],
    ["expansion", seal.hashes?.expansion, expansionPath],
  ] as const) {
    assertSealHash({ fail, sealPath, name, pinned, path, actualLabel: path });
  }
  if (seal.fingerprints?.corpus !== probes.corpusFingerprint) {
    throw fail(
      sealPath,
      `corpus fingerprint mismatch: seal pins ${seal.fingerprints?.corpus ?? "nothing"}, the probe fixture pins ${probes.corpusFingerprint} — re-seal before running`,
    );
  }
  for (const [name, pinned, actual] of [
    ["crossLingual", seal.counts?.crossLingual, probes.crossLingual.length],
    ["monolingual", seal.counts?.monolingual, probes.monolingual.length],
    ["expansion", seal.counts?.expansion, expansion.cases.length],
  ] as const) {
    assertSealCount({ fail, sealPath, name, pinned, actual, unit: "" });
  }
  return seal;
}

/** The samples pin every run at this seal must carry. */
export function embedBenchSamplesPin(seal: EmbedBenchSeal): EmbedBenchRun["samples"] {
  return {
    version: seal.version,
    probesSha256: seal.hashes.probes,
    expansionSha256: seal.hashes.expansion,
    corpusFingerprint: seal.fingerprints.corpus,
  };
}

/** All committed runs in file-name order, each parsed and pin-checked. */
export function loadEmbedBenchRuns(runsDir: string, seal: EmbedBenchSeal): EmbedBenchRun[] {
  return loadBenchRuns({
    runsDir,
    fail,
    parse: parseEmbedBenchRun,
    staleReason: (run) => {
      const s = run.samples;
      const stale =
        s.version !== seal.version ||
        s.probesSha256 !== seal.hashes.probes ||
        s.expansionSha256 !== seal.hashes.expansion ||
        s.corpusFingerprint !== seal.fingerprints.corpus;
      return stale
        ? `run pins samples v${s.version} (probes ${s.probesSha256.slice(0, 20)}…) but the committed seal is v${seal.version} — archive it under superseded/ or re-run at the current seal`
        : null;
    },
  });
}

/** One expansion case result as the runner returns it (its call's cost attached). */
type ExpansionArmResult = {
  caseId: string;
  correct: boolean;
  picked: readonly string[];
  expectedTerm: string;
  cost?: CostRecord;
};

/**
 * Assemble one candidate arm's run record — the run file's whole body. Each
 * cell's per-probe evidence becomes the retrieval records and the expansion
 * results become the expansion records; the totals and the gate verdict then
 * derive from those records through the same contracts helpers the parse
 * checks use, so a written run file can never disagree with itself. A named
 * `failure` marks the arm aborted — an aborted arm keeps its partial records
 * and is never a pass.
 */
export function buildEmbedBenchRun(opts: {
  model: string;
  startedAt: string;
  samples: EmbedBenchRun["samples"];
  budget: { capMicroUsd: number | null; plannedCalls?: number; totalMicroUsd: number };
  floors: EmbedBenchRun["gate"]["floors"];
  cells: readonly BenchCell[];
  expansionResults: readonly ExpansionArmResult[];
  failure?: string;
}): EmbedBenchRun {
  const records: EmbedBenchRunRecord[] = [
    ...opts.cells.flatMap((cell) =>
      cell.probeOutcomes.map((p): EmbedBenchRunRecord => ({
        probeId: p.queryId,
        direction: cell.direction,
        expected: [...p.expectedIds],
        got: [...p.rankedTopK],
        passed: p.passed,
      })),
    ),
    ...opts.expansionResults.map((r): EmbedBenchRunRecord => ({
      probeId: r.caseId,
      direction: "expansion",
      expected: r.expectedTerm,
      got: [...r.picked],
      passed: r.correct,
      ...(r.cost ? { cost: r.cost } : {}),
    })),
  ];
  const stats = embedDirectionStats(records);
  const pick = <K extends "probes" | "recallAt10" | "mrr">(key: K) =>
    Object.fromEntries(Object.entries(stats).map(([d, s]) => [d, s[key]])) as Record<
      string,
      EmbedDirectionStats[K]
    >;
  const failedDirections = Object.entries(EMBED_BENCH_GATE_FLOOR_KEY)
    .filter(([direction, floorKey]) => (stats[direction]?.recallAt10 ?? 0) < opts.floors[floorKey])
    .map(([direction]) => direction);
  return {
    schema: 1,
    task: "embed-bench",
    model: opts.model,
    samples: opts.samples,
    budget: {
      capMicroUsd: opts.budget.capMicroUsd,
      plannedCalls: opts.budget.plannedCalls,
      totalMicroUsd: opts.budget.totalMicroUsd,
    },
    totals: {
      probes: pick("probes"),
      recallAt10: pick("recallAt10"),
      mrr: pick("mrr"),
      expansionAccuracy: embedExpansionAccuracy(records),
    },
    gate: {
      gatePass: failedDirections.length === 0,
      failedDirections,
      floors: opts.floors,
    },
    ...(opts.failure ? { aborted: true, error: opts.failure } : {}),
    startedAt: opts.startedAt,
    finishedAt: new Date().toISOString(),
    records,
  };
}
