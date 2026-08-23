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
  fcTest.prop([fc.array(eventArb)])(
    "total cost equals the sum of per-event LLM costs",
    (events) => {
      const trace = { id: "t", createdAt: 0, events };
      const expected = events.reduce(
        (sum, e) => sum + (e.cost?.costMicroUsd ?? 0),
        0,
      );
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
