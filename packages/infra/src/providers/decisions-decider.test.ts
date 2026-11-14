import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { ProviderError, type DecisionSpec } from "@app/rag-core";
import { runFail } from "@app/rag-core/testing";
import type { FetchLike } from "./chat-completions-adapter";
import { createDecisionsDecider } from "./decisions-decider";
import type { ModelConfig, VendorConfig } from "./provider-config";

/**
 * The typed-questions decision adapter, driven entirely by a fake wire: the
 * state must ride as a one-element array of strings with the questions passed
 * through verbatim (the wire's primitives are the seam's own question types),
 * the answers must come back typed and range-checked through the same
 * validator the chat adapter uses, and the wire's input-only billing is what
 * the cost records show.
 */

const VENDOR: VendorConfig = {
  baseUrl: "https://decisions.invalid/api/alpha",
  apiKeyEnv: "DECIDER_KEY",
  protocol: "decisions",
  freeTier: false,
  personalDataAllowed: true,
  models: {},
};

const MODEL: ModelConfig = {
  capabilities: ["decide"],
  priceMicroUsdPerMTok: { in: 1000, out: 0 },
};

const spec: DecisionSpec = {
  state: "the state under judgment",
  personalData: false,
  questions: {
    supported: {
      type: "noul",
      instructions: "Does the state mention judgment?",
      criteria: { true: "it does", false: "it does not" },
    },
    pick: {
      type: "choice",
      instructions: "Which kind of text is the state?",
      criteria: { chat: null, other: "anything else" },
    },
    grade: {
      type: "score",
      instructions: "Grade the state's quality.",
      criteria: ["weak", "fair", "strong"],
    },
  },
};

const captured: {
  url?: string;
  body?: Record<string, unknown>;
  called?: boolean | undefined;
} = {};

function decisionsReply(payload: unknown, status = 200): FetchLike {
  return async (input, init) => {
    captured.called = true;
    captured.url = String(input);
    captured.body = JSON.parse(init.body) as Record<string, unknown>;
    return new Response(status === 200 ? JSON.stringify(payload) : "upstream exploded", {
      status,
    });
  };
}

function validAnswers(): Record<string, unknown> {
  return {
    supported: { type: "noul", noul: 0.9, confidence: 0.8 },
    pick: {
      type: "choice",
      choice: "chat",
      probabilities: { chat: 0.8, other: 0.2 },
      confidence: 0.7,
    },
    grade: {
      type: "score",
      score: 1.4,
      legend: { echo: "nope" },
      probabilities: { "0": 0.5, "1": 0.5, "2": 0 },
      confidence: 0.6,
    },
  };
}

function decider(fetchImpl: FetchLike, vendor: VendorConfig = VENDOR) {
  return createDecisionsDecider({
    vendor,
    modelId: "decider-1",
    model: MODEL,
    apiKey: "sk-decider",
    fetchImpl,
  });
}

describe("decisions decider — the wire carries the typing", () => {
  it("posts the state as a one-element array with the questions verbatim", async () => {
    const d = decider(
      decisionsReply({
        model: "decider-1",
        answers: validAnswers(),
        usage: { input_tokens: 5000, output_tokens: 200 },
      }),
    );
    await Effect.runPromise(d.decide(spec));
    expect(captured.url).toBe("https://decisions.invalid/api/alpha/decisions");
    expect(captured.body?.state).toEqual(["the state under judgment"]);
    expect(captured.body?.model).toBe("decider-1");
    expect(captured.body?.questions).toEqual(spec.questions);
  });

  it("answers come back typed through the seam's validator", async () => {
    const d = decider(
      decisionsReply({
        model: "decider-1",
        answers: validAnswers(),
        usage: { input_tokens: 5000, output_tokens: 200 },
      }),
    );
    const { answers } = await Effect.runPromise(d.decide(spec));
    expect(answers.supported).toEqual({ type: "noul", noul: 0.9 });
    expect(answers.pick).toEqual({
      type: "choice",
      choice: "chat",
      probabilities: { chat: 0.8, other: 0.2 },
      confidence: 0.7,
    });
    // The score's legend is the question's own rubric, never the model's echo.
    expect(answers.grade).toEqual({
      type: "score",
      score: 1.4,
      legend: { "0": "weak", "1": "fair", "2": "strong" },
      probabilities: { "0": 0.5, "1": 0.5, "2": 0 },
      confidence: 0.6,
    });
  });

  it("refuses a malformed or off-option answer with the billed spend on the trail", async () => {
    const d = decider(
      decisionsReply({
        model: "decider-1",
        answers: { ...validAnswers(), pick: { type: "choice", choice: "vocabulary" } },
        usage: { input_tokens: 5000, output_tokens: 200 },
      }),
    );
    const err = await runFail(d.decide(spec));
    expect(err.kind).toBe("transport");
    expect(err.message).toContain('"pick"');
    // The reply was metered, so the billed cost rides the error: the money was
    // spent even though the answer failed validation.
    expect(err.attemptCosts?.length).toBe(1);
    expect(err.attemptCosts?.[0]?.estimated).toBe(false);
    expect(err.attemptCosts?.[0]?.tokensIn).toBe(5000);
  });

  it("bills input tokens only — the row prices output free", async () => {
    const d = decider(
      decisionsReply({
        model: "decider-1",
        answers: validAnswers(),
        usage: { input_tokens: 5000, output_tokens: 200 },
      }),
    );
    const { cost } = await Effect.runPromise(d.decide(spec));
    expect(cost.tokensIn).toBe(5000);
    expect(cost.tokensOut).toBe(200);
    expect(cost.costMicroUsd).toBe(5);
    expect(cost.estimated).toBe(false);
  });

  it("traces the model the reply names, not the requested alias", async () => {
    const d = decider(
      decisionsReply({
        model: "decider-2026-08-14",
        answers: validAnswers(),
        usage: { input_tokens: 5000, output_tokens: 200 },
      }),
    );
    const { cost } = await Effect.runPromise(d.decide(spec));
    expect(cost.modelId).toBe("decider-2026-08-14");
  });

  it("falls back to the requested id when the reply names no model", async () => {
    const d = decider(
      decisionsReply({
        answers: validAnswers(),
        usage: { input_tokens: 5000, output_tokens: 200 },
      }),
    );
    const { cost } = await Effect.runPromise(d.decide(spec));
    expect(cost.modelId).toBe("decider-1");
  });

  it("estimates the spend when the reply carries no usage block", async () => {
    const d = decider(decisionsReply({ model: "decider-1", answers: validAnswers() }));
    const { cost } = await Effect.runPromise(d.decide(spec));
    expect(cost.estimated).toBe(true);
    expect(cost.tokensIn).toBeGreaterThan(0);
    expect(cost.costMicroUsd).toBeGreaterThan(0);
  });

  it("fails typed on a non-2xx with the attempt's estimated input spend", async () => {
    const d = decider(decisionsReply({}, 500));
    const err = await runFail(d.decide(spec));
    expect(err.kind).toBe("server");
    expect(err.attemptCosts?.length).toBe(1);
    expect(err.attemptCosts?.[0]?.estimated).toBe(true);
  });

  it("fails typed when the reply has no answers object", async () => {
    const d = decider(decisionsReply({ model: "decider-1" }));
    const err = await runFail(d.decide(spec));
    expect(err.kind).toBe("transport");
    expect(err.message).toContain("no answers object");
    expect(err.attemptCosts?.length).toBe(1);
  });

  it("constructs only for a decide-capable model", () => {
    let thrown: unknown;
    try {
      createDecisionsDecider({
        vendor: VENDOR,
        modelId: "decider-1",
        model: { ...MODEL, capabilities: ["generate"] },
        apiKey: "sk-decider",
        fetchImpl: decisionsReply({ answers: {} }),
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProviderError);
  });

  it("a personal-data spec never reaches a vendor that forbids it", async () => {
    captured.called = undefined;
    const d = decider(decisionsReply({ answers: validAnswers() }), {
      ...VENDOR,
      personalDataAllowed: false,
    });
    const err = await runFail(d.decide({ ...spec, personalData: true }));
    expect(err.kind).toBe("bad_request");
    expect(err.message).toContain("personalDataAllowed: false");
    expect(captured.called).toBeUndefined();
  });
});
