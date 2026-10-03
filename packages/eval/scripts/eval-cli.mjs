/**
 * eval-cli.mjs — the CLI glue shared by `eval-run.mjs` and `eval-smoke.mjs`
 * (round-3 B2): the validated config load, the budget banner, the fixture
 * load, and the run summary. The harness itself (`createStagingHarness`,
 * `runGoldenSet`) already lives in shared seams; this removes the residual
 * per-script copies of the same lines, which had started to drift (eval:run
 * reads the ledger's cost record for its summary, eval:smoke used the live
 * budget). The exit policy is shared here too (#364): the two commands had
 * drifted into opposite failure semantics — the smoke reddened on a failed or
 * skipped question while the full suite exited 0 on either — and one copy is
 * what stops that recurring. What stays per-script: eval:smoke's subset
 * selection, and eval:run's v0 content-bar assertion and ledger-backed cost.
 */
import { readFileSync } from "node:fs";
import * as evalpkg from "@app/eval";

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
 * The Golden Set fixture from the validated config's path, validated against
 * the contract. `assertV0` adds the v0 content bar check (eval:run gates on
 * it; eval:smoke runs the same fixture already gated by eval:run).
 */
export function loadFixture(prefix, config, { assertV0 = false } = {}) {
  const fixturePath = `${process.cwd()}/${config.goldenSetPath}`;
  try {
    const fixture = evalpkg.loadGoldenSetJson(
      readFileSync(fixturePath, "utf8"),
      "golden-set-v0.json",
    );
    if (assertV0) evalpkg.assertV0Shape(fixture, { trapTag: "dhaif-trap" });
    return fixture;
  } catch (err) {
    fail(prefix, err instanceof Error ? err.message : String(err));
  }
}

export const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

/**
 * The per-question expansion provenance lines (C1). ADR-0045's scope expansion
 * satisfies the scored leg of `retrievalRecall` by construction for a question
 * that names a reference — the scorer reads chunk refs and never inspects
 * their `origin` — so a mean of 1.000 on those questions can hide a broken
 * fused track. Each scoped question prints its fused-only recall beside the
 * reported one, making the loosening observable in the run's own output; a
 * fused-only figure below the reported one is exactly "the expansion carried
 * this question". Reports older than the field print nothing extra.
 */
export function expansionLines(scored) {
  return scored
    .filter((x) => x.expansion !== undefined)
    .map(
      (x) =>
        `  scoped: ${x.questionId} — expansion chunks ${x.expansion.chunks}, fused-only recall ${x.expansion.fusedOnlyRetrievalRecall.toFixed(3)} (reported ${x.retrievalRecall.toFixed(3)})`,
    );
}

/**
 * The per-question lines for transport-skipped questions (#290). A skip is
 * excluded from the means above, so without its own line the count is the only
 * visible trace of it — and an operator reading the CI log could not tell a
 * client timeout from a 5xx without querying the store. The cause is printed
 * once: the persisted note already carries its own `skipped:` prefix
 * (`skippedOutcome`), and this line labels the row, so re-printing the prefix
 * would read `skipped: q3 — skipped: transport down`. Whitespace is collapsed
 * so one skip stays one log line whatever the transport error's own formatting
 * is, and an empty `notes` array takes the same fallback as an absent one.
 * Contract as `expansionLines`: `printSummary` hands it the run's skipped
 * results, while the predicate filter below keeps it correct if it is ever
 * handed the raw results too.
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
 * The fixture is a REQUIRED argument, never a defaulted one (round-2 B4).
 * Every label a `failed:` line carries — the expected source types and the
 * required citations — comes from it, so a call site that merely forgot it
 * would print the bare, unattributable value #340 exists to remove, and no
 * test would catch that: degrading to the bare value is the *correct*
 * rendering for a question the fixture genuinely does not hold. A caller with
 * no fixture must pass `[]` and say why in a line; an omission fails here
 * instead of silently costing the attribution.
 */
function requireFixture(questions, caller) {
  if (!Array.isArray(questions)) {
    throw new TypeError(
      `${caller}: requires the fixture's questions (pass [] explicitly if there is genuinely none) — an omitted fixture silently drops every rule label from the failure lines (#340)`,
    );
  }
}

/**
 * The per-question lines for scored questions that failed (#340). The counts
 * and the three means above never named one: a red run's only pointer was a
 * store read of `eval_results` on a run whose reader may hold no grant at all,
 * while the per-question outcomes were in memory at print time all along.
 *
 * Each line names the question, then every dimension that missed its rule with
 * the evidence behind it. The failing dimensions are the numeric ones below 1
 * — `retrievalRecall` and `citationValidity` — plus the behavior rule, which a
 * question expecting an `answer` misses by refusing (over-refusal is a defect)
 * and a question expecting a `refuse` misses by answering ungrounded
 * (ADR-0046). `questions` (the fixture in hand, never a store read) supplies
 * the rule's own labels: the expected source types and the required citations.
 * A question the fixture does not hold degrades to the bare value; the fixture
 * itself is required (`requireFixture`) so that degradation is only ever the
 * deliberate one.
 *
 * The behavior verdict is printed only where the outcome decides it. For an
 * `answer` question `refused` decides it; for a `refuse` question it is decided
 * when the other two dimensions are full (the question could not have failed
 * otherwise) and left unsaid when they are not — the line then attributes the
 * failure to the dimension the outcome does evidence rather than claim a miss
 * it does not. Spelled `behavior` to match the contract's `expectedBehavior`.
 *
 * Distinguished from `skipLines` twice over: this reads outcomes with
 * `skipped !== true`, that one the `skipped === true` rows, and the two labels
 * differ — a scored failure can never be misread as an unmeasured question.
 * A scored outcome with no failed dimension is one the ledger-write path
 * reddened alone (`harness.ts` records its cause in `notes`); it prints that
 * cause rather than an empty line, so the one run whose evidence is missing
 * from the store is not also silent in the log.
 */
export function failureLines(failed, questions) {
  requireFixture(questions, "failureLines");
  const byId = new Map(questions.map((q) => [q.id, q]));
  return failed
    .filter((x) => x.skipped !== true && x.passed !== true)
    .map((x) => {
      const question = byId.get(x.questionId);
      const rules = [];
      if (x.retrievalRecall < 1) {
        const expected = question?.expectedSourceTypes ?? [];
        const retrieved = Math.round(x.retrievalRecall * expected.length);
        rules.push(
          expected.length > 0
            ? `retrievalRecall=${x.retrievalRecall.toFixed(3)} (expected ${expected.join(", ")}, retrieved ${retrieved}/${expected.length})`
            : `retrievalRecall=${x.retrievalRecall.toFixed(3)}`,
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
        x.retrievalRecall === 1 &&
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
 * The run summary block both scripts print: per-direction score means, the
 * question counts, the failed questions' missed rules, the skipped questions'
 * causes, and the settled cost (the ledger's record when it exists, else the
 * live budget — the ledger is authoritative once the row is written).
 * `questions` is the caller's loaded fixture and is required — see
 * `requireFixture`.
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
      `  mean retrieval recall: ${mean(scored.map((x) => x.retrievalRecall))?.toFixed(3) ?? "n/a"}`,
      `  mean citation validity: ${mean(scored.map((x) => x.citationValidity))?.toFixed(3) ?? "n/a"}`,
      `  cost: ${(costMicroUsd / 1e6).toFixed(6)} USD  budget exceeded: ${result.budgetExceeded}`,
      ...expansionLines(scored),
      ...failureLines(failed, questions),
      ...skipLines(skipped),
    ].join("\n"),
  );
}

/**
 * The exit policy both CLIs apply (#364) — the one place the gate's verdict is
 * decided, so `eval:run` and `eval:smoke` cannot drift back into the opposite
 * semantics they held before this ticket. It reddens on any question that
 * failed, any question that was skipped, and any question the run never
 * measured: `questionCount` is the set the caller handed `runGoldenSet`, and
 * fewer outcomes than that means the loop stopped early. The budget abort is
 * exactly that case — `harness.ts` breaks on the cap without counting the
 * remainder, so `failed` and `skipped` both read 0 on a truncated run and a
 * two-clause policy would call a half-measured release run green. An unmeasured
 * question is not a pass, whichever way it went unmeasured.
 *
 * The counts it prints are derived from `result.results`, as `printSummary`
 * derives its own lines — one source of truth, so the FAILED line cannot
 * contradict the block above it (#370 A2). A negative shortfall, which no harness
 * path produces, still reddens and names that disagreement, not a negative
 * count.
 *
 * Pure: it returns the verdict and the exact line to print, never exits, so
 * `tests/scripts/eval-cli.test.mjs` pins every row (this glue is `.mjs`,
 * outside the typechecked corpus — a `.ts` test importing it fails TS7016).
 * `runId` only appears in the red line, and it is the run whose per-question
 * rows carry the attribution printed above it.
 */
export function exitPolicy(prefix, { runId, questionCount, result }) {
  // From the rows, as `printSummary` does (#370 A2) — never the run's counters.
  const scored = result.results.filter((x) => x.skipped !== true);
  const skipped = result.results.filter((x) => x.skipped === true).length;
  const failed = scored.filter((x) => x.passed !== true).length;
  const unmeasured = questionCount - result.results.length;
  if (failed === 0 && skipped === 0 && unmeasured === 0) {
    return { ok: true, message: `${prefix}: PASSED` };
  }
  const counts = [`${failed} failed`, `${skipped} skipped`];
  // The failed/skipped rendering is byte-identical to the smoke's pre-#364
  // line, so only the truncation case gains words. The cap is named only when
  // the run's own record says the cap was hit — the counts stay the ones
  // `printSummary` printed, and no cause is invented for a shortfall the data
  // does not explain.
  if (unmeasured > 0) {
    counts.push(`${unmeasured} unmeasured${result.budgetExceeded ? " (budget exceeded)" : ""}`);
  } else if (unmeasured < 0) {
    // The other direction of the same disagreement: more rows than asked for.
    // Unreachable through the harness, but the red must still name a reason.
    counts.push(`${-unmeasured} recorded beyond the set asked`);
  }
  return {
    ok: false,
    message: `${prefix}: FAILED — ${counts.join(", ")}. See eval_results for run ${runId}.`,
  };
}

/**
 * Print `exitPolicy`'s verdict and exit non-zero when it reddens — the only
 * effectful half, so both call sites stay one line and the decision itself
 * stays testable. A red verdict goes to stderr (the smoke has always written
 * there, and a gate's failure belongs in the error stream); a green one to
 * stdout.
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
