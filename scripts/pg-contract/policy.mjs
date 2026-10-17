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
 *   - `assertMarked` reads the DB-less run's own report and fails on any
 *     undeclared file that skipped a test — whole or partial — and, because a
 *     test that returns early reports a pass and leaves no skip to see, it also
 *     fails on any undeclared test file that reads `DATABASE_URL` from the
 *     environment. Two rules, because a suite can hide in two ways: the report
 *     sees every skip, and the tree sees the gate itself;
 *   - `assertExecuted` fails when a declared suite executed nothing in the run
 *     that was supposed to execute it — the run's report is the evidence, never
 *     an assertion over the SQL text;
 *   - `contractRelevant` decides when the contract job must engage, with a
 *     changed declared suite among its triggers, so a newly added gated suite
 *     cannot land in a PR whose contract job never ran.
 *
 * Blind spots, stated. `assertMarked` observes only the files the DB-less run
 * collected: a test file outside `vitest.config.ts`'s `test.include` globs runs
 * in no job at all, which is why `TEST_ROOTS` and `TEST_FILE_RE` are pinned
 * against that config by the gate's own test. Its static rule reads
 * `process.env`; a suite that reaches the variable through a helper module and
 * then returns early reports a pass that nothing here can tell from an executed
 * one — expressing the gate as a skip is the contract, not a suggestion.
 * `contractRelevant` matches paths, not content: a change that alters what the
 * contract suites do without touching the seam, a declared suite, or a file
 * listed in `GATE_FILES` does not re-engage the job.
 */

/** The directive a test file carries to declare itself a real-Postgres suite. */
export const MARKER = "@requires-postgres";

const MARKER_RE = /^[ \t]*\/\/[ \t]*@requires-postgres(?![\w-])/m;

/**
 * How a file reads the variable a gated suite needs. A suite that gates by
 * returning early from a test reaches no skip, so the report cannot see it and
 * this is what does.
 */
const ENV_GATE_RE = /process\.env(?:\.DATABASE_URL\b|\[\s*["']DATABASE_URL["']\s*\])/;

/**
 * The trees test files are collected from, and the names collected in them —
 * `vitest.config.ts`'s `test.include` globs as roots and as one pattern. The
 * gate's own test pins both against that config, so a root or a name the runner
 * grows cannot go unwalked.
 */
export const TEST_ROOTS = ["packages", "apps", "tests"];
export const TEST_FILE_RE = /\.(?:prop\.test|test)\.(?:ts|mjs)$/;

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
  /** 1 marks a failing gate; 2 marks usage or unreadable input. */
  exitCode = 1;
}

/** Raised by the driver's argument parsing: a usage error, not a failing gate. */
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

/** Every file under the tree roots that the test runner would collect. */
function collectedTestFiles(root) {
  return TEST_ROOTS.flatMap((tree) => {
    const dir = join(root, tree);
    return existsSync(dir) ? walk(dir) : [];
  }).filter((path) => TEST_FILE_RE.test(path));
}

/**
 * Every collected test file that declares MARKER, repo-relative, sorted. A root
 * that does not exist contributes nothing — the roots are globs, and the guard
 * in `declaredSuiteFiles` is what makes a derivation that found nothing loud. A
 * declaration is a line comment, so documentation that quotes the marker inside
 * a block comment does not declare the file.
 */
export function gatedSuiteFiles(root = process.cwd()) {
  return collectedTestFiles(root)
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

/**
 * Collected test files that read `DATABASE_URL` from the process environment
 * without declaring the marker — the static half of the gate, and the only half
 * that can see a suite gating by an early return. The gate's own files are
 * exempt: they quote the pattern as fixture text, and they are not suites.
 */
export function undeclaredGates(declared, root = process.cwd(), gateFiles = GATE_FILES) {
  const exempt = new Set([...declared, ...gateFiles]);
  return collectedTestFiles(root)
    .filter((path) => ENV_GATE_RE.test(readFileSync(path, "utf8")))
    .map((path) => rel(root, path))
    .filter((file) => !exempt.has(file))
    .sort();
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
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    throw new PgContractError(
      `${path} is not parseable as JSON: the run did not finish writing its report`,
    );
  }
  if (!Array.isArray(report?.testResults)) {
    throw new PgContractError(
      `${path} is not a vitest JSON report: it carries no testResults array`,
    );
  }
  return report;
}

const count = (entry, status) =>
  entry.assertionResults.filter((assertion) => assertion.status === status).length;

/**
 * One reading of a report: for every file the run collected and for every
 * declared suite, whether it is declared, whether the run collected it, how many
 * of its tests executed and how many were skipped. Both assertions below are
 * filters over this, so neither re-derives the space nor repeats the vacuity
 * guards — and the check that catches a hidden suite is a predicate here rather
 * than another special case.
 */
export function classify(report, declared, root = process.cwd()) {
  if (declared.length < MIN_GATED_SUITES) {
    throw new PgContractError("no declared suite to check: the derivation found none");
  }
  if (report.testResults.length === 0) {
    throw new PgContractError(
      "the report lists no test file at all, so every check would pass vacuously",
    );
  }
  const declaredSet = new Set(declared);
  const suites = report.testResults.map((entry) => {
    const file = rel(root, resolve(entry.name));
    return {
      file,
      declared: declaredSet.has(file),
      collected: true,
      executed: count(entry, "passed"),
      skipped: count(entry, "skipped"),
    };
  });
  for (const file of declaredSet) {
    // A declared suite the run never collected is a selected suite that executed
    // nothing, so it enters the classification with nothing executed.
    if (!suites.some((suite) => suite.file === file)) {
      suites.push({ file, declared: true, collected: false, executed: 0, skipped: 0 });
    }
  }
  return {
    suites,
    /** Whether this run skipped anything at all — false outside the DB-less run. */
    skippedAny: suites.some((suite) => suite.skipped > 0),
    /** Files no job selects that skipped tests: the report-visible half of the gate. */
    undeclaredSkips: suites.filter((suite) => !suite.declared && suite.skipped > 0),
    /** Declared suites the run did not execute in full: the selected-and-unrun half. */
    unexecuted: suites.filter(
      (suite) => suite.declared && (suite.executed === 0 || suite.skipped > 0),
    ),
    /** Declared suites that skipped nothing: a marker claiming a gate that is not there. */
    neverSkipped: suites.filter((suite) => suite.declared && suite.skipped === 0),
  };
}

/**
 * The contract run executed everything it selected: every declared suite ran at
 * least one test and skipped none. A gated suite reaches this step either
 * executed or not at all, and "not at all" is what reddens here.
 */
export function assertExecuted(report, declared, root = process.cwd()) {
  const { unexecuted } = classify(report, declared, root);
  if (unexecuted.length === 0) return declared;
  const detail = unexecuted.map((suite) => {
    if (!suite.collected) return `${suite.file} — not collected by the run`;
    if (suite.executed === 0) {
      return `${suite.file} — executed none of its tests (${suite.skipped} skipped)`;
    }
    return `${suite.file} — ${suite.skipped} of its tests were skipped`;
  });
  throw new PgContractError(
    `the contract job selected suites that did not execute; check that DATABASE_URL reaches the run ` +
      `and that each suite gates on it:\n  ${detail.join("\n  ")}`,
  );
}

/**
 * Every suite the DB-less run skipped is declared — some job runs it — and so is
 * every test file that reads `DATABASE_URL`, since a gate written as an early
 * return leaves the report nothing to see. The last check runs the other way: a
 * declared suite that skipped nothing claims a gate that is not there.
 */
export function assertMarked(report, declared, root = process.cwd()) {
  const { skippedAny, undeclaredSkips, neverSkipped } = classify(report, declared, root);
  if (!skippedAny) {
    throw new PgContractError(
      "the report shows no skipped test, so it does not come from the DB-less run this check reads",
    );
  }
  const problems = [];
  if (undeclaredSkips.length > 0) {
    problems.push(
      `suite(s) skipped tests without declaring "${MARKER}", so no job runs what they skipped:\n  ` +
        undeclaredSkips.map((suite) => `${suite.file} (${suite.skipped} skipped)`).join("\n  "),
    );
  }
  const gates = undeclaredGates(declared, root);
  if (gates.length > 0) {
    problems.push(
      `test file(s) read DATABASE_URL from the environment without declaring "${MARKER}": a test ` +
        `that gates on it by returning early reports a pass and skips nothing, so no other check ` +
        `would run it:\n  ${gates.join("\n  ")}`,
    );
  }
  if (problems.length > 0) throw new PgContractError(problems.join("\n"));
  if (neverSkipped.length > 0) {
    throw new PgContractError(
      `declared "${MARKER}" but skipped nothing in this DB-less run, so the marker claims a gate ` +
        `that is not there:\n  ${neverSkipped.map((suite) => suite.file).join("\n  ")}`,
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
