import * as v from "valibot";
import { EvalResultOutcomeSchema, ExpectedBehaviorSchema } from "./eval-outcome";
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
 * Every label in a question's `requiredCitations` is required — there is no
 * "any of" form. An empty list means the question has no citation requirement.
 */
export const GoldenCitationSchema = v.pipe(v.string(), v.minLength(1));

/** The behavior the harness expects from the pipeline for this question. */
export const GoldenQuestionSchema = v.object({
  /** Stable question id within the set (e.g. "gs-v0-001"). */
  id: v.pipe(v.string(), v.minLength(1)),
  question: v.pipe(v.string(), v.minLength(1)),
  /** The language the question is asked in (BCP-47 style label). */
  language: v.pipe(v.string(), v.minLength(1)),
  /** Source types (opaque labels) a correct answer must draw from. */
  expectedSourceTypes: v.array(GoldenSourceSchema),
  /** Citation labels (opaque strings) a correct answer must include; all are required. */
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
   * least one chunk the answer cites (0..1). Absent when the answer quoted nothing — a refusal
   * that quotes nothing has no fidelity to measure, and must not read as verified evidence.
   * Verifies existence, not attribution: a span found in any cited chunk counts.
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
  /** Optional note (e.g. which required citation was missing). */
  notes?: string[] | undefined;
};

export { EvalResultOutcomeSchema, ExpectedBehaviorSchema } from "./eval-outcome";

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
   * Mean quote fidelity over the answers that quoted something (0..1), or null when none did.
   * Per-question scores live in `results`; an answer that quoted nothing is excluded rather
   * than counted as perfect.
   */
  meanQuoteFidelity?: number | null | undefined;
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
