import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The generic bench-store helpers behind the per-bench store modules
 * (ADR-0042's store shape, shared): append-only run files named by a
 * slugified model id, written once and refused on overwrite without force,
 * loaded in file-name order through the bench's own parse and staleness
 * checks, plus the seal reading and pin checks every bench performs before a
 * run, and the `sha256:<hex>` pin format. The invariants every bench leans
 * on: a re-bench can never quietly replace a committed measurement, and a
 * run measured against different bytes than its bench's committed samples is
 * stale evidence — staleness is loud, never silent. A concrete store names
 * its own failures: every helper takes a `fail` factory so errors carry the
 * bench's own label.
 */

/** How a concrete bench store builds its errors (`source` = the offending path or id). */
export type BenchStoreFailure = (source: string, message: string) => Error;

/** The one field the generic run-file helpers need from any bench's run shape. */
export type BenchRunLike = { model: string };

/** The one error class every bench store raises, labelled with the bench that failed. */
export class BenchStoreError extends Error {
  constructor(
    readonly label: string,
    readonly source: string,
    message: string,
  ) {
    super(`${label} (${source}): ${message}`);
  }
}

/** A `fail` factory carrying one bench's label into every store error. */
export function benchFail(label: string): BenchStoreFailure {
  return (source, message) => new BenchStoreError(label, source, message);
}

/** Lowercase `sha256:<hex>` of raw bytes — the digest format every pin in a store uses. */
export function sha256Hex(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** The `sha256:<hex>` of a utf8 string (a wording identity, not a file). */
export function sha256Text(text: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex")}`;
}

/** The run-file name for a model: the config row id, slugified once. */
export function benchRunSlug(modelId: string, fail: BenchStoreFailure): string {
  const slug = modelId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length === 0) {
    throw fail(modelId, "model id slugifies to an empty name");
  }
  return slug;
}

export function benchRunFilePath(
  runsDir: string,
  modelId: string,
  fail: BenchStoreFailure,
): string {
  return join(runsDir, `${benchRunSlug(modelId, fail)}.json`);
}

/**
 * Write one run file. Refuses an existing file without `force` — the one
 * documented escape hatch, for a deliberate re-run that replaces its own
 * committed measurement in the same PR that says so.
 */
export function writeBenchRun<T extends BenchRunLike>(
  runsDir: string,
  run: T,
  opts: { force?: boolean },
  fail: BenchStoreFailure,
): string {
  const path = benchRunFilePath(runsDir, run.model, fail);
  if (existsSync(path) && opts.force !== true) {
    throw fail(
      path,
      `run file for "${run.model}" already exists — pass --force to replace a committed measurement deliberately`,
    );
  }
  writeFileSync(path, JSON.stringify(run, null, 2) + "\n");
  return path;
}

/**
 * All committed runs in file-name order, each through the bench's own parse
 * (a malformed file fails with its path) and staleness check (a non-null
 * reason fails with its path) — a run whose pin does not match the committed
 * samples never reaches a report.
 */
export function loadBenchRuns<T>(opts: {
  runsDir: string;
  fail: BenchStoreFailure;
  parse: (raw: unknown) => T;
  staleReason: (run: T) => string | null;
}): T[] {
  let files: string[];
  try {
    files = readdirSync(opts.runsDir)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch (cause) {
    throw opts.fail(opts.runsDir, `unreadable runs directory: ${String(cause)}`);
  }
  return files.map((file) => {
    const path = join(opts.runsDir, file);
    let run: T;
    try {
      run = opts.parse(JSON.parse(readFileSync(path, "utf8")));
    } catch (cause) {
      throw opts.fail(path, `invalid run file: ${String(cause)}`);
    }
    const stale = opts.staleReason(run);
    if (stale !== null) throw opts.fail(path, stale);
    return run;
  });
}

/** Read a seal file and check it names the bench being loaded. */
export function readBenchSeal<T>(opts: {
  sealPath: string;
  task: string;
  fail: BenchStoreFailure;
}): T {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(opts.sealPath, "utf8"));
  } catch (cause) {
    throw opts.fail(opts.sealPath, `unreadable seal: ${String(cause)}`);
  }
  const seal = raw as { task?: unknown };
  if (seal.task !== opts.task) {
    throw opts.fail(opts.sealPath, `seal task "${String(seal.task)}" is not "${opts.task}"`);
  }
  return raw as T;
}

/** Check one sample file against the hash its seal pins. */
export function assertSealHash(opts: {
  fail: BenchStoreFailure;
  sealPath: string;
  /** The pin's name in the seal ("cases", "probes", "expansion"). */
  name: string;
  pinned: string | undefined;
  /** The file the pin covers. */
  path: string;
  /** How the message names that file ("cases.json", or the path itself). */
  actualLabel: string;
}): void {
  const actual = sha256Hex(readFileSync(opts.path));
  if (opts.pinned !== actual) {
    throw opts.fail(
      opts.sealPath,
      `${opts.name} hash mismatch: seal pins ${opts.pinned ?? "nothing"}, ${opts.actualLabel} is ${actual} — re-seal before running`,
    );
  }
}

/** Check one sample count against the count its seal pins. */
export function assertSealCount(opts: {
  fail: BenchStoreFailure;
  sealPath: string;
  /** The count's name in the seal ("cases", "crossLingual", "expansion"). */
  name: string;
  pinned: number | undefined;
  actual: number;
  /** Suffix after the actual count (" cases" where the seal counts cases). */
  unit: string;
}): void {
  if (opts.pinned !== opts.actual) {
    throw opts.fail(
      opts.sealPath,
      `counts.${opts.name} ${opts.pinned ?? "missing"} does not match the fixture's ${opts.actual}${opts.unit}`,
    );
  }
}

/** The stale-run message, or null when a run's samples pin is the committed one. */
export function staleSamplesReason(
  actual: { version: number; casesSha256: string },
  expected: { version: number; casesSha256: string },
): string | null {
  return actual.version !== expected.version || actual.casesSha256 !== expected.casesSha256
    ? `run pins samples v${actual.version} (${actual.casesSha256.slice(0, 20)}…) but the committed seal is v${expected.version} — archive it under superseded/ or re-run at the current seal`
    : null;
}

/**
 * Frozen results under `<dir>/superseded/` (pre-store history, archived
 * generations) — counted for a report's history line, never scored.
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
