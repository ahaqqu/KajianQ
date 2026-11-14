import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseRouterBenchRun, type RouterBenchFixture, type RouterBenchRun } from "@app/contracts";
import {
  countSupersededResults,
  decisionBenchRunFilePath,
  decisionBenchRunSlug,
  DecisionBenchStoreError,
} from "./decision-bench-store";

/**
 * The router-bench store: the same append-only discipline as the decision
 * bench store, over the routing fixture — a run file is written once (an
 * overwrite is refused without force), every run pins the samples seal it
 * measured, and loading refuses any run whose pin does not match the
 * committed seal. The slug/file-path/count helpers are the decision store's
 * — one naming scheme across the whole benchmark store.
 */

export { DecisionBenchStoreError as RouterBenchStoreError, decisionBenchRunSlug };

/** The samples seal (`benchmarks/routing/samples/version.json`). */
export type RouterBenchSeal = {
  task: string;
  version: number;
  created: string;
  fixture: { id: string; status: string };
  counts: { cases: number };
  languages: Record<string, number>;
  hashes: { cases: string };
  notes?: string[];
};

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function routerBenchRunFilePath(runsDir: string, modelId: string): string {
  return decisionBenchRunFilePath(runsDir, modelId);
}

/**
 * Write one run file. Refuses an existing file without `force` — the one
 * documented escape hatch, for a deliberate re-run that replaces its own
 * committed measurement in the same PR that says so.
 */
export function writeRouterBenchRun(
  runsDir: string,
  run: RouterBenchRun,
  opts: { force?: boolean } = {},
): string {
  const path = routerBenchRunFilePath(runsDir, run.model);
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
export function loadRouterBenchSeal(
  sealPath: string,
  casesPath: string,
  fixture: RouterBenchFixture,
): RouterBenchSeal {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(sealPath, "utf8"));
  } catch (cause) {
    throw new DecisionBenchStoreError(sealPath, `unreadable seal: ${String(cause)}`);
  }
  const seal = raw as RouterBenchSeal;
  if (seal.task !== "router-bench") {
    throw new DecisionBenchStoreError(sealPath, `seal task "${seal.task}" is not "router-bench"`);
  }
  const actual = `sha256:${sha256Hex(readFileSync(casesPath))}`;
  if (seal.hashes?.cases !== actual) {
    throw new DecisionBenchStoreError(
      sealPath,
      `cases hash mismatch: seal pins ${seal.hashes?.cases ?? "nothing"}, cases.json is ${actual} — re-seal before running`,
    );
  }
  if (seal.counts?.cases !== fixture.cases.length) {
    throw new DecisionBenchStoreError(
      sealPath,
      `counts.cases ${seal.counts?.cases ?? "missing"} does not match the fixture's ${fixture.cases.length} cases`,
    );
  }
  return seal;
}

/** The samples pin every run at this seal must carry. */
export function routerBenchSamplesPin(seal: RouterBenchSeal): RouterBenchRun["samples"] {
  return { version: seal.version, casesSha256: seal.hashes.cases };
}

/** All committed runs in file-name order, each parsed and pin-checked. */
export function loadRouterBenchRuns(runsDir: string, seal: RouterBenchSeal): RouterBenchRun[] {
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
    let run: RouterBenchRun;
    try {
      run = parseRouterBenchRun(JSON.parse(readFileSync(path, "utf8")));
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

/** The prompts pin a run carries: the sha256 of the router prompt identity. */
export function routerBenchPromptsPin(identity: string): string {
  return `sha256:${sha256Hex(Buffer.from(identity, "utf8"))}`;
}

export { countSupersededResults };
