import * as v from "valibot";
import type { EvalResultOutcome } from "./eval";

/** Whether a question expects an answer or a refusal. */
export const ExpectedBehaviorSchema = v.picklist(["answer", "refuse"]);

/**
 * The persisted per-question outcome schema and its transform, split out of `eval.ts` to respect
 * the agentic size limits: the shape parses both the current metric names and the legacy ones, so
 * every ledger row ever written stays readable.
 */

/**
 * The persisted form, which also reads rows written under the metrics' earlier
 * names (`retrievalRecall`, `fusedOnlyRetrievalRecall`): the ledger keeps every
 * run readable, and an old run simply carries no address-recall measurement.
 */
const EvalResultOutcomeInputSchema = v.object({
  questionId: v.pipe(v.string(), v.minLength(1)),
  expectedBehavior: ExpectedBehaviorSchema,
  passed: v.boolean(),
  sourceTypeRecall: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
  /** The pre-rename name for `sourceTypeRecall`. */
  retrievalRecall: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
  citationAddressRecall: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
  citationValidity: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  quoteFidelity: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
  refused: v.boolean(),
  skipped: v.optional(v.boolean()),
  expansion: v.optional(
    v.object({
      chunks: v.pipe(v.number(), v.integer(), v.minValue(0)),
      fusedOnlySourceTypeRecall: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
      /** The pre-rename name for `fusedOnlySourceTypeRecall`. */
      fusedOnlyRetrievalRecall: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
      /** The citation-label lookup's contribution (ADR-0058). */
      lookup: v.optional(
        v.object({
          returned: v.pipe(v.number(), v.integer(), v.minValue(0)),
          missing: v.pipe(v.number(), v.integer(), v.minValue(0)),
          dropped: v.pipe(v.number(), v.integer(), v.minValue(0)),
          truncated: v.boolean(),
          carriedSourceTypes: v.array(v.pipe(v.string(), v.minLength(1))),
        }),
      ),
    }),
  ),
  notes: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
});

/** The per-question result verdict; parses both the current and the legacy field names. */
export const EvalResultOutcomeSchema = v.pipe(
  EvalResultOutcomeInputSchema,
  v.check(
    (outcome) =>
      (outcome.sourceTypeRecall !== undefined || outcome.retrievalRecall !== undefined) &&
      (outcome.expansion === undefined ||
        outcome.expansion.fusedOnlySourceTypeRecall !== undefined ||
        outcome.expansion.fusedOnlyRetrievalRecall !== undefined),
    "an outcome must carry sourceTypeRecall (or its legacy retrievalRecall), and an expansion block must carry fusedOnlySourceTypeRecall (or its legacy name)",
  ),
  v.transform((input): EvalResultOutcome => {
    const expansion = input.expansion;
    return {
      questionId: input.questionId,
      expectedBehavior: input.expectedBehavior,
      passed: input.passed,
      sourceTypeRecall: (input.sourceTypeRecall ?? input.retrievalRecall)!,
      ...(input.citationAddressRecall !== undefined
        ? { citationAddressRecall: input.citationAddressRecall }
        : {}),
      citationValidity: input.citationValidity,
      ...(input.quoteFidelity !== undefined ? { quoteFidelity: input.quoteFidelity } : {}),
      refused: input.refused,
      ...(input.skipped !== undefined ? { skipped: input.skipped } : {}),
      ...(expansion !== undefined
        ? {
            expansion: {
              chunks: expansion.chunks,
              fusedOnlySourceTypeRecall: (expansion.fusedOnlySourceTypeRecall ??
                expansion.fusedOnlyRetrievalRecall)!,
              ...(expansion.lookup !== undefined ? { lookup: expansion.lookup } : {}),
            },
          }
        : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    };
  }),
);
