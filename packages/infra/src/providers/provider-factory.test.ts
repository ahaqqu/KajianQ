import { resolveRole } from "./provider-factory";
import {
  BATCH_RETRY_BUDGETS,
  batchRetrySchedule,
  defaultRetrySchedule,
  perKindRetrySchedule,
} from "./retry-schedule";
import { describe, expect, it } from "vitest";
import { ProviderError } from "@app/rag-core";
import type { FetchLike } from "./chat-completions-adapter";
import { chatBody, configWith, jsonResponse, runFail, runOk } from "./test-fixtures";

/** Fast per-kind schedule so retry tests do not sleep for real backoff. */
const fastSchedule = perKindRetrySchedule("1 millis", "1 millis");

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
      retrySchedule: fastSchedule,
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
      retrySchedule: fastSchedule,
    });
    const result = await runOk(provider.generate({ turns: [{ role: "user", content: "hi" }] }));
    expect(result.cost.modelId).toBe("alt-chat");
  });

  it("retries a transient transport failure on the same candidate before falling forward", async () => {
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
    // The retry hit the SAME candidate (call 2 succeeded) — no fallback.
    expect(result.cost.modelId).toBe("m-chat");
    expect(calls).toBe(2);
  });

  it("falls forward after a candidate's retry schedule exhausts", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async (_url, init) => {
      calls += 1;
      const model = (JSON.parse(init.body) as { model: string }).model;
      if (model === "m-chat") throw new TypeError("network down"); // transport kind
      return jsonResponse(chatBody());
    };
    const config = configWith(["test:m-chat", "alt:alt-chat"]);
    const { provider } = resolveRole(config, "cheap", {
      env: { TEST_KEY: "a", ALT_KEY: "b" },
      fetchImpl,
      retrySchedule: fastSchedule,
    });
    const result = await runOk(provider.generate({ turns: [{ role: "user", content: "hi" }] }));
    // 1 initial + 3 scheduled retries on m-chat, then the fallback answered.
    expect(calls).toBe(5);
    expect(result.cost.modelId).toBe("alt-chat");
  });

  it("per-kind retry budgets do not bleed across error kinds", async () => {
    // Review A2 regression pin: rate_limited allows 2 retries, transport 3.
    // A mixed sequence must leave each kind its full own budget — errors of
    // one kind may not consume the other kind's retries.
    const script: ReadonlyArray<"transport" | "rate_limited"> = [
      "transport",
      "transport",
      "rate_limited",
      "rate_limited",
      "rate_limited",
    ];
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      const step = script[calls];
      calls += 1;
      if (step === "transport") throw new TypeError("network down");
      return jsonResponse({ error: { message: "slow down" } }, 429);
    };
    const config = configWith(["test:m-chat"]); // single candidate: no fallback
    const { provider } = resolveRole(config, "cheap", {
      env: { TEST_KEY: "a" },
      fetchImpl,
      retrySchedule: fastSchedule,
    });
    const err = await runFail(provider.generate({ turns: [{ role: "user", content: "hi" }] }));
    // 1 initial + 2 transport retries + 2 rate_limited retries = 5 calls;
    // the third 429 finds its rate_limited budget exhausted. With the old
    // whileInput/union schedule this was 4 (the two transport faults had
    // already stepped the rate_limited arm, leaving the first 429 with zero
    // retries).
    expect(calls).toBe(5);
    expect(err.kind).toBe("exhausted");
  });

  it("a batch call site's retry budget rides out a rate-limit wall (ingest regression)", async () => {
    // The staging corpus ingest died on its **first** embedding batch: the
    // interactive default gives a 429 ≈1.5 s of backoff, which cannot outlast
    // a vendor's per-minute window, so the whole run was thrown away. The
    // batch policy is the same per-kind schedule with a longer budget; this
    // pins the mechanism on a fast clock (1 ms bases instead of 5 s) — 1
    // initial call + 5 rate-limited retries = 6 before the chain gives up,
    // versus 3 with the interactive default pinned above.
    const batchLike = perKindRetrySchedule("1 millis", "1 millis", BATCH_RETRY_BUDGETS);
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse({ error: { message: "quota exceeded" } }, 429);
    };
    const config = configWith(["test:m-chat"]); // single candidate: no fallback
    const { provider } = resolveRole(config, "cheap", {
      env: { TEST_KEY: "a" },
      fetchImpl,
      retrySchedule: batchLike,
    });
    const err = await runFail(provider.generate({ turns: [{ role: "user", content: "hi" }] }));
    expect(calls).toBe(1 + BATCH_RETRY_BUDGETS.rateLimitedRetries);
    expect(err.kind).toBe("exhausted");
    // The two policies must stay distinct: the batch one silently becoming the
    // interactive one is exactly the failure this test exists to catch.
    expect(batchRetrySchedule).not.toBe(defaultRetrySchedule);
    expect(BATCH_RETRY_BUDGETS.rateLimitedRetries).toBeGreaterThan(2);
  });

  it("non-retryable kinds never retry on the same candidate", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse({ error: { message: "unauthorized" } }, 401);
    };
    const config = configWith(["test:m-chat"]);
    const { provider } = resolveRole(config, "cheap", {
      env: { TEST_KEY: "a" },
      fetchImpl,
      retrySchedule: fastSchedule,
    });
    const err = await runFail(provider.generate({ turns: [{ role: "user", content: "hi" }] }));
    expect(err.kind).toBe("bad_request");
    expect(calls).toBe(1);
  });

  it("a vendor-reaching failed attempt carries its estimated cost (C2)", async () => {
    // The vendor answered 401 — the attempt reached it, so its input spend
    // must ride on the error for the caller's trace sink (traceability
    // rule 4: a failed attempt may never vanish from the cost trail).
    const config = configWith(["test:m-chat"]);
    const { provider } = resolveRole(config, "cheap", {
      env: { TEST_KEY: "a" },
      fetchImpl: async () => jsonResponse({ error: { message: "unauthorized" } }, 401),
    });
    const err = await runFail(provider.generate({ turns: [{ role: "user", content: "hi" }] }));
    expect(err.attemptCosts).toBeDefined();
    expect(err.attemptCosts).toHaveLength(1);
    const cost = err.attemptCosts![0]!;
    expect(cost.modelId).toBe("m-chat");
    expect(cost.tokensIn).toBeGreaterThan(0);
    expect(cost.estimated).toBe(true); // an estimate, never metered (ADR-0022)
    expect(cost.costMicroUsd).toBeGreaterThan(0);
  });

  it("retries accumulate every vendor-reaching attempt's cost into the final error", async () => {
    // 429s on the first candidate (vendor reached, asked us to slow down),
    // then the fallback answers. The failed attempts' spend must survive.
    let calls = 0;
    const fetchImpl: FetchLike = async (_url, init) => {
      calls += 1;
      const model = (JSON.parse(init.body) as { model: string }).model;
      if (model === "m-chat") return jsonResponse({ error: { message: "slow down" } }, 429);
      return jsonResponse(chatBody());
    };
    const config = configWith(["test:m-chat", "alt:alt-chat"]);
    const { provider } = resolveRole(config, "cheap", {
      env: { TEST_KEY: "a", ALT_KEY: "b" },
      fetchImpl,
      retrySchedule: fastSchedule,
    });
    const result = await runOk(provider.generate({ turns: [{ role: "user", content: "hi" }] }));
    expect(result.cost.modelId).toBe("alt-chat");
    expect(calls).toBe(4); // 1 initial + 2 rate_limited retries + 1 fallback
  });

  it("an exhausted chain's error lists every vendor-reaching attempt's cost", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse({ error: { message: "boom" } }, 503);
    };
    const config = configWith(["test:m-chat", "alt:alt-chat"]);
    const { provider } = resolveRole(config, "cheap", {
      env: { TEST_KEY: "a", ALT_KEY: "b" },
      fetchImpl,
      retrySchedule: fastSchedule,
    });
    const err = await runFail(provider.generate({ turns: [{ role: "user", content: "hi" }] }));
    // (1 initial + 3 server retries) per candidate × 2 candidates = 8
    // attempts, all vendor-reaching; the exhausted error carries one cost
    // record per attempt.
    expect(err.kind).toBe("exhausted");
    expect(calls).toBe(8);
    expect(err.attemptCosts).toHaveLength(8);
    expect(new Set(err.attemptCosts!.map((c) => c.modelId))).toEqual(
      new Set(["m-chat", "alt-chat"]),
    );
    for (const cost of err.attemptCosts!) {
      expect(cost.estimated).toBe(true);
    }
  });

  it("exhausted chain throws a typed error listing candidates", async () => {
    const config = configWith(["test:m-chat", "alt:alt-chat"]);
    const { provider } = resolveRole(config, "cheap", {
      env: { TEST_KEY: "a", ALT_KEY: "b" },
      fetchImpl: makeFetch({ "m-chat": 500, "alt-chat": 503 }),
      retrySchedule: fastSchedule,
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
      retrySchedule: fastSchedule,
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
    expect(() => resolveRole(config, "nope", { env: {} })).toThrow(/unknown role "nope"/);
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
