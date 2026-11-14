import {
  parseSummarizerBenchRun,
  type SummarizerBenchFixture,
  type SummarizerBenchRun,
} from "@app/contracts";
import {
  assertSealCount,
  assertSealHash,
  BenchStoreError,
  benchFail,
  benchRunFilePath,
  benchRunSlug,
  countSupersededResults,
  loadBenchRuns,
  readBenchSeal,
  sha256Text,
  staleSamplesReason,
  writeBenchRun,
} from "./bench-store";

/**
 * The summarizer-bench store: the same append-only discipline as the other
 * bench stores — a run file is written once (an overwrite is refused
 * without force), every run pins the samples seal it measured, and loading
 * refuses any run whose pin does not match the committed seal. The run-file
 * mechanics and the seal checks are the shared bench-store helpers; what is
 * summarizer-specific is the seal and the pins it hands out.
 */

export { BenchStoreError as SummarizerBenchStoreError };

const fail = benchFail("summarizer-bench store");

/** The samples seal (`benchmarks/summarization/samples/version.json`). */
export type SummarizerBenchSeal = {
  task: string;
  version: number;
  created: string;
  fixture: { id: string; status: string };
  counts: { cases: number };
  languages: Record<string, number>;
  hashes: { cases: string };
  notes?: string[];
};

export function summarizerBenchRunFilePath(runsDir: string, modelId: string): string {
  return benchRunFilePath(runsDir, modelId, fail);
}

export function summarizerBenchRunSlug(modelId: string): string {
  return benchRunSlug(modelId, fail);
}

/**
 * Write one run file. Refuses an existing file without `force` — the one
 * documented escape hatch, for a deliberate re-run that replaces its own
 * committed measurement in the same PR that says so.
 */
export function writeSummarizerBenchRun(
  runsDir: string,
  run: SummarizerBenchRun,
  opts: { force?: boolean } = {},
): string {
  return writeBenchRun(runsDir, run, opts, fail);
}

/**
 * The seal, verified against the case bytes it claims to cover: the hash
 * must match the file on disk and the counts must match the parsed fixture
 * — a seal that disagrees with its own samples fails here, before any
 * spend, not in the report.
 */
export function loadSummarizerBenchSeal(
  sealPath: string,
  casesPath: string,
  fixture: SummarizerBenchFixture,
): SummarizerBenchSeal {
  const seal = readBenchSeal<SummarizerBenchSeal>({ sealPath, task: "summarizer-bench", fail });
  assertSealHash({
    fail,
    sealPath,
    name: "cases",
    pinned: seal.hashes?.cases,
    path: casesPath,
    actualLabel: "cases.json",
  });
  assertSealCount({
    fail,
    sealPath,
    name: "cases",
    pinned: seal.counts?.cases,
    actual: fixture.cases.length,
    unit: " cases",
  });
  return seal;
}

/** The samples pin every run at this seal must carry. */
export function summarizerBenchSamplesPin(
  seal: SummarizerBenchSeal,
): SummarizerBenchRun["samples"] {
  return { version: seal.version, casesSha256: seal.hashes.cases };
}

/** All committed runs in file-name order, each parsed and pin-checked. */
export function loadSummarizerBenchRuns(
  runsDir: string,
  seal: SummarizerBenchSeal,
): SummarizerBenchRun[] {
  const pin = summarizerBenchSamplesPin(seal);
  return loadBenchRuns({
    runsDir,
    fail,
    parse: parseSummarizerBenchRun,
    staleReason: (run) => staleSamplesReason(run.samples, pin),
  });
}

/** The prompts pin a run carries: the sha256 of the summarizer wording identity. */
export function summarizerBenchPromptsPin(identity: string): string {
  return sha256Text(identity);
}

export { countSupersededResults };
