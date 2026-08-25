import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  TraceSchema,
  totalCostMicroUsd,
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
);

const eventArb = fc.record({
  stage: stageArb,
  kind: fc.string({ minLength: 1 }),
  cost: fc.option(costArb, { nil: undefined }),
  reason: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
  at: fc.nat(),
});

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
  fcTest.prop([fc.array(eventArb), costArb])(
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

  fcTest.prop([fc.array(eventArb), stageArb, fc.string({ minLength: 1 })])(
    "appending an event with cost: undefined does not change the total",
    (events, stage, kind) => {
      const before = totalCostMicroUsd({ id: "t", createdAt: 0, events });
      const after = totalCostMicroUsd({
        id: "t",
        createdAt: 0,
        events: [...events, { stage, kind, at: 0 }],
      });
      expect(after).toBe(before);
    },
  );

  fcTest.prop([fc.array(eventArb)])(
    "total equals the sum of costMicroUsd over cost-bearing events",
    (events) => {
      const trace = { id: "t", createdAt: 0, events };
      // Independent computation: keep only cost-bearing events first, then
      // sum — a different shape from the implementation's optional chain.
      const expected = events
        .filter((e) => e.cost !== undefined)
        .reduce((sum, e) => sum + e.cost!.costMicroUsd, 0);
      expect(totalCostMicroUsd(trace)).toBe(expected);
    },
  );

  it("validates a well-formed trace and rejects a bad stage", () => {
    const ok = v.parse(TraceSchema, {
      id: "t1",
      createdAt: 1,
      events: [{ stage: "generator", kind: "llm_call", at: 1 }],
    });
    expect(ok.events).toHaveLength(1);
    expect(
      v.safeParse(TraceSchema, {
        id: "t1",
        createdAt: 1,
        events: [{ stage: "printer", kind: "x", at: 1 }],
      }).success,
    ).toBe(false);
  });
});
