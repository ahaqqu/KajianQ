import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PgContractError } from "./errors.mjs";
import { repoRelative } from "./tree.mjs";

/**
 * One vitest JSON report, read as one classification of the run that produced it: for
 * every file the run collected and for every declared suite, whether it is declared,
 * whether the run collected it, how many of its tests executed and how many were
 * skipped. Both assertions in `policy.mjs` are filters over a single `classify()`, so
 * neither re-derives the space the other reads, and the check that catches a hidden
 * suite is a predicate here rather than another special case.
 */

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
  if (report.testResults.length === 0) {
    throw new PgContractError(
      "the report lists no test file at all, so every check would pass vacuously",
    );
  }
  const declaredSet = new Set(declared);
  const suites = report.testResults.map((entry) => {
    const file = repoRelative(root, resolve(entry.name));
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
    /** Declared, collected, and skipped nothing: a marker claiming a gate that is not there. */
    neverSkipped: suites.filter(
      (suite) => suite.declared && suite.collected && suite.skipped === 0,
    ),
    /** Declared but never collected: the marker or the include globs moved under it. */
    notCollected: suites.filter((suite) => suite.declared && !suite.collected),
  };
}
