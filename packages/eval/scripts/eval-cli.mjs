/**
 * eval-cli.mjs — the CLI glue shared by `eval-run.mjs` and `eval-smoke.mjs`
 * (round-3 B2): the validated config load, the budget banner, the fixture
 * load, and the run summary. The harness itself (`createStagingHarness`,
 * `runGoldenSet`) already lives in shared seams; this removes the residual
 * per-script copies of the same lines, which had started to drift (eval:run
 * reads the ledger's cost record for its summary, eval:smoke used the live
 * budget). What stays per-script: the subset selection and the exit policy.
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
 * The run summary block both scripts print: per-direction score means, the
 * question counts, the skipped questions' causes, and the settled cost (the
 * ledger's record when it exists, else the live budget — the ledger is
 * authoritative once the row is written).
 */
export function printSummary(prefix, { runId, questionCount, result, costMicroUsd }) {
  const scored = result.results.filter((x) => x.skipped !== true);
  const skipped = result.results.filter((x) => x.skipped === true);
  console.log(
    [
      "",
      `${prefix} summary — run ${runId}`,
      `  questions: ${questionCount}  passed: ${result.passed}  failed: ${result.failed}  skipped: ${result.skipped}`,
      `  mean retrieval recall: ${mean(scored.map((x) => x.retrievalRecall))?.toFixed(3) ?? "n/a"}`,
      `  mean citation validity: ${mean(scored.map((x) => x.citationValidity))?.toFixed(3) ?? "n/a"}`,
      `  cost: ${(costMicroUsd / 1e6).toFixed(6)} USD  budget exceeded: ${result.budgetExceeded}`,
      ...expansionLines(scored),
      ...skipLines(skipped),
    ].join("\n"),
  );
}
