import { Cause, Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { ProviderError } from "@app/rag-core";
import type { FetchLike } from "./chat-completions-adapter";
import { resolveRole } from "./provider-factory";
import { chatBody, configWith, jsonResponse } from "./test-fixtures";


/** Run an effect that must fail, returning the typed failure itself. */
async function runFail<A>(effect: Effect.Effect<A, ProviderError, never>): Promise<ProviderError> {
  const exit = await Effect.runPromiseExit(effect);
  const failure =
    exit._tag === "Failure" ? Cause.failureOption(exit.cause) : Option.none<ProviderError>();
  if (Option.isSome(failure)) return failure.value;
  throw new Error("expected the effect to fail");
}

/** Run an effect that must succeed, returning its value. */
const runOk = <A>(effect: Effect.Effect<A, ProviderError, never>): Promise<A> =>
  Effect.runPromise(effect);

describe("fallback chain", () => {
  function makeFetch(statusByModel: Record<string, number>): FetchLike {
    return async (_url, init) => {
      const body = JSON.parse(init.body) as { model: string };
      const status = statusByModel[body.model] ?? 200;
      if (status !== 200) return jsonResponse({ error: { message: "boom" } }, status);
      return jsonResponse(chatBody());
    };
  }

  it("falls forward on 429 and the CostRecord carries the actual responder", async () => {
    const config = configWith(["test:m-chat", "alt:alt-chat"]);
    const { provider } = resolveRole(config, "cheap", {
      env: { TEST_KEY: "a", ALT_KEY: "b" },
      fetchImpl: makeFetch({ "m-chat": 429 }),
    });
    const result = await runOk(provider.generate({ turns: [{ role: "user", content: "hi" }] }));
    expect(result.text).toBe("hello there");
    expect(result.cost.modelId).toBe("alt-chat"); // the fallback, not the first
  });

  it("falls forward on 5xx", async () => {
    const config = configWith(["test:m-chat", "alt:alt-chat"]);
    const { provider } = resolveRole(config, "cheap", {
      env: { TEST_KEY: "a", ALT_KEY: "b" },
      fetchImpl: makeFetch({ "m-chat": 503 }),
    });
    const result = await runOk(provider.generate({ turns: [{ role: "user", content: "hi" }] }));
    expect(result.cost.modelId).toBe("alt-chat");
  });

  it("falls forward on transport errors", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("network down");
      return jsonResponse(chatBody());
    };
    const config = configWith(["test:m-chat", "alt:alt-chat"]);
    const { provider } = resolveRole(config, "cheap", {
      env: { TEST_KEY: "a", ALT_KEY: "b" },
      fetchImpl,
    });
    const result = await runOk(provider.generate({ turns: [{ role: "user", content: "hi" }] }));
    expect(result.text).toBe("hello there");
    expect(result.cost.modelId).toBe("alt-chat");
    expect(calls).toBe(2);
  });

  it("exhausted chain throws a typed error listing candidates", async () => {
    const config = configWith(["test:m-chat", "alt:alt-chat"]);
    const { provider } = resolveRole(config, "cheap", {
      env: { TEST_KEY: "a", ALT_KEY: "b" },
      fetchImpl: makeFetch({ "m-chat": 500, "alt-chat": 503 }),
    });
    const err = await runFail(provider.generate({ turns: [{ role: "user", content: "hi" }] }));
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe("exhausted");
    expect(err.candidates).toEqual(["m-chat", "alt-chat"]);
  });

  it("non-retryable failures do not consume the chain", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse({}, 401);
    };
    const config = configWith(["test:m-chat", "alt:alt-chat"]);
    const { provider } = resolveRole(config, "cheap", {
      env: { TEST_KEY: "a", ALT_KEY: "b" },
      fetchImpl,
    });
    const err = await runFail(provider.generate({ turns: [{ role: "user", content: "hi" }] }));
    expect(err.kind).toBe("bad_request");
    expect(calls).toBe(1);
  });

  it("candidates without an API key are skipped and reported", async () => {
    const config = configWith(["test:m-chat", "alt:alt-chat"]);
    const { provider, missingKeys } = resolveRole(config, "cheap", {
      env: { TEST_KEY: "a" }, // ALT_KEY missing
      fetchImpl: makeFetch({}),
    });
    expect(missingKeys).toEqual(["ALT_KEY"]);
    const result = await runOk(provider.generate({ turns: [{ role: "user", content: "hi" }] }));
    expect(result.text).toBe("hello there");
  });

  it("a role with no keyed candidates fails with the missing env names", async () => {
    const config = configWith(["test:m-chat", "alt:alt-chat"]);
    const { provider } = resolveRole(config, "cheap", { env: {} });
    const err = await runFail(provider.generate({ turns: [{ role: "user", content: "hi" }] }));
    expect(err.message).toMatch(/missing: TEST_KEY, ALT_KEY/);
  });

  it("an unknown role throws at wiring time", () => {
    const config = configWith(["test:m-chat"]);
    expect(() => resolveRole(config, "nope", { env: {} })).toThrow(
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
    const { provider } = resolveRole(config, "cheap", {
      env: { TEST_KEY: "a", ALT_KEY: "b" },
      fetchImpl,
    });
    const result = await runOk(
      provider.generate({
        turns: [{ role: "user", content: "hi" }],
        personalData: true,
      }),
    );
    // Only the allowed candidate was called — the free tier was never hit.
    expect(requestedModels).toEqual(["alt-chat"]);
    expect(result.cost.modelId).toBe("alt-chat");
  });

  it("a personal-data call with no allowed candidate fails with a typed error", async () => {
    const config = configWith(["test:m-chat"]); // single free-tier candidate
    const fetchImpl: FetchLike = async () => {
      throw new Error("must not be called");
    };
    const { provider } = resolveRole(config, "cheap", {
      env: { TEST_KEY: "a" },
      fetchImpl,
    });
    const err = await runFail(
      provider.generate({ turns: [{ role: "user", content: "hi" }], personalData: true }),
    );
    expect(err.kind).toBe("bad_request");
    expect(err._tag).toBe("ProviderError");
  });

  it("a non-personal call still uses the free-tier first candidate", async () => {
    const config = configWith(["test:m-chat", "alt:alt-chat"]);
    const requestedModels: string[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      requestedModels.push((JSON.parse(init.body) as { model: string }).model);
      return jsonResponse(chatBody());
    };
    const { provider } = resolveRole(config, "cheap", {
      env: { TEST_KEY: "a", ALT_KEY: "b" },
      fetchImpl,
    });
    const result = await runOk(provider.generate({ turns: [{ role: "user", content: "hi" }] }));
    expect(requestedModels).toEqual(["m-chat"]);
    expect(result.cost.modelId).toBe("m-chat");
  });
});