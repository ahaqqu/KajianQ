import * as v from "valibot";
import { CostRecordSchema } from "./trace-primitives";

/**
 * Router-bench contracts: the fixture shape and committed run-file shape for
 * the router-classification bench — the cheap-role Smart Router stage 1–2
 * (intent, subject area, principle need) over hand-authored questions in
 * each content language. Domain-agnostic like the decision bench: the
 * intent/category/tag vocabularies are opaque strings the domain pack
 * validates against its own taxonomy; only the classification's shape is
 * contractual here.
 */

/** One prior chat turn a follow-up case resolves its reference against. */
export const RouterPriorTurnSchema = v.object({
  role: v.picklist(["user", "assistant"]),
  content: v.pipe(v.string(), v.minLength(1)),
});

/** What a case asserts about the classification: intent always; the rest where unambiguous. */
export const RouterExpectedSchema = v.object({
  intent: v.pipe(v.string(), v.minLength(1)),
  category: v.optional(v.pipe(v.string(), v.minLength(1))),
  needsPrinciple: v.optional(v.boolean()),
  principleTags: v.optional(v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.maxLength(3))),
});

export const RouterCaseSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  language: v.pipe(v.string(), v.minLength(1)),
  question: v.pipe(v.string(), v.minLength(1)),
  /** Bounded prior turns; present on follow-up cases that resolve a reference. */
  priorTurns: v.optional(v.pipe(v.array(RouterPriorTurnSchema), v.maxLength(4))),
  expected: RouterExpectedSchema,
});

/** The fixture: every routing case the gate scores. */
export const RouterBenchFixtureSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  status: v.picklist(["v0-draft", "canonical"]),
  cases: v.pipe(v.array(RouterCaseSchema), v.minLength(1)),
});

export type RouterBenchFixture = v.InferOutput<typeof RouterBenchFixtureSchema>;
export type RouterCase = v.InferOutput<typeof RouterCaseSchema>;
export type RouterExpected = v.InferOutput<typeof RouterExpectedSchema>;

/** One scored case in a committed run file: the asserted expectation vs the reply's classification. */
export const RouterBenchRunRecordSchema = v.object({
  caseId: v.pipe(v.string(), v.minLength(1)),
  language: v.pipe(v.string(), v.minLength(1)),
  /** JSON of the asserted expectation — the full truth the case holds. */
  expected: v.pipe(v.string(), v.minLength(1)),
  /** JSON of the reply's classification for the same fields, "n/a" when unreadable. */
  got: v.pipe(v.string(), v.minLength(1)),
  passed: v.boolean(),
  cost: v.optional(CostRecordSchema),
});

export type RouterBenchRunRecord = v.InferOutput<typeof RouterBenchRunRecordSchema>;

/**
 * The committed run file — one append-only record per candidate arm, same
 * store discipline as the decision bench: the run pins the samples seal
 * (version + cases hash) and the prompt-wording hash it measured, and the
 * report derives every number from the records, never from a run's totals.
 */
export const RouterBenchRunSchema = v.object({
  schema: v.literal(1),
  task: v.literal("router-bench"),
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
  records: v.array(RouterBenchRunRecordSchema),
});

export type RouterBenchRun = v.InferOutput<typeof RouterBenchRunSchema>;

/**
 * Parse an untrusted fixture payload with the cross-field check the schema
 * cannot express: a case asserting `principleTags` must also assert
 * `needsPrinciple: true` — tags without the flag contradict the one field
 * that routes retrieval to the Principle Index.
 */
export function parseRouterBenchFixture(raw: unknown): RouterBenchFixture {
  const fixture = v.parse(RouterBenchFixtureSchema, raw);
  fixture.cases.forEach((c, i) => {
    if (c.expected.principleTags !== undefined && c.expected.needsPrinciple !== true) {
      throw new Error(
        `router-bench fixture: case ${i} ("${c.id}") asserts principleTags without needsPrinciple: true`,
      );
    }
  });
  return fixture;
}

/**
 * Parse an untrusted run-file payload with the same consistency checks the
 * decision run carries: the totals must be derivable from the records, an
 * aborted run must name its failure, and a complete one must not carry one.
 */
export function parseRouterBenchRun(raw: unknown): RouterBenchRun {
  const run = v.parse(RouterBenchRunSchema, raw);
  if (run.totals.scored > run.totals.cases) {
    throw new Error(
      `router-bench run "${run.model}": scored ${run.totals.scored} cases exceeds the fixture's ${run.totals.cases}`,
    );
  }
  if (run.totals.scored !== run.records.length) {
    throw new Error(
      `router-bench run "${run.model}": totals.scored ${run.totals.scored} does not match its ${run.records.length} records`,
    );
  }
  const passed = run.records.filter((r) => r.passed).length;
  if (run.totals.passed !== passed) {
    throw new Error(
      `router-bench run "${run.model}": totals.passed ${run.totals.passed} does not match the ${passed} passing records`,
    );
  }
  const accuracy = run.totals.scored === 0 ? null : passed / run.totals.scored;
  if (run.totals.accuracy !== null && Math.abs(run.totals.accuracy - (accuracy ?? 0)) > 1e-9) {
    throw new Error(
      `router-bench run "${run.model}": totals.accuracy ${run.totals.accuracy} does not match ${passed}/${run.totals.scored}`,
    );
  }
  if (run.aborted === true && (run.error === undefined || run.error.length === 0)) {
    throw new Error(`router-bench run "${run.model}": aborted without an error message`);
  }
  if (run.aborted !== true && run.error !== undefined) {
    throw new Error(`router-bench run "${run.model}": carries an error but is not aborted`);
  }
  return run;
}
