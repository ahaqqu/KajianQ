import * as v from "valibot";
import { CostRecordSchema } from "./trace-primitives";

/**
 * Summarizer-bench contracts: the fixture shape and committed run-file shape
 * for the ingest summarizer bench — the cheap-role parent summaries the
 * ingestion pipeline generates over primary-language excerpts. Domain-agnostic
 * like the other benches: titles, source keys, and excerpts are opaque
 * strings; the case's `kind` names which production prompt builder the
 * adapter must use (the kind vocabulary belongs to the composition root,
 * not this contract), and what is contractual is the checked shape
 * (sentence bounds, the faithfulness grounding the engine enforces), never
 * the wording.
 */

export const SummarizerCaseKindSchema = v.pipe(v.string(), v.minLength(1));

export const SummarizerExpectedSchema = v.object({
  minSentences: v.pipe(v.number(), v.integer(), v.minValue(1)),
  maxSentences: v.pipe(v.number(), v.integer(), v.minValue(1)),
  /** Theme terms the summary must include; absent = no lexical assertion. */
  mustMention: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
});

export const SummarizerCaseSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  kind: SummarizerCaseKindSchema,
  language: v.pipe(v.string(), v.minLength(1)),
  sourceKey: v.pipe(v.string(), v.minLength(1)),
  title: v.pipe(v.string(), v.minLength(1)),
  /** The Arabic primary lines the production summarizer is fed. */
  excerpt: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1)),
  expected: SummarizerExpectedSchema,
});

export const SummarizerBenchFixtureSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  status: v.picklist(["v0-draft", "canonical"]),
  cases: v.pipe(v.array(SummarizerCaseSchema), v.minLength(1)),
});

export type SummarizerBenchFixture = v.InferOutput<typeof SummarizerBenchFixtureSchema>;
export type SummarizerCase = v.InferOutput<typeof SummarizerCaseSchema>;

/** One scored case in a committed run file: the summary itself is the evidence. */
export const SummarizerBenchRunRecordSchema = v.object({
  caseId: v.pipe(v.string(), v.minLength(1)),
  language: v.pipe(v.string(), v.minLength(1)),
  /** JSON of the case's asserted bounds. */
  expected: v.pipe(v.string(), v.minLength(1)),
  /** The summary verbatim — the report prints it for the owner's read. */
  got: v.pipe(v.string(), v.minLength(1)),
  passed: v.boolean(),
  cost: v.optional(CostRecordSchema),
});

export type SummarizerBenchRunRecord = v.InferOutput<typeof SummarizerBenchRunRecordSchema>;

/** The committed run file — the same append-only discipline as the other benches. */
export const SummarizerBenchRunSchema = v.object({
  schema: v.literal(1),
  task: v.literal("summarizer-bench"),
  model: v.pipe(v.string(), v.minLength(1)),
  samples: v.object({
    version: v.pipe(v.number(), v.integer(), v.minValue(1)),
    casesSha256: v.pipe(v.string(), v.minLength(1)),
  }),
  promptsSha256: v.pipe(v.string(), v.minLength(1)),
  budget: v.object({
    capMicroUsd: v.nullable(v.number()),
    plannedCases: v.pipe(v.number(), v.integer(), v.minValue(1)),
    totalMicroUsd: v.pipe(v.number(), v.minValue(0)),
  }),
  totals: v.object({
    cases: v.pipe(v.number(), v.integer(), v.minValue(1)),
    scored: v.pipe(v.number(), v.integer(), v.minValue(0)),
    passed: v.pipe(v.number(), v.integer(), v.minValue(0)),
    accuracy: v.nullable(v.number()),
  }),
  gate: v.object({
    gatePass: v.boolean(),
    overallAccuracy: v.nullable(v.number()),
    failedLanguages: v.array(v.pipe(v.string(), v.minLength(1))),
    floors: v.object({
      overall: v.number(),
      perLanguage: v.number(),
      minCasesPerLanguage: v.pipe(v.number(), v.integer(), v.minValue(1)),
    }),
  }),
  aborted: v.optional(v.boolean()),
  error: v.optional(v.pipe(v.string(), v.minLength(1))),
  startedAt: v.pipe(v.string(), v.isoTimestamp()),
  finishedAt: v.pipe(v.string(), v.isoTimestamp()),
  records: v.array(SummarizerBenchRunRecordSchema),
});

export type SummarizerBenchRun = v.InferOutput<typeof SummarizerBenchRunSchema>;

/**
 * Parse an untrusted fixture payload with the cross-field check the schema
 * cannot express: the sentence bounds must be consistent — a max below the
 * min would fail every model for the fixture's sake.
 */
export function parseSummarizerBenchFixture(raw: unknown): SummarizerBenchFixture {
  const fixture = v.parse(SummarizerBenchFixtureSchema, raw);
  fixture.cases.forEach((c, i) => {
    if (c.expected.maxSentences < c.expected.minSentences) {
      throw new Error(
        `summarizer-bench fixture: case ${i} ("${c.id}") has maxSentences ${c.expected.maxSentences} below minSentences ${c.expected.minSentences}`,
      );
    }
  });
  return fixture;
}

/**
 * Parse an untrusted run-file payload with the same consistency checks the
 * other benches carry: the totals must be derivable from the records, an
 * aborted run must name its failure, and a complete one must not carry one.
 */
export function parseSummarizerBenchRun(raw: unknown): SummarizerBenchRun {
  const run = v.parse(SummarizerBenchRunSchema, raw);
  if (run.totals.scored > run.totals.cases) {
    throw new Error(
      `summarizer-bench run "${run.model}": scored ${run.totals.scored} cases exceeds the fixture's ${run.totals.cases}`,
    );
  }
  if (run.totals.scored !== run.records.length) {
    throw new Error(
      `summarizer-bench run "${run.model}": totals.scored ${run.totals.scored} does not match its ${run.records.length} records`,
    );
  }
  const passed = run.records.filter((r) => r.passed).length;
  if (run.totals.passed !== passed) {
    throw new Error(
      `summarizer-bench run "${run.model}": totals.passed ${run.totals.passed} does not match the ${passed} passing records`,
    );
  }
  const accuracy = run.totals.scored === 0 ? null : passed / run.totals.scored;
  if (run.totals.accuracy !== null && Math.abs(run.totals.accuracy - (accuracy ?? 0)) > 1e-9) {
    throw new Error(
      `summarizer-bench run "${run.model}": totals.accuracy ${run.totals.accuracy} does not match ${passed}/${run.totals.scored}`,
    );
  }
  if (run.aborted === true && (run.error === undefined || run.error.length === 0)) {
    throw new Error(`summarizer-bench run "${run.model}": aborted without an error message`);
  }
  if (run.aborted !== true && run.error !== undefined) {
    throw new Error(`summarizer-bench run "${run.model}": carries an error but is not aborted`);
  }
  return run;
}
