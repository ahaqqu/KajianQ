#!/usr/bin/env bun
/**
 * Driver for the real-Postgres contract gate — the policy it enforces is in
 * `scripts/pg-contract/policy.mjs`.
 *
 *   bun scripts/pg-contract.mjs --list
 *       Print the declared gated suites, one repo-relative path per line. The
 *       `postgres:contract` job passes this list to the runner, so what runs is
 *       derived from the tree: a suite that declares the marker is selected
 *       with nobody remembering to wire it. Paths are word-split by the caller,
 *       so a path with whitespace would not survive; none exists here.
 *
 *   bun scripts/pg-contract.mjs --require-executed <report.json>
 *       Fail unless every declared suite executed in that run's vitest JSON
 *       report — the run itself is the evidence that the gate is real.
 *
 *   bun scripts/pg-contract.mjs --require-marked <report.json>
 *       Fail unless every file the DB-less run skipped a test in is declared, unless
 *       every test file that reads DATABASE_URL in code position declares the marker,
 *       and unless every declaration is one that run saw gate something. Two rules,
 *       because a suite can hide by skipping (which the report sees) or by returning
 *       early (which only the tree sees); the third check is what keeps a declaration
 *       from being a way out of the first.
 *
 *   bun scripts/pg-contract.mjs --touched <changed-files.txt>
 *       Print `touched=true|false`: whether those changed paths can alter what
 *       the contract suites execute. The job engages on `true`.
 *
 * Exit codes: 0 pass, 1 a failing gate, 2 usage or unreadable input.
 */
import { readFileSync } from "node:fs";
import { PgContractError, UsageError } from "./pg-contract/errors.mjs";
import {
  assertExecuted,
  assertMarked,
  contractRelevant,
  declaredSuiteFiles,
} from "./pg-contract/policy.mjs";
import { readReport } from "./pg-contract/report.mjs";
import { splitPathList } from "./pg-contract/tree.mjs";

const USAGE = `usage:
  bun scripts/pg-contract.mjs --list
  bun scripts/pg-contract.mjs --require-executed <report.json>
  bun scripts/pg-contract.mjs --require-marked <report.json>
  bun scripts/pg-contract.mjs --touched <changed-files.txt>`;

function required(mode, arg) {
  if (!arg) throw new UsageError(`${mode} needs one argument\n${USAGE}`);
  return arg;
}

function readChanged(path) {
  try {
    // The workflow writes this list NUL-separated (`git diff -z`, the one form
    // that never quotes a path — a quoted one would match no declared suite); a
    // hand-written probe file is newline-separated. The list is split on whichever
    // delimiter it carries, never on both: a path may hold a newline.
    return splitPathList(readFileSync(path, "utf8"));
  } catch {
    throw new UsageError(
      `no changed-file list at ${path}: refusing to decide whether the contract job runs`,
    );
  }
}

function main([mode, arg]) {
  const root = process.cwd();
  switch (mode) {
    case "--list":
      process.stdout.write(`${declaredSuiteFiles(root).join("\n")}\n`);
      return;
    case "--require-executed":
      assertExecuted(readReport(required(mode, arg)), declaredSuiteFiles(root), root);
      return;
    case "--require-marked":
      assertMarked(readReport(required(mode, arg)), declaredSuiteFiles(root), root);
      return;
    case "--touched": {
      const changed = readChanged(required(mode, arg));
      process.stdout.write(`touched=${contractRelevant(changed, declaredSuiteFiles(root))}\n`);
      return;
    }
    default:
      throw new UsageError(mode ? `unknown mode: ${mode}\n${USAGE}` : USAGE);
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof PgContractError)) throw error;
  console.error(`pg-contract: ${error.message}`);
  process.exitCode = error.exitCode;
}
