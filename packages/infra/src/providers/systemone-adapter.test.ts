import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createSystemOneDecider, resolveDecider } from "./systemone-adapter";
import type { FetchLike } from "./chat-completions-adapter";
import { jsonResponse, testVendor } from "./test-fixtures";
import type { DecisionSpec } from "@app/rag-core";
import type { VendorConfig } from "./provider-config";

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
} satisfies VendorConfig;

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
  // The test vendor is a free-tier row (`personalDataAllowed: false`); the
  // bench/ops-shaped calls here carry no personal data.
  personalData: false,
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
      // Vendor-reaching: the attempt's estimated input spend rides on the
      // error (traceability rule 4) — never a bare failure.
      expect(err.attemptCosts).toHaveLength(1);
      const cost = err.attemptCosts?.[0];
      expect(cost?.estimated).toBeTruthy();
      expect(cost?.modelId).toBe("m-decide");
      expect(cost?.tokensIn).toBeGreaterThan(0);
      expect(cost?.costMicroUsd).toBeGreaterThan(0);
    }
  });

  it("rejects a 200 whose body has no answers object", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ model: "m-decide" });
    const decider = makeDecider(fetchImpl);
    const err = await Effect.runPromise(Effect.flip(decider.decide(SPEC)));
    expect(err.kind).toBe("transport");
    expect(err.message).toContain("no answers");
    // Still vendor-reaching — the attempt cost rides on the error.
    expect(err.attemptCosts).toHaveLength(1);
    expect(err.attemptCosts?.[0]?.estimated).toBeTruthy();
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

  it("refuses a personal-data spec on a vendor that forbids it — before the wire (A1)", async () => {
    // The register rule (ADR-0009 amendment / ADR-0043) is enforced at the
    // seam, not only at resolution: a free-tier vendor may never receive the
    // reviewer pre-gate's claim spans. The hard stop must fire with NO request,
    // so the refusal spends nothing and the caller's fail-open path runs.
    let fetches = 0;
    const fetchImpl: FetchLike = async () => {
      fetches += 1;
      return jsonResponse(WIRE_RESPONSE);
    };
    const decider = makeDecider(fetchImpl);

    const err = await Effect.runPromise(
      Effect.flip(decider.decide({ ...SPEC, personalData: true })),
    );

    expect(err.kind).toBe("bad_request");
    expect(err.message).toContain("does not allow personal data");
    expect(fetches).toBe(0);
    expect(err.attemptCosts).toBeUndefined();
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

  it("drops a personal-data-ineligible candidate from a serving chain (A1)", () => {
    // The serving posture (ADR-0043): the pre-gate sends claim spans, so a
    // vendor that forbids personal data must not be wired at all. The drop is
    // reported in `ineligibleKeys` — the key is bound, so it is never listed
    // as missing — while the bench resolution (no flag) still sees it.
    const free = {
      ...systemoneVendor,
      apiKeyEnv: "FREE_KEY",
      freeTier: true,
      personalDataAllowed: false,
    };
    const paid = {
      ...systemoneVendor,
      apiKeyEnv: "PAID_KEY",
      freeTier: false,
      personalDataAllowed: true,
    };
    const config = {
      vendors: { free, paid },
      roles: { decision: { chain: ["free:m-decide", "paid:m-decide"] } },
    };

    const serving = resolveDecider(config, "decision", {
      env: { FREE_KEY: "k-free", PAID_KEY: "k-paid" },
      personalData: true,
    });
    expect(serving.deciders).toHaveLength(1);
    expect(serving.ineligibleKeys).toEqual(["FREE_KEY"]);
    expect(serving.missingKeys).toEqual([]);

    // Bench unaffected: no flag, both keyed candidates resolve.
    const bench = resolveDecider(config, "decision", {
      env: { FREE_KEY: "k-free", PAID_KEY: "k-paid" },
    });
    expect(bench.deciders).toHaveLength(2);
    expect(bench.ineligibleKeys).toEqual([]);
  });
});
