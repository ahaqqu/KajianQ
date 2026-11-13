import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseDecisionBenchRun,
  type DecisionBenchFixture,
  type DecisionBenchRun,
} from "@app/contracts";

/**
 * The decision-bench store (ADR-0042): the append-only run files and the
 * samples seal under `benchmarks/decisions/`. The invariants the callers
 * lean on: a run file is written once — an overwrite is refused without
 * force, so a re-bench can never quietly replace a committed measurement;
 * every run pins the samples seal (version + cases hash) it measured; and
 * loading refuses any run whose pin does not match the committed seal —
 * a run measured against different bytes than the committed samples is
 * stale evidence, and staleness here is loud, never silent.
 */

export class DecisionBenchStoreError extends Error {
  constructor(
    readonly source: string,
    message: string,
  ) {
    super(`decision-bench store (${source}): ${message}`);
  }
}

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

/** Lowercase hex sha256 — the digest format every pin in the store uses. */
function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The run file name for a model: the config row id, slugified once. */
export function decisionBenchRunSlug(modelId: string): string {
  const slug = modelId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length === 0) {
    throw new DecisionBenchStoreError(modelId, "model id slugifies to an empty name");
  }
  return slug;
}

export function decisionBenchRunFilePath(runsDir: string, modelId: string): string {
  return join(runsDir, `${decisionBenchRunSlug(modelId)}.json`);
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
  const path = decisionBenchRunFilePath(runsDir, run.model);
  if (existsSync(path) && opts.force !== true) {
    throw new DecisionBenchStoreError(
      path,
      `run file for "${run.model}" already exists — pass --force to replace a committed measurement deliberately`,
    );
  }
  writeFileSync(path, JSON.stringify(run, null, 2) + "\n");
  return path;
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
  const actual = `sha256:${sha256Hex(readFileSync(casesPath))}`;
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
  let files: string[];
  try {
    files = readdirSync(runsDir)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch (cause) {
    throw new DecisionBenchStoreError(runsDir, `unreadable runs directory: ${String(cause)}`);
  }
  return files.map((file) => {
    const path = join(runsDir, file);
    let run: DecisionBenchRun;
    try {
      run = parseDecisionBenchRun(JSON.parse(readFileSync(path, "utf8")));
    } catch (cause) {
      throw new DecisionBenchStoreError(path, `invalid run file: ${String(cause)}`);
    }
    if (run.samples.version !== seal.version || run.samples.casesSha256 !== seal.hashes.cases) {
      throw new DecisionBenchStoreError(
        path,
        `run pins samples v${run.samples.version} (${run.samples.casesSha256.slice(0, 20)}…) but the committed seal is v${seal.version} — archive it under superseded/ or re-run at the current seal`,
      );
    }
    return run;
  });
}

/** The prompts pin a run carries: the sha256 of the wording identity string. */
export function decisionBenchPromptsPin(identity: string): string {
  return `sha256:${sha256Hex(Buffer.from(identity, "utf8"))}`;
}

/**
 * Frozen results under `<dir>/superseded/` (pre-seal history, archived
 * generations) — counted for the report's history line, never scored.
 */
export function countSupersededResults(dir: string): number {
  const root = join(dir, "superseded");
  const count = (path: string): number => {
    let n = 0;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isDirectory()) n += count(join(path, entry.name));
      else if (entry.name.endsWith(".json")) n += 1;
    }
    return n;
  };
  try {
    return count(root);
  } catch {
    return 0;
  }
}
