import * as v from "valibot";
import {
  EvalResultOutcomeSchema,
  ExpectedBehaviorSchema,
  type EvalResultOutcome,
} from "./eval-outcome";
import { CostRecordSchema, type CostRecord } from "./trace";

/**
 * Evaluation contracts: the Golden Set question shape, the per-question
 * result outcome, and the aggregate run report. Shared by the eval harness
 * (`@app/eval`), the RagStore eval ledger (persisted JSONB), and the eval CLI.
 *
 * Domain-agnostic by design (AGENTS.md rule 1): a question's expected sources
 * and citations are opaque label strings; the domain pack (kajianq-domain)
 * defines the label vocabulary in its fixture. The engine never names a
 * source type or citation format.
 */

/** Source-type labels of an expected citation. Opaque to the engine. */
export const GoldenSourceSchema = v.pipe(v.string(), v.minLength(1));

/**
 * A citation the answer is expected to include, as an opaque label string
 * (the domain pack owns the format, e.g. "QS. 2:255" or "HR. Bukhari no. 1").
 * The deterministic scorer compares labels, so the harness stays
 * citation-format-agnostic.
 *
 * Every label in a question's `requiredCitations` is required — the all-required
 * (AND) form is the default and stays the default. A question may OPT IN, through
 * `citationAlternatives`, to a curator's set of additional citations that satisfy
 * its one requirement; no list in this contract is silently read as "any of".
 * An empty list means the question has no citation requirement.
 */
export const GoldenCitationSchema = v.pipe(v.string(), v.minLength(1));

/** The behavior the harness expects from the pipeline for this question. */
const GoldenQuestionShape = v.object({
  /** Stable question id within the set (e.g. "gs-v0-001"). */
  id: v.pipe(v.string(), v.minLength(1)),
  question: v.pipe(v.string(), v.minLength(1)),
  /** The language the question is asked in (BCP-47 style label). */
  language: v.pipe(v.string(), v.minLength(1)),
  /** Source types (opaque labels) a correct answer must draw from. */
  expectedSourceTypes: v.array(GoldenSourceSchema),
  /** Citation labels (opaque strings) a correct answer must include; all are required. */
  requiredCitations: v.array(GoldenCitationSchema),
  /**
   * OPT-IN any-of requirement: citations that also satisfy this question's single
   * required citation. A curator names a set when the question admits several valid
   * answers that are different reports — an identity relation is the wrong vehicle
   * for that, because identity means one report. Validity accepts any member, and
   * address recall accepts a retrieved member; absent, the all-required default is
   * unchanged. Legal only on a question with exactly one required citation, which
   * is the requirement the set widens.
   */
  citationAlternatives: v.optional(v.pipe(v.array(GoldenCitationSchema), v.minLength(1))),
  /** Whether the pipeline should answer or refuse. */
  expectedBehavior: ExpectedBehaviorSchema,
  /** Trap/coverage tags (e.g. a weak-grade trap, a refusal case). Opaque. */
  tags: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
});

/** A Golden Set question, with the opt-in alternative set bounded to one requirement. */
export const GoldenQuestionSchema = v.pipe(
  GoldenQuestionShape,
  v.check(
    (question) =>
      question.citationAlternatives === undefined ||
      (question.requiredCitations.length === 1 &&
        !question.citationAlternatives.some((alternative) =>
          question.requiredCitations.some((required) => required.trim() === alternative.trim()),
        )),
    "citationAlternatives widens exactly one required citation and may not repeat it",
  ),
);

export type GoldenQuestion = v.InferOutput<typeof GoldenQuestionSchema>;

/** A Golden Set fixture: the versioned question file the loader validates. */
export const GoldenSetSchema = v.object({
  /** Fixture identity, e.g. "golden-set-v0". */
  id: v.pipe(v.string(), v.minLength(1)),
  /** Fixture status; "v0-draft" until the owner signs the content off. */
  status: v.picklist(["v0-draft", "canonical"]),
  questions: v.pipe(v.array(GoldenQuestionSchema), v.minLength(1)),
});

export type GoldenSet = v.InferOutput<typeof GoldenSetSchema>;

export { EvalResultOutcomeSchema, ExpectedBehaviorSchema } from "./eval-outcome";
export type { EvalResultOutcome } from "./eval-outcome";

/**
 * The aggregate report of one harness run (kajianq-traceability rule 4: eval
 * runs produce reports — stored and citable, never skipped). Persisted
 * verbatim to the `eval_runs` report ledger.
 */
export type EvalRunReport = {
  /** Correlates the report to the harness run that produced it. */
  runId: string;
  /** The Golden Set fixture id the run executed. */
  setId: string;
  startedAt: number;
  finishedAt: number;
  questions: number;
  passed: number;
  failed: number;
  /** Skipped (e.g. budget abort, missing keys, scoring error) — not a pass. */
  skipped: number;
  /** Mean source-type recall over scored questions (null when none scored). */
  meanSourceTypeRecall: number | null;
  /** Mean citation-address recall over the scored questions that carry the
   * measurement — a row persisted before the metric existed is excluded, not
   * counted as zero; null when none carry it. Absent on pre-metric reports. */
  meanCitationAddressRecall?: number | null | undefined;
  /** Mean citation validity over scored questions (null when none scored). */
  meanCitationValidity: number | null;
  /**
   * Mean quote fidelity over the scored answers that carried a measurement (0..1), or null
   * when none did. `quoteFidelityMeasured` is its denominator: a perfect mean over two
   * answers must not read as a perfect mean over a hundred. Per-question scores live in
   * `results`; an answer that quoted nothing is excluded rather than counted as perfect.
   * Report-only: no gate reads it.
   */
  meanQuoteFidelity?: number | null | undefined;
  /**
   * How many scored answers carried a `quoteFidelity` measurement — the denominator of
   * `meanQuoteFidelity`. Absent when none was measured, and on reports written before the
   * field existed.
   */
  quoteFidelityMeasured?: number | undefined;
  /**
   * REPORTED, NEVER GATING: how many scored rows would pass if a signed identity —
   * the same report, or a curated same-ruling relation — satisfied the citation
   * and address requirements. The gate's `passed` and the run's `passed` never read
   * it, and it never contributes to the exit policy; it exists so the residual a
   * strictly-exact address gate leaves behind is visible as a number. Absent when
   * no identity map was injected.
   */
  identitySatisfiedPassed?: number | undefined;
  /**
   * REPORTED, NEVER GATING: mean identity-satisfied citation-address recall over
   * the scored rows that carry the measurement (null when none did). The exact
   * `meanCitationAddressRecall` stays the gate's number; this one answers what the
   * same retrieval would score if a signed identity satisfied the address.
   */
  meanIdentitySatisfiedCitationAddressRecall?: number | null | undefined;
  /** Total spend (harness + pipeline traces triggered), in micro-USD. */
  costMicroUsd: number;
  /** True when the run aborted early because the budget cap was hit. */
  budgetExceeded: boolean;
  /** Per-question outcomes, in run order. */
  results: EvalResultOutcome[];
  /** Per-question cost records captured from traces. */
  costs: CostRecord[];
  /** Opaque run metadata (e.g. the API base used, model ids seen). */
  details?: Record<string, unknown> | undefined;
};

/** The persisted report form, accepting the metrics' pre-rename field names. */
const EvalRunReportInputSchema = v.object({
  runId: v.pipe(v.string(), v.minLength(1)),
  setId: v.pipe(v.string(), v.minLength(1)),
  startedAt: v.pipe(v.number(), v.integer()),
  finishedAt: v.pipe(v.number(), v.integer()),
  questions: v.pipe(v.number(), v.integer(), v.minValue(0)),
  passed: v.pipe(v.number(), v.integer(), v.minValue(0)),
  failed: v.pipe(v.number(), v.integer(), v.minValue(0)),
  skipped: v.pipe(v.number(), v.integer(), v.minValue(0)),
  meanSourceTypeRecall: v.optional(v.nullable(v.pipe(v.number(), v.minValue(0), v.maxValue(1)))),
  /** The pre-rename name for `meanSourceTypeRecall`. */
  meanRetrievalRecall: v.optional(v.nullable(v.pipe(v.number(), v.minValue(0), v.maxValue(1)))),
  meanCitationAddressRecall: v.optional(
    v.nullable(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
  ),
  meanCitationValidity: v.nullable(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
  meanQuoteFidelity: v.optional(v.nullable(v.pipe(v.number(), v.minValue(0), v.maxValue(1)))),
  quoteFidelityMeasured: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  identitySatisfiedPassed: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  meanIdentitySatisfiedCitationAddressRecall: v.optional(
    v.nullable(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
  ),
  costMicroUsd: v.pipe(v.number(), v.integer(), v.minValue(0)),
  budgetExceeded: v.boolean(),
  results: v.array(EvalResultOutcomeSchema),
  costs: v.array(CostRecordSchema),
  details: v.optional(v.record(v.string(), v.unknown())),
});

export const EvalRunReportSchema = v.pipe(
  EvalRunReportInputSchema,
  v.check(
    (report) =>
      report.meanSourceTypeRecall !== undefined || report.meanRetrievalRecall !== undefined,
    "a report must carry meanSourceTypeRecall (or its legacy meanRetrievalRecall)",
  ),
  v.transform((input): EvalRunReport => ({
    runId: input.runId,
    setId: input.setId,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    questions: input.questions,
    passed: input.passed,
    failed: input.failed,
    skipped: input.skipped,
    // `null` is a real value ("no scored questions"), so only an ABSENT current
    // field falls back to the legacy one.
    meanSourceTypeRecall:
      input.meanSourceTypeRecall !== undefined
        ? input.meanSourceTypeRecall
        : input.meanRetrievalRecall!,
    ...(input.meanCitationAddressRecall !== undefined
      ? { meanCitationAddressRecall: input.meanCitationAddressRecall }
      : {}),
    meanCitationValidity: input.meanCitationValidity,
    ...(input.meanQuoteFidelity !== undefined
      ? { meanQuoteFidelity: input.meanQuoteFidelity }
      : {}),
    ...(input.quoteFidelityMeasured !== undefined
      ? { quoteFidelityMeasured: input.quoteFidelityMeasured }
      : {}),
    ...(input.identitySatisfiedPassed !== undefined
      ? { identitySatisfiedPassed: input.identitySatisfiedPassed }
      : {}),
    ...(input.meanIdentitySatisfiedCitationAddressRecall !== undefined
      ? {
          meanIdentitySatisfiedCitationAddressRecall:
            input.meanIdentitySatisfiedCitationAddressRecall,
        }
      : {}),
    costMicroUsd: input.costMicroUsd,
    budgetExceeded: input.budgetExceeded,
    results: [...input.results],
    costs: [...input.costs],
    ...(input.details !== undefined ? { details: input.details } : {}),
  })),
);

/** Parse an untrusted report payload (persisted JSONB) back into the type. */
export function parseEvalRunReport(report: unknown): EvalRunReport {
  return v.parse(EvalRunReportSchema, report);
}
