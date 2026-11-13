import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import type { DecisionSpec } from "@app/rag-core";
import { runFail } from "@app/rag-core/testing";
import type { FetchLike } from "./chat-completions-adapter";
import { createChatCompletionsDecider } from "./chat-completions-decider";
import { resolveDecider } from "./decider-resolve";
import type { ModelConfig, VendorConfig } from "./provider-config";

/**
 * The chat-completions decision adapter, driven entirely by a fake wire: the
 * request must carry the strict JSON schema (the seam's typing on the wire),
 * the answers must come back typed and range-checked, and every refusal is a
 * `ProviderError` the caller's fail-open path reads as a vendor failure.
 */

const VENDOR: VendorConfig = {
  baseUrl: "https://decision.invalid/v1",
  apiKeyEnv: "DECIDER_KEY",
  protocol: "chat-completions",
  freeTier: false,
  personalDataAllowed: true,
  models: {},
};

const MODEL: ModelConfig = {
  capabilities: ["decide"],
  priceMicroUsdPerMTok: { in: 1000, out: 2000 },
};

const spec: DecisionSpec = {
  state: "the state under judgment",
  personalData: false,
  questions: {
    supported: { type: "noul", instructions: "Does the state mention judgment?" },
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

function chatReply(content: string, status = 200, usage?: Record<string, number>): FetchLike {
  return async (input, init) => {
    captured.url = input;
    captured.body = JSON.parse(init.body) as Record<string, unknown>;
    if (status !== 200) {
      return new Response("upstream exploded", { status });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), {
      status,
    });
  };
}

const captured: { url?: string; body?: Record<string, unknown> } = {};

function decider(fetchImpl: FetchLike) {
  return createChatCompletionsDecider({
    vendor: VENDOR,
    modelId: "decider-1",
    model: MODEL,
    apiKey: "sk-decider",
    fetchImpl,
  });
}

describe("chat-completions decider — the wire carries the typing", () => {
  it("posts the state and questions with a strict answers schema", async () => {
    const d = decider(
      chatReply(
        JSON.stringify({
          answers: {
            supported: { noul: 0.9 },
            pick: { choice: "chat", probabilities: { chat: 0.8, other: 0.2 }, confidence: 0.7 },
            grade: { score: 1.4, probabilities: { "0": 0.5, "1": 0.5, "2": 0 }, confidence: 0.6 },
          },
        }),
        200,
        { prompt_tokens: 120, completion_tokens: 30 },
      ),
    );
    const { answers, cost } = await Effect.runPromise(d.decide(spec));
    // The request carried the strict schema: the seam's typing rides the wire,
    // not a convention the model may ignore.
    const format = captured.body?.["response_format"] as {
      type: string;
      json_schema: { strict: boolean; schema: { properties: Record<string, unknown> } };
    };
    expect(format.type).toBe("json_schema");
    expect(format.json_schema.strict).toBe(true);
    const answersSchema = format.json_schema.schema.properties.answers as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(answersSchema.properties)).toEqual(["supported", "pick", "grade"]);
    // And the answers came back typed.
    expect(answers.supported).toEqual({ type: "noul", noul: 0.9 });
    expect(answers.pick).toEqual({
      type: "choice",
      choice: "chat",
      probabilities: { chat: 0.8, other: 0.2 },
      confidence: 0.7,
    });
    // The score's legend is the question's own rubric, not the model's echo.
    expect(answers.grade).toEqual({
      type: "score",
      score: 1.4,
      legend: { "0": "weak", "1": "fair", "2": "strong" },
      probabilities: { "0": 0.5, "1": 0.5, "2": 0 },
      confidence: 0.6,
    });
    // Metered usage settles the cost; model identity rides the record.
    expect(cost.tokensIn).toBe(120);
    expect(cost.tokensOut).toBe(30);
    expect(cost.estimated).toBe(false);
    expect(cost.modelId).toBe("decider-1");
  });
});

describe("chat-completions decider — every doubtful answer is a refusal", () => {
  it("refuses an out-of-range noul", async () => {
    const d = decider(
      chatReply(
        JSON.stringify({
          answers: { supported: { noul: 1.5 }, pick: {}, grade: {} },
        }),
        200,
        { prompt_tokens: 10, completion_tokens: 5 },
      ),
    );
    const err = await runFail(d.decide(spec));
    expect(err.kind).toBe("transport");
    expect(err.message).toContain('"supported"');
    // The vendor answered (and billed) the attempt: the spend stays on the trail.
    expect(err.attemptCosts?.length).toBe(1);
    expect(err.attemptCosts?.[0]?.estimated).toBe(false);
  });

  it("refuses a choice off the option set", async () => {
    const d = decider(
      chatReply(
        JSON.stringify({
          answers: {
            supported: { noul: 0.5 },
            pick: { choice: "poetry", probabilities: { poetry: 1 }, confidence: 0.9 },
            grade: { score: 0, probabilities: { "0": 1 }, confidence: 0.9 },
          },
        }),
      ),
    );
    const err = await runFail(d.decide(spec));
    expect(err.kind).toBe("transport");
    expect(err.message).toContain('"pick"');
  });

  it("refuses a missing answer", async () => {
    const d = decider(
      chatReply(
        JSON.stringify({
          answers: {
            supported: { noul: 0.5 },
            pick: { choice: "chat", probabilities: { chat: 1 }, confidence: 0.9 },
          },
        }),
      ),
    );
    const err = await runFail(d.decide(spec));
    expect(err.message).toContain('"grade"');
  });

  it("refuses non-JSON content", async () => {
    const d = decider(chatReply("I cannot answer that in JSON."));
    const err = await runFail(d.decide(spec));
    expect(err.kind).toBe("transport");
    expect(err.attemptCosts?.length).toBe(1);
  });

  it("maps an HTTP failure onto the status kind with the attempt's estimated spend", async () => {
    const d = decider(chatReply("", 503));
    const err = await runFail(d.decide(spec));
    expect(err.kind).toBe("server");
    expect(err.attemptCosts?.[0]?.estimated).toBe(true);
  });

  it("refuses a score above the rubric's highest level", async () => {
    // A probability-weighted level position lives in [0, levels - 1]: 3.5 on a
    // three-level rubric (positions 0..2) is out of range, so the call fails.
    const d = decider(
      chatReply(
        JSON.stringify({
          answers: {
            supported: { noul: 0.5 },
            pick: { choice: "chat", probabilities: { chat: 1 }, confidence: 0.9 },
            grade: { score: 3.5, probabilities: { "0": 1 }, confidence: 0.9 },
          },
        }),
      ),
    );
    const err = await runFail(d.decide(spec));
    expect(err.message).toContain('"grade"');
  });

  it("refuses a negative score", async () => {
    const d = decider(
      chatReply(
        JSON.stringify({
          answers: {
            supported: { noul: 0.5 },
            pick: { choice: "chat", probabilities: { chat: 1 }, confidence: 0.9 },
            grade: { score: -0.5, probabilities: { "0": 1 }, confidence: 0.9 },
          },
        }),
      ),
    );
    const err = await runFail(d.decide(spec));
    expect(err.message).toContain('"grade"');
  });

  it("refuses a probability outside [0, 1]", async () => {
    const d = decider(
      chatReply(
        JSON.stringify({
          answers: {
            supported: { noul: 0.5 },
            pick: { choice: "chat", probabilities: { chat: 1.5, other: -0.5 }, confidence: 0.9 },
            grade: { score: 1, probabilities: { "0": 1 }, confidence: 0.9 },
          },
        }),
      ),
    );
    const err = await runFail(d.decide(spec));
    expect(err.kind).toBe("transport");
    expect(err.message).toContain('"pick"');
  });
});

describe("chat-completions decider — the seam guards and posture", () => {
  it("refuses a model without the decide capability at construction", () => {
    expect(() =>
      createChatCompletionsDecider({
        vendor: VENDOR,
        modelId: "decider-1",
        model: { capabilities: ["generate"], priceMicroUsdPerMTok: { in: 1, out: 1 } },
        apiKey: "sk",
      }),
    ).toThrow(/does not support decide/);
  });

  it("fails a personal-data spec before the wire when the vendor forbids it", async () => {
    let reached = false;
    const guarded = createChatCompletionsDecider({
      vendor: { ...VENDOR, personalDataAllowed: false },
      modelId: "decider-1",
      model: MODEL,
      apiKey: "sk",
      fetchImpl: (async () => {
        reached = true;
        return new Response("{}", { status: 200 });
      }) as FetchLike,
    });
    const err = await runFail(guarded.decide({ ...spec, personalData: true }));
    expect(err.kind).toBe("bad_request");
    expect(reached).toBe(false);
  });

  it("resolveDecider reports a missing key and an ineligible candidate, wiring neither", () => {
    const config = {
      vendors: {
        allowed: { ...VENDOR, apiKeyEnv: "ALLOWED_KEY", models: { "decider-1": MODEL } },
        forbidden: {
          ...VENDOR,
          apiKeyEnv: "FORBIDDEN_KEY",
          personalDataAllowed: false,
          models: { "decider-1": MODEL },
        },
      },
      roles: {
        decision: { chain: ["allowed:decider-1", "forbidden:decider-1"] },
      },
    };
    const resolved = resolveDecider(config, "decision", {
      env: { ALLOWED_KEY: "sk-allowed", FORBIDDEN_KEY: "sk-forbidden" },
      personalData: true,
    });
    expect(resolved.deciders.map((d) => d.modelId)).toEqual(["decider-1"]);
    // The ineligible drop is not a missing key: the key is present, the posture refuses.
    expect(resolved.missingKeys).toEqual([]);
    expect(resolved.ineligibleKeys).toEqual(["FORBIDDEN_KEY"]);
  });

  it("reports a missing key once even when the chain keys two candidates to it", () => {
    // The aggregator keys a chain's head and tail to the same env: the report
    // names variables, not candidates.
    const config = {
      vendors: {
        allowed: {
          ...VENDOR,
          apiKeyEnv: "SHARED_KEY",
          models: { "decider-1": MODEL, "decider-2": MODEL },
        },
      },
      roles: { decision: { chain: ["allowed:decider-1", "allowed:decider-2"] } },
    };
    const resolved = resolveDecider(config, "decision", { env: {} });
    expect(resolved.missingKeys).toEqual(["SHARED_KEY"]);
  });
});
