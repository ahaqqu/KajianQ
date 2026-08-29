import { describe, expect, it } from "vitest";
import { ProviderError } from "@app/rag-core";
import {
  loadProviderConfig,
  parseCandidateKey,
  parseProviderConfig,
  resolveChain,
} from "./provider-config";
import {
  createChatCompletionsProvider,
  errorKindForStatus,
  isRetryable,
  type FetchLike,
} from "./chat-completions-adapter";
import { resolveRole } from "./provider-factory";

// ---------------------------------------------------------------------------
// Config fixtures — vendor identity is data; tests use synthetic names.
// ---------------------------------------------------------------------------

const fakeVendor = {
  baseUrl: "https://example.invalid/v1",
  apiKeyEnv: "TEST_KEY",
  protocol: "chat-completions",
  freeTier: true,
  personalDataAllowed: false,
  models: {
    "m-chat": {
      capabilities: ["generate", "stream"],
      priceMicroUsdPerMTok: { in: 500, out: 3000 },
    },
    "m-embed": {
      capabilities: ["embed"],
      dimensions: 8,
      priceMicroUsdPerMTok: { in: 100, out: 0 },
    },
  },
} as const;

function configWith(chain: string[]) {
  const altVendor = {
    ...fakeVendor,
    apiKeyEnv: "ALT_KEY",
    // The paid-tier alternative: personal data may route here (ADR-0009).
    personalDataAllowed: true,
    freeTier: false,
    models: {
      "alt-chat": {
        capabilities: ["generate", "stream"],
        priceMicroUsdPerMTok: { in: 140, out: 280 },
      },
    },
  };
  return {
    vendors: { test: fakeVendor, alt: altVendor },
    roles: { cheap: { chain } },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function chatBody(usage = { prompt_tokens: 12, completion_tokens: 34 }): unknown {
  return {
    choices: [{ message: { content: "hello there" } }],
    usage,
  };
}

describe("provider config", () => {
  it("loads and validates the checked-in models.json", () => {
    const config = loadProviderConfig();
    // Role defaults from spec §3.4 exist as chains.
    expect(config.roles.generator?.chain.length).toBeGreaterThan(0);
    expect(config.roles.cheap?.chain.length).toBeGreaterThan(1);
    expect(config.roles.embedder?.chain.length).toBeGreaterThan(0);
    // Every chain candidate resolves to a real vendor+model.
    for (const { chain } of Object.values(config.roles)) {
      for (const key of chain) {
        const [vendor, modelId] = parseCandidateKey(key);
        const vendorConfig = config.vendors[vendor];
        expect(vendorConfig).toBeDefined();
        expect(vendorConfig?.models[modelId]).toBeDefined();
      }
    }
  });

  it("rejects a malformed or dangling config", () => {
    expect(() =>
      parseProviderConfig({
        vendors: { test: fakeVendor },
        roles: { cheap: { chain: ["test:no-such-model"] } },
      }),
    ).toThrow(/unknown model "no-such-model"/);
    expect(() =>
      parseProviderConfig({
        vendors: { test: fakeVendor },
        roles: { cheap: { chain: [] } },
      }),
    ).toThrow(/empty chain/);
    expect(() => parseCandidateKey("no-colon")).toThrow(/malformed candidate key/);
    expect(() => parseCandidateKey("vendoronly:")).toThrow(/malformed candidate key/);
  });

  it("resolveChain returns candidates in chain order", () => {
    const config = configWith(["test:m-chat", "alt:alt-chat"]);
    const chain = resolveChain(config as never, "cheap");
    expect(chain.map((c) => `${c.vendor}:${c.modelId}`)).toEqual([
      "test:m-chat",
      "alt:alt-chat",
    ]);
  });
});

describe("chat-completions adapter", () => {
  it("generate posts to the chat-completions wire and computes cost from usage × price", async () => {
    const calls: { url: string; body: Record<string, unknown>; auth: string | undefined }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
      return jsonResponse(chatBody());
    };
    const provider = createChatCompletionsProvider({
      vendor: fakeVendor as never,
      modelId: "m-chat",
      model: fakeVendor.models["m-chat"] as never,
      apiKey: "k-1",
      fetchImpl,
    });

    const result = await provider.generate({
      turns: [{ role: "user", content: "hi" }],
      options: { temperature: 0.2 },
    });

    expect(result.text).toBe("hello there");
    // 12 tokens in @ 500 µ$/MTok + 34 out @ 3000 µ$/MTok → 0.006 + 0.102 µ$
    expect(result.cost.tokensIn).toBe(12);
    expect(result.cost.tokensOut).toBe(34);
    expect(result.cost.costMicroUsd).toBe(Math.ceil((12 * 500 + 34 * 3000) / 1e6));
    expect(result.cost.modelId).toBe("m-chat");
    expect(result.cost.estimated).toBeFalsy(); // metered usage → not an estimate

    const first = calls[0];
    expect(first?.url).toBe("https://example.invalid/v1/chat/completions");
    expect(first?.auth).toBe("Bearer k-1");
    expect(first?.body.model).toBe("m-chat");
    expect(first?.body.stream).toBe(false);
    expect(first?.body.temperature).toBe(0.2);
  });

  it("generate without usage reports an estimated cost, marked estimated", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ choices: [{ message: { content: "hi there" } }] });
    const provider = createChatCompletionsProvider({
      vendor: fakeVendor as never,
      modelId: "m-chat",
      model: fakeVendor.models["m-chat"] as never,
      apiKey: "k-1",
      fetchImpl,
    });
    const result = await provider.generate({
      turns: [{ role: "user", content: "12345678" }], // 8 chars → est. 2 tokens
    });
    expect(result.cost.tokensIn).toBe(2);
    expect(result.cost.tokensOut).toBe(0);
    expect(result.cost.estimated).toBe(true);
  });

  it("maps HTTP statuses to retryable/non-retryable error kinds", () => {
    expect(errorKindForStatus(429)).toBe("rate_limited");
    expect(errorKindForStatus(500)).toBe("server");
    expect(errorKindForStatus(401)).toBe("bad_request");
    expect(isRetryable("rate_limited")).toBe(true);
    expect(isRetryable("server")).toBe(true);
    expect(isRetryable("transport")).toBe(true);
    expect(isRetryable("bad_request")).toBe(false);
    expect(isRetryable("exhausted")).toBe(false);
  });

  it("a non-retryable failure surfaces the typed ProviderError", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ error: { message: "bad key" } }, 401);
    const provider = createChatCompletionsProvider({
      vendor: fakeVendor as never,
      modelId: "m-chat",
      model: fakeVendor.models["m-chat"] as never,
      apiKey: "bad",
      fetchImpl,
    });
    await expect(
      provider.generate({ turns: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ name: "ProviderError", kind: "bad_request" });
  });

  it("embed posts to the embeddings wire and aligns vectors with inputs", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return jsonResponse({
        data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
        usage: { prompt_tokens: 9 },
      });
    };
    const provider = createChatCompletionsProvider({
      vendor: fakeVendor as never,
      modelId: "m-embed",
      model: fakeVendor.models["m-embed"] as never,
      apiKey: "k-1",
      fetchImpl,
    });

    const result = await provider.embed({ texts: ["a", "b"], dimensions: 8 });
    expect(result.vectors).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(result.cost.tokensIn).toBe(9);
    expect(result.cost.estimated).toBeFalsy(); // metered prompt tokens
    expect(bodies[0]?.model).toBe("m-embed");
    expect(bodies[0]?.dimensions).toBe(8);
  });

  it("embed without usage estimates tokens from chars, never the text count", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ data: [{ embedding: [0.1] }, { embedding: [0.2] }] });
    const provider = createChatCompletionsProvider({
      vendor: fakeVendor as never,
      modelId: "m-embed",
      model: fakeVendor.models["m-embed"] as never,
      apiKey: "k-1",
      fetchImpl,
    });
    // Two long-ish texts: estimate must be char-derived (≈10 tokens), NOT 2.
    const result = await provider.embed({
      texts: ["12345678", "12345678"], // 8 chars each → 2+2 estimated tokens
    });
    expect(result.cost.tokensIn).toBe(4);
    expect(result.cost.estimated).toBe(true);
    expect(result.cost.tokensIn).not.toBe(2); // the old text-count bug
  });

  it("embed rejects a misaligned vector count as a server error", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ data: [{ embedding: [0.1] }], usage: { prompt_tokens: 1 } });
    const provider = createChatCompletionsProvider({
      vendor: fakeVendor as never,
      modelId: "m-embed",
      model: fakeVendor.models["m-embed"] as never,
      apiKey: "k",
      fetchImpl,
    });
    await expect(provider.embed({ texts: ["a", "b"] })).rejects.toMatchObject({
      kind: "server",
    });
  });

  it("stream yields deltas and resolves cost from the final usage chunk", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      'data: {"usage":{"prompt_tokens":5,"completion_tokens":2},"choices":[{"delta":{}}]}',
      "data: [DONE]",
    ].join("\n\n");
    const fetchImpl: FetchLike = async () =>
      new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    const provider = createChatCompletionsProvider({
      vendor: fakeVendor as never,
      modelId: "m-chat",
      model: fakeVendor.models["m-chat"] as never,
      apiKey: "k",
      fetchImpl,
    });

    const handle = await provider.stream({ turns: [{ role: "user", content: "hi" }] });
    const text: string[] = [];
    for await (const delta of handle.deltas) text.push(delta);
    expect(text.join("")).toBe("Hello");
    const cost = await handle.cost();
    expect(cost.tokensIn).toBe(5);
    expect(cost.tokensOut).toBe(2);
  });

  it("stream without usage reports an estimated cost (never metered-zero)", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"abcdefgh"}}]}',
      "data: [DONE]",
    ].join("\n\n");
    const fetchImpl: FetchLike = async () =>
      new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    const provider = createChatCompletionsProvider({
      vendor: fakeVendor as never,
      modelId: "m-chat",
      model: fakeVendor.models["m-chat"] as never,
      apiKey: "k",
      fetchImpl,
    });

    const handle = await provider.stream({
      turns: [{ role: "user", content: "12345678" }], // 8 chars → est. 2 in
    });
    for await (const _ of handle.deltas) {
      // drain
    }
    const cost = await handle.cost();
    expect(cost.tokensIn).toBe(2); // estimate: ceil(8/4)
    expect(cost.tokensOut).toBe(2); // estimate: ceil(8/4)
    expect(cost.costMicroUsd).toBeGreaterThan(0);
  });

  it("capability mismatch is a bad_request, not a wire call", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("must not be called");
    };
    const embedOnly = createChatCompletionsProvider({
      vendor: fakeVendor as never,
      modelId: "m-embed",
      model: fakeVendor.models["m-embed"] as never,
      apiKey: "k",
      fetchImpl,
    });
    await expect(
      embedOnly.generate({ turns: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({ kind: "bad_request" });
  });
});

describe("fallback chain", () => {
  function makeFetch(statusByModel: Record<string, number>): FetchLike {
    return async (_url, init) => {
      const body = JSON.parse(init.body) as { model: string };
      const status = statusByModel[body.model] ?? 200;
      if (status !== 200) return jsonResponse({ error: { message: "boom" } }, status);
      return jsonResponse(
        chatBody(),
      );
    };
  }

  it("falls forward on 429 and the CostRecord carries the actual responder", async () => {
    const config = configWith(["test:m-chat", "alt:alt-chat"]);
    const { provider } = resolveRole(config as never, "cheap", {
      env: { TEST_KEY: "a", ALT_KEY: "b" },
      fetchImpl: makeFetch({ "m-chat": 429 }),
    });
    const result = await provider.generate({ turns: [{ role: "user", content: "hi" }] });
    expect(result.text).toBe("hello there");
    expect(result.cost.modelId).toBe("alt-chat"); // the fallback, not the first
  });

  it("falls forward on transport errors; 5xx retryability is proven by the exhausted test", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("network down");
      return jsonResponse(chatBody());
    };
    const config = configWith(["test:m-chat", "alt:alt-chat"]);
    const { provider } = resolveRole(config as never, "cheap", {
      env: { TEST_KEY: "a", ALT_KEY: "b" },
      fetchImpl,
    });
    const result = await provider.generate({ turns: [{ role: "user", content: "hi" }] });
    expect(result.text).toBe("hello there");
    expect(result.cost.modelId).toBe("alt-chat");
    expect(calls).toBe(2);
  });

  it("exhausted chain throws a typed error listing candidates", async () => {
    const config = configWith(["test:m-chat", "alt:alt-chat"]);
    const { provider } = resolveRole(config as never, "cheap", {
      env: { TEST_KEY: "a", ALT_KEY: "b" },
      fetchImpl: makeFetch({ "m-chat": 500, "alt-chat": 503 }),
    });
    const err = await provider
      .generate({ turns: [{ role: "user", content: "hi" }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("exhausted");
    expect((err as ProviderError).candidates).toEqual(["m-chat", "alt-chat"]);
  });

  it("non-retryable failures do not consume the chain", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse({}, 401);
    };
    const config = configWith(["test:m-chat", "alt:alt-chat"]);
    const { provider } = resolveRole(config as never, "cheap", {
      env: { TEST_KEY: "a", ALT_KEY: "b" },
      fetchImpl,
    });
    await expect(
      provider.generate({ turns: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ kind: "bad_request" });
    expect(calls).toBe(1);
  });

  it("candidates without an API key are skipped and reported", async () => {
    const config = configWith(["test:m-chat", "alt:alt-chat"]);
    const { provider, missingKeys } = resolveRole(config as never, "cheap", {
      env: { TEST_KEY: "a" }, // ALT_KEY missing
      fetchImpl: makeFetch({}),
    });
    expect(missingKeys).toEqual(["ALT_KEY"]);
    const result = await provider.generate({ turns: [{ role: "user", content: "hi" }] });
    expect(result.text).toBe("hello there");
  });

  it("a role with no keyed candidates fails with the missing env names", async () => {
    const config = configWith(["test:m-chat", "alt:alt-chat"]);
    const { provider } = resolveRole(config as never, "cheap", { env: {} });
    await expect(
      provider.generate({ turns: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/missing: TEST_KEY, ALT_KEY/);
  });

  it("an unknown role throws at wiring time", () => {
    const config = configWith(["test:m-chat"]);
    expect(() => resolveRole(config as never, "nope", { env: {} })).toThrow(
      /unknown role "nope"/,
    );
  });

  it("a personal-data call skips disallowed (free-tier) candidates and falls forward", async () => {
    // "test" disallows personal data (free tier); "alt" allows it.
    const config = configWith(["test:m-chat", "alt:alt-chat"]);
    const requestedModels: string[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      requestedModels.push((JSON.parse(init.body) as { model: string }).model);
      return jsonResponse(chatBody());
    };
    const { provider } = resolveRole(config as never, "cheap", {
      env: { TEST_KEY: "a", ALT_KEY: "b" },
      fetchImpl,
    });
    const result = await provider.generate({
      turns: [{ role: "user", content: "hi" }],
      personalData: true,
    });
    // Only the allowed candidate was called — the free tier was never hit.
    expect(requestedModels).toEqual(["alt-chat"]);
    expect(result.cost.modelId).toBe("alt-chat");
  });

  it("a personal-data call with no allowed candidate fails with a typed error", async () => {
    const config = configWith(["test:m-chat"]); // single free-tier candidate
    const fetchImpl: FetchLike = async () => {
      throw new Error("must not be called");
    };
    const { provider } = resolveRole(config as never, "cheap", {
      env: { TEST_KEY: "a" },
      fetchImpl,
    });
    await expect(
      provider.generate({ turns: [{ role: "user", content: "hi" }], personalData: true }),
    ).rejects.toMatchObject({ kind: "bad_request", name: "ProviderError" });
  });

  it("a non-personal call still uses the free-tier first candidate", async () => {
    const config = configWith(["test:m-chat", "alt:alt-chat"]);
    const requestedModels: string[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      requestedModels.push((JSON.parse(init.body) as { model: string }).model);
      return jsonResponse(chatBody());
    };
    const { provider } = resolveRole(config as never, "cheap", {
      env: { TEST_KEY: "a", ALT_KEY: "b" },
      fetchImpl,
    });
    const result = await provider.generate({ turns: [{ role: "user", content: "hi" }] });
    expect(requestedModels).toEqual(["m-chat"]);
    expect(result.cost.modelId).toBe("m-chat");
  });
});