/**
 * eval-summary.mjs — the run summary `eval-run.mjs` and `eval-smoke.mjs` print:
 * the per-question deterministic/failure/skip lines plus the aggregate means,
 * including the descriptive answer-size and citation figures. One copy, so the
 * two commands cannot render the same run differently.
 */
import * as evalpkg from "@app/eval";
export const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

// A row persisted before the metric has no `citationAddressRecall`; `undefined` is
// "never measured", so it is neither a miss nor a denominator row.
const hasAddressRecall = (x) => x.citationAddressRecall !== undefined;

/**
 * Questions whose retrieval used a deterministic path print the fused-only
 * source-type recall beside the reported one: the scorer reads chunk refs and
 * never their `origin`, so full reported recall there can hide a broken fused
 * track. A label-only question has no scope path, so its line names the lookup's
 * own contribution instead — the arm that carried the pass must be the line's
 * subject. No `expansion` field, no line.
 */
export function expansionLines(scored) {
  return scored
    .filter((x) => x.expansion !== undefined)
    .map((x) => {
      const parts = [];
      if (x.expansion.chunks > 0) parts.push(`scope chunks ${x.expansion.chunks}`);
      if (x.expansion.lookup !== undefined) {
        const { returned, missing, dropped, carriedSourceTypes } = x.expansion.lookup;
        parts.push(
          `lookup returned ${returned}, missing ${missing}, dropped ${dropped}${
            carriedSourceTypes.length > 0 ? ` (carried ${carriedSourceTypes.join(", ")})` : ""
          }`,
        );
      }
      parts.push(
        `fused-only source-type recall ${x.expansion.fusedOnlySourceTypeRecall.toFixed(3)} (reported ${x.sourceTypeRecall.toFixed(3)})`,
      );
      return `  deterministic: ${x.questionId} — ${parts.join("; ")}`;
    });
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
      if (hasAddressRecall(x) && x.citationAddressRecall < 1) {
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
 * budget. `questions` is required. `reportAddressMisses` is the reported-not-gated address
 * line: the smoke sets it because its sample cannot decide the full set, and the misses are
 * read from the run's own outcomes — never a caller-supplied list — with the sample as the
 * line's scope. The identity-satisfied figures are REPORTED beside the gate's counts, from
 * the same derivation the run report persists, and absent when no row carried a block.
 */
export function printSummary(
  prefix,
  { runId, questionCount, result, costMicroUsd, questions, reportAddressMisses },
) {
  requireFixture(questions, "printSummary");
  const scored = result.results.filter((x) => x.skipped !== true);
  const skipped = result.results.filter((x) => x.skipped === true);
  const failed = scored.filter((x) => x.passed !== true);
  const addressMeasured = scored.filter(hasAddressRecall);
  const quoteMeasured = scored.filter((x) => x.quoteFidelity !== undefined);
  const identitySatisfied = evalpkg.identitySatisfiedSummary(scored);
  // The same derivation the persisted report uses, so the printed size figures and
  // the stored ones cannot disagree.
  const answerMetrics = evalpkg.answerMetricsSummary(scored);
  const addressMisses = addressMeasured
    .filter((x) => x.citationAddressRecall < 1)
    .map((x) => x.questionId);
  console.log(
    [
      "",
      `${prefix} summary — run ${runId}`,
      `  questions: ${questionCount}  passed: ${result.passed}  failed: ${result.failed}  skipped: ${result.skipped}${identitySatisfied === undefined ? "" : `  identity-satisfied (reported): ${identitySatisfied.passed} of ${identitySatisfied.measured} rows, mean address recall ${identitySatisfied.meanCitationAddressRecall?.toFixed(3) ?? "n/a"}`}`,
      `  mean source-type recall: ${mean(scored.map((x) => x.sourceTypeRecall))?.toFixed(3) ?? "n/a"}`,
      `  mean citation-address recall: ${
        mean(addressMeasured.map((x) => x.citationAddressRecall))?.toFixed(3) ?? "n/a"
      }`,
      ...(reportAddressMisses === true
        ? [
            `  address recall: reported, not gated — address misses in this sample (${
              addressMisses.length
            } of ${addressMeasured.length} measured): ${
              addressMisses.length === 0 ? "none" : addressMisses.join(", ")
            }; the sample decides this line, not a full-set debt list`,
          ]
        : []),
      `  mean citation validity: ${mean(scored.map((x) => x.citationValidity))?.toFixed(3) ?? "n/a"}`,
      `  mean quote fidelity: ${mean(quoteMeasured.map((x) => x.quoteFidelity))?.toFixed(3) ?? "n/a"} (${quoteMeasured.length} of ${scored.length} answers measured)`,
      // Descriptive only, never a gate: the scored answers' own size and citation
      // count. `n/a` is "no answer was measured", never a measured zero.
      `  answer length (chars): mean ${answerMetrics.meanAnswerChars?.toFixed(1) ?? "n/a"}, max ${answerMetrics.maxAnswerChars ?? "n/a"}`,
      `  citations per answer: mean ${answerMetrics.meanCitationsPerAnswer?.toFixed(3) ?? "n/a"}, max ${answerMetrics.maxCitationsPerAnswer ?? "n/a"}`,
      `  cost: ${(costMicroUsd / 1e6).toFixed(6)} USD  budget exceeded: ${result.budgetExceeded}`,
      ...expansionLines(scored),
      ...failureLines(failed, questions),
      ...skipLines(skipped),
    ].join("\n"),
  );
}
