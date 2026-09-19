import {
  parseDecisionBenchFixture as parseWithCrossChecks,
  type DecisionBenchFixture,
} from "@app/contracts";
import { EvalConfigError } from "./eval-config";
import { budgetCapFromEnv } from "./budget";

/**
 * Decision-bench config + fixture loading (ADR-0042): same binder discipline
 * as `loadEmbedBenchConfig` — the env record is passed in, validated, and
 * typed before any spend; a malformed fixture fails the load, never a
 * silent skip (a fixture that silently drops cases lies about coverage).
 * One validation pass: the contract's `parseDecisionBenchFixture` does the
 * schema parse AND the cross-field ground-truth check (rerank bestIndex in
 * range); this module only wraps failures with the fixture's source label.
 */

export class DecisionBenchLoadError extends Error {
  constructor(
    readonly source: string,
    readonly issues: readonly string[],
  ) {
    super(`decision-bench fixture "${source}" failed validation: ${issues.join("; ")}`);
  }
}

/** Validate an already-parsed fixture object against the contract. */
export function parseDecisionBenchFixture(raw: unknown, source = "inline"): DecisionBenchFixture {
  try {
    return parseWithCrossChecks(raw);
  } catch (cause) {
    throw new DecisionBenchLoadError(source, [String(cause)]);
  }
}

/** Load a fixture from a JSON string (the CLI reads the file; I/O-free here). */
export function loadDecisionBenchFixtureJson(
  json: string,
  source = "inline",
): DecisionBenchFixture {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (cause) {
    throw new DecisionBenchLoadError(source, [`invalid JSON: ${String(cause)}`]);
  }
  return parseDecisionBenchFixture(raw, source);
}

/** Default fixture: the domain pack's versioned multilingual case set. */
export const DECISION_BENCH_DEFAULT_FIXTURE_PATH =
  "packages/kajianq-domain/fixtures/decision-bench-v0.json";

/** Validated, typed configuration for one `eval:decision-bench` invocation. */
export type DecisionBenchConfig = {
  /** Hard spend cap in micro-USD (unset/0 = explicit opt-out). */
  budgetCapMicroUsd: number | undefined;
  /** Fixture path. */
  fixturePath: string;
  /** Output report path (JSON, defaults next to the fixture). */
  reportPath: string;
};

export function loadDecisionBenchConfig(
  env: Record<string, string | undefined>,
): DecisionBenchConfig {
  let budgetCapMicroUsd: number | undefined;
  try {
    // The canonical fail-closed parse (ADR-0034 decision 2) — no local copy.
    budgetCapMicroUsd = budgetCapFromEnv(env.EVAL_BUDGET_MICRO_USD);
  } catch (cause) {
    throw new EvalConfigError(String(cause instanceof Error ? cause.message : cause));
  }
  return {
    budgetCapMicroUsd,
    fixturePath: env.DECISION_BENCH_FIXTURE_PATH?.trim() || DECISION_BENCH_DEFAULT_FIXTURE_PATH,
    reportPath:
      env.DECISION_BENCH_REPORT_PATH?.trim() ||
      "packages/kajianq-domain/fixtures/decision-bench-results.json",
  };
}
