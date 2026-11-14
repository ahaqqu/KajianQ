import {
  parseDecisionBenchRun,
  type DecisionBenchFixture,
  type DecisionBenchRun,
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
 * The decision-bench store (ADR-0042): the append-only run files and the
 * samples seal under `benchmarks/decisions/`. The invariants the callers
 * lean on: a run file is written once — an overwrite is refused without
 * force, so a re-bench can never quietly replace a committed measurement;
 * every run pins the samples seal (version + cases hash) it measured; and
 * loading refuses any run whose pin does not match the committed seal —
 * a run measured against different bytes than the committed samples is
 * stale evidence, and staleness here is loud, never silent. The run-file
 * mechanics are the shared bench-store helpers; what is decision-specific
 * is the seal and the pins it hands out.
 */

export { BenchStoreError as DecisionBenchStoreError };

const fail = benchFail("decision-bench store");

/** The samples seal (`benchmarks/decisions/samples/version.json`). */
export type DecisionBenchSeal = {
  task: string;
  version: number;
  created: string;
  fixture: { id: string; status: string };
  counts: { cases: number; relevance: number; rerank: number; citation: number };
  languages: Record<string, number>;
  hashes: { cases: string };
  notes?: string[];
};

/** The run file name for a model: the config row id, slugified once. */
export function decisionBenchRunSlug(modelId: string): string {
  return benchRunSlug(modelId, fail);
}

export function decisionBenchRunFilePath(runsDir: string, modelId: string): string {
  return benchRunFilePath(runsDir, modelId, fail);
}

/**
 * Write one run file. Refuses an existing file without `force` — the one
 * documented escape hatch, for a deliberate re-run that replaces its own
 * committed measurement in the same PR that says so.
 */
export function writeDecisionBenchRun(
  runsDir: string,
  run: DecisionBenchRun,
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
export function loadDecisionBenchSeal(
  sealPath: string,
  casesPath: string,
  fixture: DecisionBenchFixture,
): DecisionBenchSeal {
  const seal = readBenchSeal<DecisionBenchSeal>({ sealPath, task: "decision-bench", fail });
  assertSealHash({
    fail,
    sealPath,
    name: "cases",
    pinned: seal.hashes?.cases,
    path: casesPath,
    actualLabel: "cases.json",
  });
  const caseCount = fixture.relevance.length + fixture.rerank.length + fixture.citation.length;
  assertSealCount({
    fail,
    sealPath,
    name: "cases",
    pinned: seal.counts?.cases,
    actual: caseCount,
    unit: " cases",
  });
  return seal;
}

/** The samples pin every run at this seal must carry. */
export function decisionBenchSamplesPin(seal: DecisionBenchSeal): DecisionBenchRun["samples"] {
  return { version: seal.version, casesSha256: seal.hashes.cases };
}

/** All committed runs in file-name order, each parsed and pin-checked. */
export function loadDecisionBenchRuns(
  runsDir: string,
  seal: DecisionBenchSeal,
): DecisionBenchRun[] {
  const pin = decisionBenchSamplesPin(seal);
  return loadBenchRuns({
    runsDir,
    fail,
    parse: parseDecisionBenchRun,
    staleReason: (run) => staleSamplesReason(run.samples, pin),
  });
}

/**
 * The full wording the decision bench sends: the case wording plus the
 * transport's system prompt. Pinning both makes a change to either visible
 * per run without re-sealing the case data; a decisions-wire arm does not send
 * the system prompt, so its pin is deliberately conservative.
 */
export function decisionBenchPromptsIdentity(
  casesIdentity: string,
  transportPrompt: string,
): string {
  return JSON.stringify({ cases: casesIdentity, transport: transportPrompt });
}

/** The prompts pin a run carries: the sha256 of the wording identity string. */
export function decisionBenchPromptsPin(identity: string): string {
  return sha256Text(identity);
}

export { countSupersededResults };
