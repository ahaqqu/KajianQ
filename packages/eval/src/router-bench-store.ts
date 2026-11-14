import { parseRouterBenchRun, type RouterBenchFixture, type RouterBenchRun } from "@app/contracts";
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
 * The router-bench store: the decision-bench store's append-only discipline
 * over the routing fixture — a run file is written once (an overwrite is
 * refused without force), every run pins the samples seal it measured, and
 * loading refuses any run whose pin does not match the committed seal. The
 * run-file mechanics and the seal checks are the shared bench-store helpers;
 * what is router-specific is the seal and the pins it hands out.
 */

export { BenchStoreError as RouterBenchStoreError };

const fail = benchFail("router-bench store");

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

export function routerBenchRunFilePath(runsDir: string, modelId: string): string {
  return benchRunFilePath(runsDir, modelId, fail);
}

export function routerBenchRunSlug(modelId: string): string {
  return benchRunSlug(modelId, fail);
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
  return writeBenchRun(runsDir, run, opts, fail);
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
  const seal = readBenchSeal<RouterBenchSeal>({ sealPath, task: "router-bench", fail });
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
export function routerBenchSamplesPin(seal: RouterBenchSeal): RouterBenchRun["samples"] {
  return { version: seal.version, casesSha256: seal.hashes.cases };
}

/** All committed runs in file-name order, each parsed and pin-checked. */
export function loadRouterBenchRuns(runsDir: string, seal: RouterBenchSeal): RouterBenchRun[] {
  const pin = routerBenchSamplesPin(seal);
  return loadBenchRuns({
    runsDir,
    fail,
    parse: parseRouterBenchRun,
    staleReason: (run) => staleSamplesReason(run.samples, pin),
  });
}

/** The prompts pin a run carries: the sha256 of the router wording identity. */
export function routerBenchPromptsPin(identity: string): string {
  return sha256Text(identity);
}

export { countSupersededResults };
