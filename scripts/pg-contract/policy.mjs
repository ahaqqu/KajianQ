import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/**
 * The real-Postgres contract gate's policy — the contract its driver
 * (`scripts/pg-contract.mjs`) is checked against.
 *
 * A test file is a *gated suite* when it declares the marker below: its tests
 * execute only where `DATABASE_URL` is bound, and without the variable the file
 * is still collected, still reported green, and runs none of them. That is the
 * state this policy exists to keep impossible:
 *
 *   - `declaredSuiteFiles` derives the set from the tree, so a suite that
 *     declares the marker is picked up by the `postgres:contract` job without
 *     anyone remembering to wire it, and a derivation that quietly comes back
 *     empty reddens instead of passing every check vacuously;
 *   - `assertMarked` reads the DB-less run's own report and fails on any file it
 *     skipped in full that is not declared, so a gated suite that forgot the
 *     marker fails the gate rather than passing it;
 *   - `assertExecuted` fails when a declared suite executed nothing in the run
 *     that was supposed to execute it — the run's report is the evidence, never
 *     an assertion over the SQL text;
 *   - `contractRelevant` decides when the contract job must engage, with a
 *     changed declared suite among its triggers, so a newly added gated suite
 *     cannot land in a PR whose contract job never ran.
 *
 * Blind spots, stated. `assertMarked` observes only the files the DB-less run
 * collected: a test file outside `vitest.config.ts`'s `test.include` globs runs
 * in no job at all, and a suite that gates on neither the marker nor an
 * environment read is still declared by the marker — which is why the marker,
 * not the observation, is the single definition of "gated". `contractRelevant`
 * matches paths, not content: a change that alters what the contract suites do
 * without touching the seam, a declared suite, or a file listed in `GATE_FILES`
 * does not re-engage the job.
 */

/** The directive a test file carries to declare itself a real-Postgres suite. */
export const MARKER = "@requires-postgres";

const MARKER_RE = /^[ \t]*\/\/[ \t]*@requires-postgres(?![\w-])/m;

/**
 * The trees test files are collected from — `vitest.config.ts`'s `test.include`
 * globs, as roots. Kept as roots so an uncollected file cannot be declared.
 */
const TEST_ROOTS = ["packages", "apps", "tests"];

/** The test-file names the runner collects. */
const TEST_FILE_RE = /\.(?:prop\.test|test)\.(?:ts|mjs)$/;

/** The fewest gated suites a sound derivation can return. */
export const MIN_GATED_SUITES = 1;

/**
 * The gate's own files: a change to any of them re-engages the contract job, so
 * the PR that edits the gate is the PR that exercises it.
 */
export const GATE_FILES = [
  "scripts/pg-contract.mjs",
  "scripts/pg-contract/policy.mjs",
  "tests/scripts/pg-contract.test.mjs",
  "vitest.config.ts",
  ".github/workflows/ci.yml",
];

/** The error a caller sees; never a bare stack trace. */
export class PgContractError extends Error {
  /** 2 marks a usage or input failure, so the caller can tell it from a red gate. */
  exitCode = 1;
}

/**
 * Raised by the driver's argument parsing; a usage error, not a failing gate.
 */
export class UsageError extends PgContractError {
  exitCode = 2;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

/** A repo-relative path with forward slashes, whichever platform walked it. */
const rel = (root, path) => relative(root, path).split(sep).join("/");

/**
 * Every test file under the tree roots that declares MARKER, repo-relative,
 * sorted. A root that does not exist contributes nothing — the roots are
 * globs, and the guard in `declaredSuiteFiles` is what makes a derivation that
 * found nothing loud. A declaration is a line comment, so documentation that
 * quotes the marker inside a block comment does not declare the file.
 */
export function gatedSuiteFiles(root = process.cwd()) {
  return TEST_ROOTS.flatMap((tree) => {
    const dir = join(root, tree);
    return existsSync(dir) ? walk(dir) : [];
  })
    .filter((path) => TEST_FILE_RE.test(path))
    .filter((path) => MARKER_RE.test(readFileSync(path, "utf8")))
    .map((path) => rel(root, path))
    .sort();
}

/**
 * The declared gated suites. Throws when the derivation came back short of
 * MIN_GATED_SUITES: an empty selection would satisfy every iteration below
 * while running nothing, which is the failure this whole module is about.
 */
export function declaredSuiteFiles(root = process.cwd()) {
  const files = gatedSuiteFiles(root);
  if (files.length < MIN_GATED_SUITES) {
    throw new PgContractError(
      `no gated suite found: nothing under ${TEST_ROOTS.join(", ")} declares "${MARKER}", ` +
        `so the contract job would select nothing to run`,
    );
  }
  return files;
}

/** The vitest JSON report at `path`, or a throw naming what is missing. */
export function readReport(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new PgContractError(
      `no test report at ${path}: the run that writes it did not get far enough to be read`,
    );
  }
  const report = JSON.parse(text);
  if (!Array.isArray(report?.testResults)) {
    throw new PgContractError(
      `${path} is not a vitest JSON report: it carries no testResults array`,
    );
  }
  return report;
}

const entryFor = (report, root, file) =>
  report.testResults.find((entry) => resolve(entry.name) === resolve(root, file));

const count = (entry, status) =>
  entry.assertionResults.filter((assertion) => assertion.status === status).length;

/** Files the run collected and skipped in full — the collected-but-skipped shape. */
const skippedInFull = (report) =>
  report.testResults.filter(
    (entry) =>
      entry.assertionResults.length > 0 &&
      count(entry, "skipped") === entry.assertionResults.length,
  );

/**
 * The contract run executed everything it selected: every declared suite ran at
 * least one test and skipped none. A gated suite reaches this step either
 * executed or not at all, and "not at all" is what reddens here.
 */
export function assertExecuted(report, declared, root = process.cwd()) {
  if (declared.length < MIN_GATED_SUITES) {
    throw new PgContractError("the contract run was given no declared suite to check");
  }
  if (report.testResults.length === 0) {
    throw new PgContractError(
      "the report lists no test file at all, so every check below would pass vacuously",
    );
  }
  const failed = [];
  for (const file of declared) {
    const entry = entryFor(report, root, file);
    if (!entry) {
      failed.push(`${file} — not collected by the run`);
      continue;
    }
    const skipped = count(entry, "skipped");
    if (count(entry, "passed") === 0) {
      failed.push(`${file} — executed none of its tests (${skipped} skipped)`);
      continue;
    }
    if (skipped > 0) failed.push(`${file} — ${skipped} of its tests were skipped`);
  }
  if (failed.length > 0) {
    throw new PgContractError(
      `the contract job selected suites that did not execute; check that DATABASE_URL reaches the run ` +
        `and that each suite gates on it:\n  ${failed.join("\n  ")}`,
    );
  }
  return declared;
}

/**
 * Every suite the DB-less run skipped in full is declared — i.e. some job runs
 * it — and every declared suite really skipped something there. The first half
 * catches a gated suite that forgot the marker; the second catches a marker
 * left on a file that no longer gates on anything.
 */
export function assertMarked(report, declared, root = process.cwd()) {
  if (report.testResults.length === 0) {
    throw new PgContractError(
      "the report lists no test file at all, so every check below would pass vacuously",
    );
  }
  if (!report.testResults.some((entry) => count(entry, "skipped") > 0)) {
    throw new PgContractError(
      "the report shows no skipped test, so it does not come from the DB-less run this check reads",
    );
  }
  const declaredSet = new Set(declared);
  const undeclared = skippedInFull(report)
    .map((entry) => rel(root, resolve(entry.name)))
    .filter((file) => !declaredSet.has(file));
  if (undeclared.length > 0) {
    throw new PgContractError(
      `suite(s) skipped in full without declaring "${MARKER}", so no job executes them — ` +
        `add the directive and the contract job runs the file:\n  ${undeclared.join("\n  ")}`,
    );
  }
  const unobserved = declared.filter((file) => {
    const entry = entryFor(report, root, file);
    return !entry || count(entry, "skipped") === 0;
  });
  if (unobserved.length > 0) {
    throw new PgContractError(
      `declared "${MARKER}" but skipped nothing in this DB-less run, so the marker claims a gate ` +
        `that is not there:\n  ${unobserved.join("\n  ")}`,
    );
  }
  return declared;
}

/**
 * Whether these changed paths can alter what the contract suites execute: the
 * store seam's own home, a declared suite, or the gate's own files.
 */
export function contractRelevant(changedPaths, declared, gateFiles = GATE_FILES) {
  const declaredSet = new Set(declared);
  const gateSet = new Set(gateFiles);
  return changedPaths.some(
    (path) => path.startsWith("packages/infra/") || declaredSet.has(path) || gateSet.has(path),
  );
}
