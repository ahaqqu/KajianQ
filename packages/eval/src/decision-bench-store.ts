import { readFileSync } from "node:fs";
import {
  parseDecisionBenchRun,
  type DecisionBenchFixture,
  type DecisionBenchRun,
} from "@app/contracts";
import {
  benchRunFilePath,
  benchRunSlug,
  countSupersededResults,
  loadBenchRuns,
  sha256Hex,
  sha256Text,
  writeBenchRun,
  type BenchStoreFailure,
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

export class DecisionBenchStoreError extends Error {
  constructor(
    readonly source: string,
    message: string,
  ) {
    super(`decision-bench store (${source}): ${message}`);
  }
}

const fail: BenchStoreFailure = (source, message) => new DecisionBenchStoreError(source, message);

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
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(sealPath, "utf8"));
  } catch (cause) {
    throw new DecisionBenchStoreError(sealPath, `unreadable seal: ${String(cause)}`);
  }
  const seal = raw as DecisionBenchSeal;
  if (seal.task !== "decision-bench") {
    throw new DecisionBenchStoreError(sealPath, `seal task "${seal.task}" is not "decision-bench"`);
  }
  const actual = sha256Hex(readFileSync(casesPath));
  if (seal.hashes?.cases !== actual) {
    throw new DecisionBenchStoreError(
      sealPath,
      `cases hash mismatch: seal pins ${seal.hashes?.cases ?? "nothing"}, cases.json is ${actual} — re-seal before running`,
    );
  }
  const caseCount = fixture.relevance.length + fixture.rerank.length + fixture.citation.length;
  if (seal.counts?.cases !== caseCount) {
    throw new DecisionBenchStoreError(
      sealPath,
      `counts.cases ${seal.counts?.cases ?? "missing"} does not match the fixture's ${caseCount} cases`,
    );
  }
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
  return loadBenchRuns({
    runsDir,
    fail,
    parse: parseDecisionBenchRun,
    staleReason: (run) =>
      run.samples.version !== seal.version || run.samples.casesSha256 !== seal.hashes.cases
        ? `run pins samples v${run.samples.version} (${run.samples.casesSha256.slice(0, 20)}…) but the committed seal is v${seal.version} — archive it under superseded/ or re-run at the current seal`
        : null,
  });
}

/** The prompts pin a run carries: the sha256 of the wording identity string. */
export function decisionBenchPromptsPin(identity: string): string {
  return sha256Text(identity);
}

export { countSupersededResults };
