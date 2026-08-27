import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  TraceSchema,
  parseTrace,
  totalCostMicroUsd,
  type TraceEvent,
} from "./trace";

const costArb = fc.record({
  modelId: fc.string({ minLength: 1 }),
  tokensIn: fc.nat(),
  tokensOut: fc.nat(),
  latencyMs: fc.nat(),
  costMicroUsd: fc.nat(),
});

const stageArb = fc.constantFrom(
  "router",
  "retriever",
  "assembler",
  "generator",
  "reviewer",
  "ingest",
  "eval",
);

/**
 * `llm_call` is the cost-carrying event kind, so the cost-sum invariants
 * (ADR-0007 amendment) are expressed over it. `cost` is built conditionally
 * so the generated value omits the key when undefined — matching the exact
 * optionality of the typed contract.
 */
const llmCallArb = fc
  .tuple(stageArb, fc.nat(), fc.option(costArb, { nil: undefined }))
  .map(([stage, at, cost]) => ({
    stage,
    kind: "llm_call" as const,
    at,
    ...(cost === undefined ? {} : { cost }),
  }));

describe("trace contract", () => {
  // ADR-0007 amendment invariant: a run's recorded cost equals the sum of its
  // recorded LLM calls — an untraced call is a defect.
  //
  // The properties below test *independent* invariants rather than mirroring
  // the body of `totalCostMicroUsd` (which would make the test tautological):
  //   1. an event with no cost leaves the total unchanged;
  //   2. an event carrying cost `k` increases the total by exactly `k`;
  //   3. the total equals a *separately computed* sum — filter events that
  //      carry a cost, then reduce their `costMicroUsd` — rather than the
  //      same optional-chain expression the implementation uses.
  fcTest.prop([fc.array(llmCallArb), costArb])(
    "appending an event with cost k increases the total by exactly k",
    (events, cost) => {
      const before = totalCostMicroUsd({ id: "t", createdAt: 0, events });
      const after = totalCostMicroUsd({
        id: "t",
        createdAt: 0,
        events: [...events, { stage: "generator", kind: "llm_call", cost, at: 0 }],
      });
      expect(after).toBe(before + cost.costMicroUsd);
    },
  );

  fcTest.prop([fc.array(llmCallArb), stageArb])(
    "appending an event without cost does not change the total",
    (events, stage) => {
      const before = totalCostMicroUsd({ id: "t", createdAt: 0, events });
      const after = totalCostMicroUsd({
        id: "t",
        createdAt: 0,
        events: [...events, { stage, kind: "llm_call", at: 0 }],
      });
      expect(after).toBe(before);
    },
  );

  fcTest.prop([fc.array(llmCallArb)])(
    "total equals the sum of costMicroUsd over cost-bearing events",
    (events) => {
      const trace = { id: "t", createdAt: 0, events };
      // Independent computation: keep only cost-bearing events first, then
      // sum — a different shape from the implementation's optional chain.
      const expected = events
        .filter((e) => e.cost !== undefined)
        .reduce((sum, e) => sum + (e.cost?.costMicroUsd ?? 0), 0);
      expect(totalCostMicroUsd(trace)).toBe(expected);
    },
  );

  it("parses a trace with one event of each kind", () => {
    const events: TraceEvent[] = [
      {
        stage: "router",
        kind: "intent",
        detail: { intent: "factual", confidence: 0.9, attributes: { scope: "all" } },
        at: 1,
      },
      { stage: "router", kind: "subquery", detail: { text: "sub" }, at: 2 },
      {
        stage: "retriever",
        kind: "retrieval",
        detail: { chunks: [{ id: "c1", score: 0.5, rankDense: 1, rankSparse: 2 }] },
        at: 3,
      },
      {
        stage: "assembler",
        kind: "assembly",
        detail: { turnCount: 2, chunkCount: 1 },
        at: 4,
      },
      {
        stage: "generator",
        kind: "llm_call",
        detail: { purpose: "generate" },
        cost: { modelId: "m", tokensIn: 1, tokensOut: 2, latencyMs: 3, costMicroUsd: 4 },
        at: 5,
      },
      { stage: "reviewer", kind: "review", detail: { verdict: "faithful" }, at: 6 },
      { stage: "generator", kind: "refusal", reason: "insufficient evidence", at: 7 },
    ];
    const trace = parseTrace({ id: "t", createdAt: 0, events });
    expect(trace.events).toHaveLength(7);
  });

  it("rejects an unknown kind", () => {
    expect(
      v.safeParse(TraceSchema, {
        id: "t",
        createdAt: 1,
        events: [{ stage: "generator", kind: "x", at: 1 }],
      }).success,
    ).toBe(false);
  });

  it("rejects a refusal without a reason", () => {
    expect(
      v.safeParse(TraceSchema, {
        id: "t",
        createdAt: 1,
        events: [{ stage: "generator", kind: "refusal", at: 1 }],
      }).success,
    ).toBe(false);
  });

  it("rejects an intent event on the wrong stage", () => {
    expect(
      v.safeParse(TraceSchema, {
        id: "t",
        createdAt: 1,
        events: [{ stage: "retriever", kind: "intent", detail: { intent: "x" }, at: 1 }],
      }).success,
    ).toBe(false);
  });

  it("rejects a malformed intent detail", () => {
    expect(
      v.safeParse(TraceSchema, {
        id: "t",
        createdAt: 1,
        events: [{ stage: "router", kind: "intent", detail: { nope: true }, at: 1 }],
      }).success,
    ).toBe(false);
  });
});
