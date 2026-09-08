import * as v from "valibot";
import { CostRecordSchema } from "./trace";

/**
 * Evaluation contracts (#8): the Golden Set question shape, the per-question
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
 */
export const GoldenCitationSchema = v.pipe(v.string(), v.minLength(1));

/** The behavior the harness expects from the pipeline for this question. */
export const ExpectedBehaviorSchema = v.picklist(["answer", "refuse"]);

export const GoldenQuestionSchema = v.object({
  /** Stable question id within the set (e.g. "gs-v0-001"). */
  id: v.pipe(v.string(), v.minLength(1)),
  question: v.pipe(v.string(), v.minLength(1)),
  /** The language the question is asked in (BCP-47 style label). */
  language: v.pipe(v.string(), v.minLength(1)),
  /** Source types (opaque labels) a correct answer must draw from. */
  expectedSourceTypes: v.array(GoldenSourceSchema),
  /** Citation labels (opaque strings) a correct answer must include. */
  requiredCitations: v.array(GoldenCitationSchema),
  /** Whether the pipeline should answer or refuse. */
  expectedBehavior: ExpectedBehaviorSchema,
  /** Trap/coverage tags (e.g. a weak-grade trap, a refusal case). Opaque. */
  tags: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
});

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

/** The per-question result verdict. */
export const EvalResultOutcomeSchema = v.object({
  questionId: v.pipe(v.string(), v.minLength(1)),
  expectedBehavior: ExpectedBehaviorSchema,
  /** True when the pipeline behaved as the question expects. */
  passed: v.boolean(),
  /** Retrieval recall over the question's expected sources (0..1). */
  retrievalRecall: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  /** Fraction of required citations present in the answer (0..1). */
  citationValidity: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  /** Whether the scorer saw a refusal (a trace `refusal` event or refusal text). */
  refused: v.boolean(),
  /** Optional note (e.g. which required citation was missing). */
  notes: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
});

export type EvalResultOutcome = v.InferOutput<typeof EvalResultOutcomeSchema>;

/**
 * The aggregate report of one harness run (kajianq-traceability rule 4: eval
 * runs produce reports — stored and citable, never skipped). Persisted
 * verbatim to the `eval_runs` report ledger.
 */
export const EvalRunReportSchema = v.object({
  /** Correlates the report to the harness run that produced it. */
  runId: v.pipe(v.string(), v.minLength(1)),
  /** The Golden Set fixture id the run executed. */
  setId: v.pipe(v.string(), v.minLength(1)),
  startedAt: v.pipe(v.number(), v.integer()),
  finishedAt: v.pipe(v.number(), v.integer()),
  questions: v.pipe(v.number(), v.integer(), v.minValue(0)),
  passed: v.pipe(v.number(), v.integer(), v.minValue(0)),
  failed: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /** Skipped (e.g. budget abort, missing keys, scoring error) — not a pass. */
  skipped: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /** Mean retrieval recall over scored questions (null when none scored). */
  meanRetrievalRecall: v.nullable(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
  /** Mean citation validity over scored questions (null when none scored). */
  meanCitationValidity: v.nullable(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
  /** Total spend (harness + pipeline traces triggered), in micro-USD. */
  costMicroUsd: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /** True when the run aborted early because the budget cap was hit. */
  budgetExceeded: v.boolean(),
  /** Per-question outcomes, in run order. */
  results: v.array(EvalResultOutcomeSchema),
  /** Per-question cost records captured from traces. */
  costs: v.array(CostRecordSchema),
  /** Opaque run metadata (e.g. the API base used, model ids seen). */
  details: v.optional(v.record(v.string(), v.unknown())),
});

export type EvalRunReport = v.InferOutput<typeof EvalRunReportSchema>;

/** Parse an untrusted report payload (persisted JSONB) back into the type. */
export function parseEvalRunReport(report: unknown): EvalRunReport {
  return v.parse(EvalRunReportSchema, report);
}
