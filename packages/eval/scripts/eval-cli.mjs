/**
 * eval-cli.mjs — the CLI glue shared by `eval-run.mjs` and `eval-smoke.mjs`: the
 * validated config load, the budget banner, the fixture load, the run summary, and
 * the exit policy. One copy, so the two commands cannot drift into opposite failure
 * semantics.
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

export const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

/**
 * Scope-expanded questions print their fused-only source-type recall beside the
 * reported one: the scorer reads chunk refs and never their `origin`, so full
 * reported recall there can hide a broken fused track. No `expansion` field, no
 * line.
 */
export function expansionLines(scored) {
  return scored
    .filter((x) => x.expansion !== undefined)
    .map(
      (x) =>
        `  scoped: ${x.questionId} — expansion chunks ${x.expansion.chunks}, fused-only source-type recall ${x.expansion.fusedOnlySourceTypeRecall.toFixed(3)} (reported ${x.sourceTypeRecall.toFixed(3)})`,
    );
}

/**
 * The per-question lines for transport-skipped questions: a skip is excluded from
 * the score means, so without its own line the count is the only visible trace of
 * it. The persisted note already carries its own `skipped:` prefix, so the prefix is
 * stripped once, and whitespace is collapsed so one skip stays one line; an empty
 * `notes` array takes the same fallback as an absent one.
 */
export function skipLines(skipped) {
  return skipped
    .filter((x) => x.skipped === true)
    .map((x) => {
      const cause = (x.notes?.join("; ") || "").replace(/\s+/g, " ").replace(/^skipped:\s*/, "");
      return `  skipped: ${x.questionId} — ${cause || "no cause recorded"}`;
    });
}

/**
 * The fixture is a REQUIRED argument, never a defaulted one: every label a
 * `failed:` line carries comes from it, so a call site that forgot it would print
 * the bare, unattributable value — and the bare value is the correct rendering for a
 * question the fixture genuinely does not hold, so no test would catch it. A caller
 * with no fixture passes `[]`.
 */
function requireFixture(questions, caller) {
  if (!Array.isArray(questions)) {
    throw new TypeError(
      `${caller}: requires the fixture's questions (pass [] explicitly if there is genuinely none) — an omitted fixture silently drops every rule label from the failure lines (#340)`,
    );
  }
}

/**
 * The per-question lines for scored questions that failed. Each names the question,
 * then every dimension that missed its rule with the evidence: the numeric ones
 * below 1 (`sourceTypeRecall`, `citationAddressRecall`, `citationValidity`) plus
 * the behavior rule — an `answer` question misses it by refusing (over-refusal is
 * a defect), a `refuse` question by answering ungrounded. `questions` is the
 * fixture in hand, never a store read, and supplies the rule's own labels; a
 * question it does not hold degrades to the bare value, which `requireFixture`
 * makes the only degradation.
 *
 * The behavior verdict is printed only where the outcome decides it: for an
 * `answer` question `refused` decides it, for a `refuse` question only when the
 * other three dimensions are full, so the line attributes the failure to the
 * dimension the outcome does evidence rather than claim a miss it does not.
 * Spelled `behavior` to match `expectedBehavior`; an outcome with no failed
 * dimension prints its ledger-write cause rather than an empty line.
 */
export function failureLines(failed, questions) {
  requireFixture(questions, "failureLines");
  const byId = new Map(questions.map((q) => [q.id, q]));
  return failed
    .filter((x) => x.skipped !== true && x.passed !== true)
    .map((x) => {
      const question = byId.get(x.questionId);
      const rules = [];
      if (x.sourceTypeRecall < 1) {
        const expected = question?.expectedSourceTypes ?? [];
        const retrieved = Math.round(x.sourceTypeRecall * expected.length);
        rules.push(
          expected.length > 0
            ? `sourceTypeRecall=${x.sourceTypeRecall.toFixed(3)} (expected ${expected.join(", ")}, retrieved ${retrieved}/${expected.length})`
            : `sourceTypeRecall=${x.sourceTypeRecall.toFixed(3)}`,
        );
      }
      if (x.citationAddressRecall !== undefined && x.citationAddressRecall < 1) {
        const required = question?.requiredCitations ?? [];
        const surfaced = Math.round(x.citationAddressRecall * required.length);
        rules.push(
          required.length > 0
            ? `citationAddressRecall=${x.citationAddressRecall.toFixed(3)} (required ${required.join(", ")}, retrieved ${surfaced}/${required.length})`
            : `citationAddressRecall=${x.citationAddressRecall.toFixed(3)}`,
        );
      }
      if (x.citationValidity < 1) {
        const required = question?.requiredCitations ?? [];
        const present = Math.round(x.citationValidity * required.length);
        rules.push(
          required.length > 0
            ? `citationValidity=${x.citationValidity.toFixed(3)} (required ${required.join(", ")}, present ${present}/${required.length})`
            : `citationValidity=${x.citationValidity.toFixed(3)}`,
        );
      }
      if (x.expectedBehavior === "answer" && x.refused === true) {
        rules.push("behavior=over-refusal (expected an answer, the answer was refused)");
      } else if (
        x.expectedBehavior === "refuse" &&
        x.refused === false &&
        x.sourceTypeRecall === 1 &&
        x.citationAddressRecall === 1 &&
        x.citationValidity === 1
      ) {
        rules.push(
          "behavior=ungrounded-answer (expected a refusal or a grounded answer, refused=false with no verified citation)",
        );
      }
      if (rules.length === 0) {
        rules.push(`not-persisted (${x.notes?.join("; ") || "no cause recorded"})`);
      }
      return `  failed: ${x.questionId} ${rules.join("; ")}`;
    });
}

/**
 * `costMicroUsd` is the settled figure: the ledger's record when it exists, else the live
 * budget — the ledger is authoritative once the row is written. `questions` is required.
 */
export function printSummary(prefix, { runId, questionCount, result, costMicroUsd, questions }) {
  requireFixture(questions, "printSummary");
  const scored = result.results.filter((x) => x.skipped !== true);
  const skipped = result.results.filter((x) => x.skipped === true);
  const failed = scored.filter((x) => x.passed !== true);
  console.log(
    [
      "",
      `${prefix} summary — run ${runId}`,
      `  questions: ${questionCount}  passed: ${result.passed}  failed: ${result.failed}  skipped: ${result.skipped}`,
      `  mean source-type recall: ${mean(scored.map((x) => x.sourceTypeRecall))?.toFixed(3) ?? "n/a"}`,
      `  mean citation-address recall: ${
        mean(
          scored
            .filter((x) => x.citationAddressRecall !== undefined)
            .map((x) => x.citationAddressRecall),
        )?.toFixed(3) ?? "n/a"
      }`,
      `  mean citation validity: ${mean(scored.map((x) => x.citationValidity))?.toFixed(3) ?? "n/a"}`,
      `  cost: ${(costMicroUsd / 1e6).toFixed(6)} USD  budget exceeded: ${result.budgetExceeded}`,
      ...expansionLines(scored),
      ...failureLines(failed, questions),
      ...skipLines(skipped),
    ].join("\n"),
  );
}

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
