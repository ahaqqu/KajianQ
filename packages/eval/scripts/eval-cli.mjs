/**
 * eval-cli.mjs — the CLI glue shared by `eval-run.mjs` and `eval-smoke.mjs`: the
 * validated config load, the budget banner, the fixture load, and the exit policy,
 * with the run summary rendered by `eval-summary.mjs`. One copy, so the commands
 * cannot drift into opposite failure semantics.
 */
import { readFileSync } from "node:fs";
import * as evalpkg from "@app/eval";
// The trap marker is the domain pack's label vocabulary, imported rather than
// written as a literal so a rename cannot leave the gate looking for a stale tag.
import { DAIF_TRAP_LABEL } from "@app/kajianq-domain";

/** Print a prefixed failure and exit non-zero. */
export function fail(prefix, msg) {
  console.error(`${prefix}: ${msg}`);
  process.exit(1);
}

/** The one validated, typed config seam — no ad hoc process.env reads. */
export function loadConfig(prefix, env) {
  try {
    return evalpkg.loadEvalRunConfig(env);
  } catch (err) {
    fail(prefix, err instanceof Error ? err.message : String(err));
  }
}

/** The budget plus its one banner line (the only env echo the runs print). */
export function createBudget(prefix, config) {
  const budget = new evalpkg.Budget(config.budgetCapMicroUsd);
  console.log(
    `${prefix}: budget ${config.budgetCapMicroUsd === undefined ? "uncapped" : `${config.budgetCapMicroUsd} micro-USD`} (EVAL_BUDGET_MICRO_USD)`,
  );
  return budget;
}

/**
 * The Golden Set fixture from the validated config's path, validated against the
 * contract; `assertV0` adds the v0 content bar check, which only `eval:run` gates on.
 */
export function loadFixture(prefix, config, { assertV0 = false } = {}) {
  const fixturePath = `${process.cwd()}/${config.goldenSetPath}`;
  try {
    const fixture = evalpkg.loadGoldenSetJson(
      readFileSync(fixturePath, "utf8"),
      "golden-set-v0.json",
    );
    if (assertV0) evalpkg.assertV0Shape(fixture, { trapTag: DAIF_TRAP_LABEL });
    return fixture;
  } catch (err) {
    fail(prefix, err instanceof Error ? err.message : String(err));
  }
}

export { expansionLines, failureLines, printSummary, skipLines } from "./eval-summary.mjs";
/**
 * The exit policy both CLIs apply — the one place the gate's verdict is decided.
 * It reddens on any question that failed, any that was skipped, and any the run
 * never measured: `questionCount` is the set the caller handed `runGoldenSet`, and
 * fewer outcomes than that means the loop stopped early. The budget abort is
 * exactly that case — the harness breaks on the cap without counting the
 * remainder, so a half-measured release run would otherwise read green: an
 * unmeasured question is not a pass, whichever way it went unmeasured.
 *
 * Its counts come from `result.results`, the rows behind the per-question
 * `failed:`/`skipped:` lines rather than the counter-derived `questions:` headline,
 * so it cannot contradict those lines; a negative shortfall still reddens and names
 * itself rather than printing a negative count.
 *
 * Pure: it returns the verdict and the exact line to print, never exits, so
 * `tests/scripts/eval-cli.test.mjs` can pin every row (the glue is `.mjs`, outside
 * the typechecked corpus, where a `.ts` test importing it fails TS7016). `runId`
 * appears only in the red line.
 */
export function exitPolicy(prefix, { runId, questionCount, result }) {
  const scored = result.results.filter((x) => x.skipped !== true);
  const skipped = result.results.filter((x) => x.skipped === true).length;
  const failed = scored.filter((x) => x.passed !== true).length;
  const unmeasured = questionCount - result.results.length;
  if (failed === 0 && skipped === 0 && unmeasured === 0) {
    return { ok: true, message: `${prefix}: PASSED` };
  }
  const counts = [`${failed} failed`, `${skipped} skipped`];
  // The cap is named only when the run's own record says the cap was hit: no
  // cause is invented for a shortfall the data does not explain.
  if (unmeasured > 0) {
    counts.push(`${unmeasured} unmeasured${result.budgetExceeded ? " (budget exceeded)" : ""}`);
  } else if (unmeasured < 0) {
    // More rows than asked for: unreachable through the harness, but every red
    // line names a reason.
    counts.push(`${-unmeasured} recorded beyond the set asked`);
  }
  return {
    ok: false,
    message: `${prefix}: FAILED — ${counts.join(", ")}. See eval_results for run ${runId}.`,
  };
}

/**
 * Print `exitPolicy`'s verdict and exit non-zero when it reddens — the only
 * effectful half, so the decision stays testable. A red verdict goes to stderr
 * (a gate's failure belongs in the error stream), a green one to stdout.
 */
export function exitWithPolicy(prefix, input) {
  const { ok, message } = exitPolicy(prefix, input);
  if (ok) {
    console.log(message);
    return;
  }
  console.error(message);
  process.exit(1);
}
