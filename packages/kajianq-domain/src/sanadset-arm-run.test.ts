import { describe, expect, it } from "vite-plus/test";
import {
  estimateStudyCalls,
  stopReason,
  summariseArm,
  type SamplePrediction,
} from "./sanadset-arm-run";
import type { ArmStatus, MatnDecision, SamplePair } from "./sanadset-core";
import { resolveArm } from "./sanadset-arm";

/**
 * Test intent, named before the assertions:
 * - trap: the stop reason is what the report and the PR body quote, so every branch is
 *   asserted — a run that never asked for a model and a run whose key was missing are
 *   different outcomes and must not read the same;
 * - trap: the projection caps itself by the same ceiling the run enforces, so a plan can
 *   never claim more calls than the run may issue;
 * - trap: a summary without a client reports zeroes rather than omitting the fields, so a
 *   reader never has to distinguish "no calls" from "not recorded".
 */

const STATUS: ArmStatus = {
  provider: "dashscope",
  baseUrl: "https://example.invalid/v1",
  model: "qwen3.7-flash",
  keyPresent: false,
  keySource: "absent",
  keyDetail: "absent in this test",
  price: { inputUsdPerMTok: 0.03, outputUsdPerMTok: 0.13 },
};

const ESTIMATE = { calls: 0, tokensIn: 0, tokensOut: 0, costMicroUsd: 0, estimated: true as const };

function pair(index: number, kind: "matn" | "narrator"): SamplePair {
  return {
    pairId: `P${String(index).padStart(3, "0")}`,
    kind,
    stratum: kind === "matn" ? "matn_near_duplicate" : "narrator_fold_same",
    a: `a-${index}`,
    b: `b-${index}`,
    ref: { rowA: index, rowB: index + 1, score: 0.7 },
  };
}

function decision(score: number, hasCandidate = true): MatnDecision {
  return {
    rowIndex: 1,
    kind: "band-unresolved",
    groupId: null,
    matchedRowIndex: null,
    score,
    bestCandidate: hasCandidate ? { rowIndex: 2, groupId: 1, score } : null,
  };
}

describe("stopReason", () => {
  it("distinguishes an unrequested run, a missing key, a ceiling stop and a clean run", () => {
    expect(stopReason({ requested: false, ran: false, ceilingReached: false })).toBe(
      "not-requested",
    );
    expect(stopReason({ requested: true, ran: false, ceilingReached: false })).toBe("key-absent");
    expect(stopReason({ requested: true, ran: true, ceilingReached: true })).toBe(
      "ceiling-reached",
    );
    expect(stopReason({ requested: true, ran: true, ceilingReached: false })).toBe("ran");
  });
});

describe("estimateStudyCalls", () => {
  const rawMatnByIndex = new Map([
    [1, "نص أ"],
    [2, "نص ب"],
  ]);

  it("counts the pre-registered sample plus every ambiguous band pair", () => {
    const estimate = estimateStudyCalls({
      pairs: [pair(1, "matn"), pair(2, "narrator")],
      decisions: [decision(0.75), decision(0.95), decision(0.4), decision(0.75, false)],
      rawMatnByIndex,
      ceiling: 100,
      price: { inputUsdPerMTok: 0.03, outputUsdPerMTok: 0.13 },
    });
    expect(estimate.calls).toBe(3);
    expect(estimate.tokensIn).toBeGreaterThan(0);
    expect(estimate.estimated).toBe(true);
  });

  it("never projects more calls than the ceiling allows", () => {
    const decisions = Array.from({ length: 20 }, () => decision(0.75));
    const estimate = estimateStudyCalls({
      pairs: [],
      decisions,
      rawMatnByIndex,
      ceiling: 5,
      price: { inputUsdPerMTok: 1, outputUsdPerMTok: 1 },
    });
    expect(estimate.calls).toBe(5);
  });
});

describe("summariseArm", () => {
  const base = {
    status: STATUS,
    requested: true,
    ceilingReached: false,
    estimate: ESTIMATE,
    samplePredictions: 0,
  };
  const predictions: SamplePrediction[] = [];

  it("reports zeroes when no client ran", () => {
    const { arm, costRecords } = summariseArm({ ...base, requested: false, client: null });
    expect(arm).toMatchObject({
      ran: false,
      stopReason: "not-requested",
      calls: 0,
      requests: 0,
      spendMicroUsd: 0,
    });
    expect(arm.estimatedTokens).toBe(false);
    expect(costRecords).toEqual([]);
    expect(predictions).toEqual([]);
  });

  it("carries the client's own totals into the facts", async () => {
    const { createArmClient } = await import("./sanadset-model");
    const client = createArmClient({
      arm: resolveArm({ provider: "dashscope" }),
      apiKey: "test-key",
      ceiling: 5,
      now: () => 1_000,
      fetch: async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [{ message: { content: '{"verdict":"same"}' } }],
            usage: { prompt_tokens: 40, completion_tokens: 4 },
          }),
      }),
    });
    await client.adjudicateMatn({ a: "a", b: "b", score: 0.7 });
    const { arm, costRecords } = summariseArm({ ...base, client });
    expect(arm).toMatchObject({
      ran: true,
      stopReason: "ran",
      calls: 1,
      requests: 1,
      tokensIn: 40,
      tokensOut: 4,
    });
    expect(arm.spendMicroUsd).toBeGreaterThan(0);
    expect(costRecords).toHaveLength(1);
    expect(costRecords[0]?.modelId).toBe(STATUS.model);
  });
});
