import { describe, expect, it } from "vitest";
import type { CostRecordLike, TraceEventLike } from "./harness-types";

/**
 * Structural-typing guards (thermo-review B1): the harness's narrowed
 * trace-event views must stay assignable from the @app/contracts shapes —
 * a contract field rename must surface here, at compile time, as a test
 * failure rather than a silent zero-cost report.
 */
describe("harness-types structural compatibility", () => {
  it("accepts a contracts CostRecord verbatim as CostRecordLike", () => {
    const cost: CostRecordLike = {
      modelId: "m",
      tokensIn: 1,
      tokensOut: 2,
      latencyMs: 3,
      costMicroUsd: 4,
      estimated: false,
    };
    expect(cost.costMicroUsd).toBe(4);
  });

  it("carries an optional cost on TraceEventLike (B1: feeds report costs)", () => {
    const event: TraceEventLike = {
      kind: "llm_call",
      stage: "generator",
      cost: {
        modelId: "m",
        tokensIn: 1,
        tokensOut: 2,
        latencyMs: 3,
        costMicroUsd: 9,
      },
      at: 0,
    };
    expect(event.cost?.costMicroUsd).toBe(9);
    expect(event.detail?.purpose).toBeUndefined();
  });
});
