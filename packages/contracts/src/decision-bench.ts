import * as v from "valibot";
import { CostRecordSchema } from "./trace-primitives";

/**
 * Decision-bench contracts (ADR-0042): the fixture shape for the multilingual
 * decision-model gate — RAG-relevant judgment tasks (relevance screening,
 * rerank choice, citation verification) over passages in each content
 * language. Domain-agnostic like the Golden Set: passages, queries, and
 * language labels are opaque strings owned by the domain pack's fixture.
 */

/** The bench's task vocabulary — engine-level, domain-free by design. */
export const DecisionTaskSchema = v.picklist(["relevance", "rerank", "citation"]);

export type DecisionTask = v.InferOutput<typeof DecisionTaskSchema>;

/** One relevance-screening case: does the passage answer the query? */
export const RelevanceCaseSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  /** BCP-47-style language label of the passage+query pair (e.g. "ar"). */
  language: v.pipe(v.string(), v.minLength(1)),
  query: v.pipe(v.string(), v.minLength(1)),
  passage: v.pipe(v.string(), v.minLength(1)),
  /** Ground truth: true when the passage is relevant evidence for the query. */
  relevant: v.boolean(),
});

/** One rerank case: which candidate passage best answers the query. */
export const RerankCaseSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  language: v.pipe(v.string(), v.minLength(1)),
  query: v.pipe(v.string(), v.minLength(1)),
  /** Candidate passages; `bestIndex` is the ground-truth answer. */
  candidates: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(2)),
  bestIndex: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

/** One citation-verification case: does the passage support the quote as claimed? */
export const CitationCaseSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  language: v.pipe(v.string(), v.minLength(1)),
  /** The claim an answer might make (quotes the passage as its evidence). */
  claim: v.pipe(v.string(), v.minLength(1)),
  passage: v.pipe(v.string(), v.minLength(1)),
  /** Ground truth: true when the passage genuinely supports the claim. */
  supports: v.boolean(),
});

/** The fixture: every task × language cell the gate scores. */
export const DecisionBenchFixtureSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  status: v.picklist(["v0-draft", "canonical"]),
  relevance: v.array(RelevanceCaseSchema),
  rerank: v.array(RerankCaseSchema),
  citation: v.array(CitationCaseSchema),
});

export type DecisionBenchFixture = v.InferOutput<typeof DecisionBenchFixtureSchema>;
export type RelevanceCase = v.InferOutput<typeof RelevanceCaseSchema>;
export type RerankCase = v.InferOutput<typeof RerankCaseSchema>;
export type CitationCase = v.InferOutput<typeof CitationCaseSchema>;

/**
 * The per-task question templates a decision-bench run consumes. Shared here
 * (not in the eval engine) because both consumers sit across the dependency
 * arrow: the domain pack authors the wording, the eval runner consumes it —
 * contracts is the one package both already depend on.
 */
export type DecisionBenchPrompts = {
  relevance: {
    instructions: (c: RelevanceCase) => string;
    criteria: { true: string; false: string };
  };
  rerank: {
    instructions: (c: RerankCase) => string;
    criteria: (c: RerankCase) => Record<string, string | null>;
  };
  citation: {
    instructions: (c: CitationCase) => string;
    criteria: { true: string; false: string };
  };
};

/**
 * Parse an untrusted fixture payload, with the cross-field check the schema
 * cannot express: a rerank case's `bestIndex` must point at a real candidate
 * — a fixture whose ground truth dangles would score a correct answer as a
 * failure, so it fails the load loudly instead.
 */
export function parseDecisionBenchFixture(raw: unknown): DecisionBenchFixture {
  const fixture = v.parse(DecisionBenchFixtureSchema, raw);
  fixture.rerank.forEach((c, i) => {
    if (c.bestIndex >= c.candidates.length) {
      throw new Error(
        `decision-bench fixture: rerank case ${i} ("${c.id}") has bestIndex ${c.bestIndex} outside its ${c.candidates.length} candidates`,
      );
    }
  });
  return fixture;
}

/**
 * One scored case inside a committed run file: the judgment it recorded and
 * the metered spend of the call that produced it (verbatim CostRecord, so
 * the report derives cost and latency from evidence, never from a summary).
 */
export const DecisionBenchRunRecordSchema = v.object({
  caseId: v.pipe(v.string(), v.minLength(1)),
  task: DecisionTaskSchema,
  language: v.pipe(v.string(), v.minLength(1)),
  expected: v.union([v.string(), v.number(), v.boolean()]),
  got: v.union([v.string(), v.number(), v.boolean()]),
  passed: v.boolean(),
  cost: v.optional(CostRecordSchema),
});

export type DecisionBenchRunRecord = v.InferOutput<typeof DecisionBenchRunRecordSchema>;

/**
 * The committed run file (ADR-0042 bench store): one append-only record per
 * candidate arm. A run pins what it measured — the samples seal version and
 * cases hash, the prompt-wording hash, the gate floors it was judged against
 * — so the report derives every number from the records and refuses a run
 * measured against different bytes than the committed samples.
 */
export const DecisionBenchRunSchema = v.object({
  schema: v.literal(1),
  task: v.literal("decision-bench"),
  /** The config row id the run was requested with, as requested. */
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
  /** An aborted run keeps its partial records and names the failure. */
  aborted: v.optional(v.boolean()),
  error: v.optional(v.pipe(v.string(), v.minLength(1))),
  startedAt: v.pipe(v.string(), v.isoTimestamp()),
  finishedAt: v.pipe(v.string(), v.isoTimestamp()),
  records: v.array(DecisionBenchRunRecordSchema),
});

export type DecisionBenchRun = v.InferOutput<typeof DecisionBenchRunSchema>;

/**
 * Parse an untrusted run-file payload with the consistency checks the schema
 * cannot express: the totals must be derivable from the records (a summary
 * that disagrees with its own evidence is a corrupted run), an aborted run
 * must name its failure, and a complete one must not carry one.
 */
export function parseDecisionBenchRun(raw: unknown): DecisionBenchRun {
  const run = v.parse(DecisionBenchRunSchema, raw);
  if (run.totals.scored > run.totals.cases) {
    throw new Error(
      `decision-bench run "${run.model}": scored ${run.totals.scored} cases exceeds the fixture's ${run.totals.cases}`,
    );
  }
  if (run.totals.scored !== run.records.length) {
    throw new Error(
      `decision-bench run "${run.model}": totals.scored ${run.totals.scored} does not match its ${run.records.length} records`,
    );
  }
  const passed = run.records.filter((r) => r.passed).length;
  if (run.totals.passed !== passed) {
    throw new Error(
      `decision-bench run "${run.model}": totals.passed ${run.totals.passed} does not match the ${passed} passing records`,
    );
  }
  const accuracy = run.totals.scored === 0 ? null : passed / run.totals.scored;
  if (run.totals.accuracy !== null && Math.abs(run.totals.accuracy - (accuracy ?? 0)) > 1e-9) {
    throw new Error(
      `decision-bench run "${run.model}": totals.accuracy ${run.totals.accuracy} does not match ${passed}/${run.totals.scored}`,
    );
  }
  if (run.aborted === true && (run.error === undefined || run.error.length === 0)) {
    throw new Error(`decision-bench run "${run.model}": aborted without an error message`);
  }
  if (run.aborted !== true && run.error !== undefined) {
    throw new Error(`decision-bench run "${run.model}": carries an error but is not aborted`);
  }
  return run;
}
