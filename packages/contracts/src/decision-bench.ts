import * as v from "valibot";

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
