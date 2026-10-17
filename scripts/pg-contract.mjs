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
 *       Fail unless every suite the DB-less run skipped in full is declared.
 *       This is the half that catches a gated suite that forgot the marker.
 *
 *   bun scripts/pg-contract.mjs --touched <changed-files.txt>
 *       Print `touched=true|false`: whether those changed paths can alter what
 *       the contract suites execute. The job engages on `true`.
 *
 * Exit codes: 0 pass, 1 a failing gate, 2 usage or unreadable input.
 */
import { readFileSync } from "node:fs";
import {
  PgContractError,
  UsageError,
  assertExecuted,
  assertMarked,
  contractRelevant,
  declaredSuiteFiles,
  readReport,
} from "./pg-contract/policy.mjs";

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
    return readFileSync(path, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
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
