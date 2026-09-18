import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createSystemOneDecider, resolveDecider } from "./systemone-adapter";
import type { FetchLike } from "./chat-completions-adapter";
import { jsonResponse, testVendor } from "./test-fixtures";
import type { DecisionSpec } from "@app/rag-core";

/** A systemone-shaped vendor config (protocol is the only difference). */
const systemoneVendor = {
  ...testVendor,
  protocol: "systemone",
  models: {
    "m-decide": {
      capabilities: ["decide" as const],
      priceMicroUsdPerMTok: { in: 42, out: 0 },
    },
  },
} as const;

function makeDecider(fetchImpl: FetchLike, apiKey = "k-1") {
  return createSystemOneDecider({
    vendor: systemoneVendor,
    modelId: "m-decide",
    model: systemoneVendor.models["m-decide"],
    apiKey,
    fetchImpl,
  });
}

const SPEC: DecisionSpec = {
  state: { query: "q", passage: "p" },
  questions: {
    relevant: {
      type: "noul",
      instructions: "Does the passage answer the question?",
      criteria: { true: "yes", false: "no" },
    },
  },
};

const WIRE_RESPONSE = {
  model: "m-decide",
  answers: { relevant: { type: "noul", noul: 0.92 } },
  usage: { input_tokens: 1000, output_tokens: 50 },
};

describe("systemone adapter", () => {
  it("decide posts state+questions to the systemone wire and meters cost from usage", async () => {
    const calls: { url: string; body: Record<string, unknown>; auth: string | undefined }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
      return jsonResponse(WIRE_RESPONSE);
    };
    const decider = makeDecider(fetchImpl);

    const result = await Effect.runPromise(decider.decide(SPEC));

    expect(result.answers.relevant).toMatchObject({ type: "noul", noul: 0.92 });
    // 1000 tokens in @ 42 µ$/MTok = 0.042 µ$ → ceil to 1 micro-USD; output free.
    expect(result.cost.tokensIn).toBe(1000);
    expect(result.cost.tokensOut).toBe(50);
    expect(result.cost.costMicroUsd).toBe(1);
    expect(result.cost.modelId).toBe("m-decide");
    expect(result.cost.estimated).toBeFalsy();

    const first = calls[0];
    expect(first?.url).toBe("https://example.invalid/v1/systemone");
    expect(first?.auth).toBe("Bearer k-1");
    expect(first?.body.model).toBe("m-decide");
    expect(first?.body.state).toEqual(SPEC.state);
    expect(first?.body.questions).toEqual(SPEC.questions);
  });

  it("decide without usage reports an estimated cost, marked estimated", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ model: "m-decide", answers: { relevant: { type: "noul", noul: 0.5 } } });
    const decider = makeDecider(fetchImpl);
    const result = await Effect.runPromise(decider.decide(SPEC));
    // State JSON ~30 chars → est. ~8 tokens @ 42 µ$/MTok → ceil of a fraction.
    expect(result.cost.estimated).toBeTruthy();
    expect(result.cost.costMicroUsd).toBeGreaterThanOrEqual(1);
  });

  it("maps HTTP failures onto ProviderError kinds (429 rate_limited, 529 server)", async () => {
    for (const [status, kind] of [
      [429, "rate_limited"],
      [500, "server"],
      [529, "server"],
      [422, "bad_request"],
    ] as const) {
      const fetchImpl: FetchLike = async () => jsonResponse({ error: { message: "nope" } }, status);
      const decider = makeDecider(fetchImpl);
      const err = await Effect.runPromise(Effect.flip(decider.decide(SPEC)));
      expect(err.kind).toBe(kind);
      expect(err.message).toContain(String(status));
    }
  });

  it("rejects a 200 whose body has no answers object", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ model: "m-decide" });
    const decider = makeDecider(fetchImpl);
    const err = await Effect.runPromise(Effect.flip(decider.decide(SPEC)));
    expect(err.kind).toBe("transport");
    expect(err.message).toContain("no answers");
  });

  it("throws on a model without the decide capability", () => {
    expect(() =>
      createSystemOneDecider({
        vendor: systemoneVendor,
        modelId: "m-decide",
        model: { capabilities: ["generate"], priceMicroUsdPerMTok: { in: 1, out: 1 } },
        apiKey: "k",
      }),
    ).toThrow(/does not support decide/);
  });
});

describe("resolveDecider", () => {
  it("reports absent keys and never silently skips a keyed protocol mismatch", () => {
    // A candidate whose key is absent lands in missingKeys; a KEYED candidate
    // with the wrong protocol throws (misconfiguration must fail loudly).
    const config = {
      vendors: { so: systemoneVendor, chat: testVendor },
      roles: { "decision-candidates": { chain: ["chat:m-chat", "so:m-decide"] } },
    };
    const { deciders, missingKeys } = resolveDecider(config, "decision-candidates", {
      env: {}, // both candidates' keys absent
    });
    expect(missingKeys).toEqual(["TEST_KEY", "TEST_KEY"]); // one entry per candidate
    expect(deciders).toHaveLength(0);
  });

  it("resolves a keyed systemone candidate into a working decider", () => {
    const config = {
      vendors: { so: { ...systemoneVendor, apiKeyEnv: "SO_KEY" } },
      roles: { "decision-candidates": { chain: ["so:m-decide"] } },
    };
    const { deciders, missingKeys } = resolveDecider(config, "decision-candidates", {
      env: { SO_KEY: "k-1" },
    });
    expect(missingKeys).toEqual([]);
    expect(deciders[0]?.modelId).toBe("m-decide");
    expect(deciders[0]?.decider.decide).toBeTypeOf("function");
  });

  it("refuses a non-systemone candidate in a decider role", () => {
    const config = {
      vendors: { chat: { ...testVendor, apiKeyEnv: "TEST_KEY" } },
      roles: { "decision-candidates": { chain: ["chat:m-chat"] } },
    };
    expect(() =>
      resolveDecider(config, "decision-candidates", { env: { TEST_KEY: "k-1" } }),
    ).toThrow(/does not speak the systemone protocol/);
  });
});
