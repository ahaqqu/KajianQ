// The persisted per-question eval outcome contract: the type the harness writes and the
// schema that parses it back, including rows written under the metrics' earlier names.
import * as v from "valibot";

/** Whether a question expects an answer or a refusal. */
export const ExpectedBehaviorSchema = v.picklist(["answer", "refuse"]);

/** The per-question result verdict the harness writes. */
export type EvalResultOutcome = {
  questionId: string;
  expectedBehavior: "answer" | "refuse";
  /** True when the question passed the run's gate: the expected behaviour plus every
   * dimension that run gated on. The deployed smoke reports, but does not gate on,
   * citation-address recall while a known retrieval gap stands. */
  passed: boolean;
  /**
   * Source-type recall: the fraction of the question's expected source types
   * found among the retrieval event's chunks (0..1). It answers "did retrieval
   * reach the right kind of source", not "did it reach the required address".
   */
  sourceTypeRecall: number;
  /**
   * Citation-address recall: the fraction of the question's required citations
   * whose **specific address** the retrieval event's chunks carry (0..1), in
   * the citation grammar's comparison form. Every required citation is
   * required; an empty list scores 1. Absent only on rows persisted before the
   * metric existed — those runs never measured it.
   */
  citationAddressRecall?: number | undefined;
  /** Fraction of required citations present in the answer (0..1). */
  citationValidity: number;
  /**
   * Quote fidelity: the fraction of the answer's quoted spans that appear, in order, in at
   * least one chunk the answer cites (0..1). Report-only: no gate reads it, and it never
   * changes `passed`. Absent in three states, none of which is a failed claim: the answer
   * quoted nothing (a refusal), the citations frame carried no chunk text, or every span was
   * shorter than the minimum quotation length. Verifies existence, not attribution: a span
   * found in any cited chunk counts.
   */
  quoteFidelity?: number | undefined;
  /** Whether the scorer saw a refusal (a trace `refusal` event or refusal text). */
  refused: boolean;
  /**
   * True when the question never scored (transport/scoring failure) —
   * excluded from the report's scored means and never counted as a scored
   * failure.
   */
  skipped?: boolean | undefined;
  /**
   * Deterministic-path provenance, when the question's retrieval used one.
   * `sourceTypeRecall` never inspects a ref's `origin` label, so a question that
   * names a reference is satisfied **by construction** whenever a deterministic
   * read works, and a fused-track regression on exactly those questions is
   * invisible in `sourceTypeRecall` alone. This block makes it visible,
   * deterministically: `fusedOnlySourceTypeRecall` is what the refs with no
   * origin label score — a number below `sourceTypeRecall` means a deterministic
   * arm carried the question. `chunks` is the **scope** read's count; `lookup`
   * is the citation-label lookup's own contribution, present exactly when that
   * path ran. Absent = no deterministic read was recorded.
   */
  expansion?:
    | {
        chunks: number;
        fusedOnlySourceTypeRecall: number;
        /** The lookup's own contribution (ADR-0058); the trace event's fields. */
        lookup?:
          | {
              returned: number;
              missing: number;
              dropped: number;
              truncated: boolean;
              carriedSourceTypes: string[];
            }
          | undefined;
      }
    | undefined;
  /**
   * REPORTED, NEVER GATING: the row's two citation dimensions and its verdict under
   * the signed identity relation — the same report, or a curated same-ruling
   * relation — instead of the exact-address requirement. `citationAddressRecall`
   * here counts a retrieved identity as satisfying the requirement; `passed` is the
   * counterfactual of the run's own gate with that address reading. It never
   * contributes to `passed`, the run's `passed`, or the exit policy. Absent when no
   * identity map was injected, so a run that gates on exact addresses only keeps its
   * historical shape.
   */
  identitySatisfied?:
    | {
        citationAddressRecall: number;
        citationValidity: number;
        passed: boolean;
      }
    | undefined;
  /** Optional note (e.g. which required citation was missing, or how many quoted spans no
   * cited chunk carried). */
  notes?: string[] | undefined;
};

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
  identitySatisfied: v.optional(
    v.object({
      citationAddressRecall: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
      citationValidity: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
      passed: v.boolean(),
    }),
  ),
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
      ...(input.identitySatisfied !== undefined
        ? { identitySatisfied: input.identitySatisfied }
        : {}),
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
