import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { PgContractError } from "./errors.mjs";
import { classify } from "./report.mjs";
import { codeOnly } from "./source.mjs";
import { collectedTestFiles, includeGlobs } from "./tree.mjs";

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
 *   - `assertMarked` reads the DB-less run's own report and fails on either
 *     unrun-but-green shape: an undeclared file that skipped a test — whole or
 *     partial — and, because a test that returns early reports a pass and leaves
 *     no skip to see, an undeclared test file that reads `DATABASE_URL` in code
 *     position. Two rules, because a suite can hide in two ways: the report sees
 *     every skip, and the tree sees the gate itself. A declaration that turns out
 *     to gate nothing is a note rather than a failure, so declaring stays the
 *     cheap remedy for a file the static rule cannot tell from a reader;
 *   - `assertExecuted` fails when a declared suite executed nothing in the run
 *     that was supposed to execute it — the run's report is the evidence, never
 *     an assertion over the SQL text;
 *   - `contractRelevant` decides when the contract job must engage, with a
 *     changed declared suite among its triggers, so a newly added gated suite
 *     cannot land in a PR whose contract job never ran.
 *
 * Blind spots, stated. The universe both rules read is `vitest.config.ts`'s own
 * `test.include`, so a test file those globs do not collect is in no job at all
 * and no rule here — the gate cannot see what the runner never loads. The static
 * rule knows the spellings below and nothing else: a file whose gate arrives
 * through a helper module, or through an alias of `process.env`, and which then
 * returns early rather than skipping, is invisible to both rules — which is why
 * expressing the gate as a skip is the contract, not a suggestion. A report-based
 * differential (this file's other candidate) does not close that case either: an
 * early return reports the same executed/skipped counts with and without a
 * database, so the two runs agree on exactly the file that needs catching.
 * `contractRelevant` matches paths, not content: a change that alters what the
 * contract suites do without touching the store seam, a declared suite, or a file
 * listed in `GATE_FILES` does not re-engage the job.
 */

/** The directive a test file carries to declare itself a real-Postgres suite. */
export const MARKER = "@requires-postgres";

const MARKER_RE = /^[ \t]*\/\/[ \t]*@requires-postgres(?![\w-])/m;

/**
 * The three spellings a gated suite reads its variable with, in code position: the
 * property, the quoted subscript, and the destructured binding. A suite that gates
 * by returning early from a test reaches no skip, so the report cannot see it and
 * this is what does. An alias of `process.env`, or a helper that returns the
 * variable, is not one of these — the header names that as the residual.
 */
const ENV_GATE_RES = [
  /process\s*\.\s*env\s*\.\s*DATABASE_URL\b/,
  /process\s*\.\s*env\s*\[\s*["']DATABASE_URL["']\s*\]/,
  /(?:const|let|var)\s*\{[^}]*\bDATABASE_URL\b[^}]*\}\s*=\s*(?:process\s*\.\s*env|import\s*\.\s*meta\s*\.\s*env|env)\b/,
];

/**
 * Whether a source reads the variable in code position — the one predicate the
 * static half of the gate is, so the spellings it knows are stated in one place
 * and exercised directly.
 */
export const readsDatabaseUrl = (source) =>
  ENV_GATE_RES.some((pattern) => pattern.test(codeOnly(source)));

/** The fewest gated suites a sound derivation can return. */
export const MIN_GATED_SUITES = 1;

/**
 * The gate's own files: a change to any of them re-engages the contract job, so
 * the PR that edits the gate is the PR that exercises it.
 */
export const GATE_FILES = [
  "scripts/pg-contract.mjs",
  "scripts/pg-contract/errors.mjs",
  "scripts/pg-contract/policy.mjs",
  "scripts/pg-contract/report.mjs",
  "scripts/pg-contract/source.mjs",
  "scripts/pg-contract/tree.mjs",
  "tests/scripts/pg-contract.test.mjs",
  "vitest.config.ts",
  ".github/workflows/ci.yml",
];

/**
 * The include globs the test runner collects, read from `vitest.config.ts`. A
 * config this cannot read fails the gate rather than shrinking the universe: an
 * empty selection would satisfy every iteration below while running nothing.
 */
export function collectedGlobs(root = process.cwd()) {
  const path = join(root, "vitest.config.ts");
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    throw new PgContractError(`no ${path}: the gate cannot tell what the test runner collects`);
  }
  const globs = includeGlobs(source);
  if (globs === null) {
    throw new PgContractError(
      `${path} carries no test.include globs: the gate cannot tell what the test runner collects`,
    );
  }
  return globs;
}

/** Every test file the runner collects, repo-relative and sorted. */
export function collectedSuites(root = process.cwd()) {
  return collectedTestFiles(root, collectedGlobs(root));
}

/**
 * Every collected test file that declares MARKER, repo-relative, sorted. A
 * declaration is a line comment, so documentation that quotes the marker inside a
 * block comment does not declare the file.
 */
export function gatedSuiteFiles(root = process.cwd()) {
  return collectedSuites(root)
    .filter((file) => MARKER_RE.test(readFileSync(resolve(root, file), "utf8")))
    .sort();
}

/**
 * The declared gated suites. Throws when the derivation came back short of
 * MIN_GATED_SUITES: an empty selection would satisfy every iteration below while
 * running nothing, which is the failure this whole module is about.
 */
export function declaredSuiteFiles(root = process.cwd()) {
  const files = gatedSuiteFiles(root);
  if (files.length < MIN_GATED_SUITES) {
    throw new PgContractError(
      `no gated suite found: no file the test runner collects declares "${MARKER}", ` +
        `so the contract job would select nothing to run`,
    );
  }
  return files;
}

/**
 * Collected test files that read `DATABASE_URL` from the environment, in code
 * position, without declaring the marker — the static half of the gate, and the
 * only half that can see a suite gating by an early return. Comments and string
 * bodies are blanked first, so documentation and fixtures that quote the pattern
 * are not readers; a declaration is what such a file owes, and the DB-less run
 * says when that declaration looks stale.
 */
export function undeclaredGates(declared, root = process.cwd()) {
  const declaredSet = new Set(declared);
  return collectedSuites(root)
    .filter((file) => readsDatabaseUrl(readFileSync(resolve(root, file), "utf8")))
    .filter((file) => !declaredSet.has(file))
    .sort();
}

/**
 * The declared suites the assertions read. An empty derivation would satisfy every
 * filter below while running nothing, which is the failure this module is about, so
 * it is refused here rather than left to the caller to notice.
 */
function requireDeclared(declared) {
  if (declared.length < MIN_GATED_SUITES) {
    throw new PgContractError("no declared suite to check: the derivation found none");
  }
  return declared;
}

/**
 * The contract run executed everything it selected: every declared suite ran at
 * least one test and skipped none. A gated suite reaches this step either
 * executed or not at all, and "not at all" is what reddens here.
 */
export function assertExecuted(report, declared, root = process.cwd()) {
  const { unexecuted } = classify(report, requireDeclared(declared), root);
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
 * return leaves the report nothing to see. The other direction is a note, not a
 * failure: a declaration that skipped nothing, or that the run never collected, is
 * how a marker or an include glob goes stale, and a note leaves declaring a file
 * the cheap remedy for a mention the rule cannot tell from a read.
 */
export function assertMarked(report, declared, root = process.cwd()) {
  const { skippedAny, undeclaredSkips, neverSkipped, notCollected } = classify(
    report,
    requireDeclared(declared),
    root,
  );
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
  return {
    declared,
    diagnostics: [
      ...neverSkipped.map(
        (suite) => `${suite.file} declares "${MARKER}" but skipped nothing in this run`,
      ),
      ...notCollected.map(
        (suite) => `${suite.file} declares "${MARKER}" but this run never collected it`,
      ),
    ],
  };
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
