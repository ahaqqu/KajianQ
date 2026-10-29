import { describe, expect, it } from "vite-plus/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeArm,
  estimateArm,
  loadApiKey,
  microUsd,
  resolveArm,
  type ArmDefinition,
} from "./sanadset-arm";
import { createArmClient, parseVerdict, type FetchInit, type FetchLike } from "./sanadset-model";
import { ModelCallCeilingError } from "./sanadset-budget";

/**
 * Test intent, named before the assertions:
 * - trap: a provider request is the only thing that spends money, so its exact shape
 *   (endpoint, method, bearer header, zero temperature, a bounded output budget) is
 *   asserted against a stub, not against a live vendor;
 * - trap: the credential must never leave the client. A sentinel key is planted and the
 *   suite asserts it appears in no record, total or status object;
 * - trap: an unparseable reply must be retried exactly once and then reported as
 *   `uncertain` — a malformed answer must never become a merge;
 * - trap: the ceiling is enforced before the request, at the network boundary, so the
 *   client refuses to issue request `ceiling + 1` even if a caller forgot to reserve;
 * - trap: the sample predictions are blind, so a sample prompt must not carry the
 *   lexical score the band prompt legitimately carries.
 */

const SENTINEL = "sk-sentinel-do-not-print-42";

function stubFetch(responses: Array<{ ok?: boolean; status?: number; body: string }>): {
  fetch: FetchLike;
  seen: Array<{ url: string; init: FetchInit }>;
} {
  const seen: Array<{ url: string; init: FetchInit }> = [];
  let index = 0;
  const fetch: FetchLike = async (url, init) => {
    seen.push({ url, init });
    const response = responses[Math.min(index, responses.length - 1)] ?? { body: "" };
    index += 1;
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      text: async () => response.body,
    };
  };
  return { fetch, seen };
}

function verdictBody(
  verdict: string,
  usage: { prompt: number; completion: number } | null = { prompt: 120, completion: 8 },
): string {
  return JSON.stringify({
    choices: [{ message: { content: `{"verdict":"${verdict}"}` } }],
    ...(usage === null
      ? {}
      : { usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion } }),
  });
}

function testArm(overrides: Partial<ArmDefinition> = {}): ArmDefinition {
  return { ...resolveArm({ provider: "dashscope" }), apiKeyEnv: "TEST_KEY_ENV", ...overrides };
}

describe("resolveArm", () => {
  it("defaults to the DashScope pilot model and its list price", () => {
    const arm = resolveArm({ provider: "dashscope" });
    expect(arm.model).toBe("qwen3.7-flash");
    expect(arm.baseUrl).toBe("https://dashscope-intl.aliyuncs.com/compatible-mode/v1");
    expect(arm.apiKeyEnv).toBe("DASHSCOPE_API_KEY");
    expect(arm.price).toEqual({ inputUsdPerMTok: 0.03, outputUsdPerMTok: 0.13 });
  });

  it("defaults to the Ollama-owned model and its list price", () => {
    const arm = resolveArm({ provider: "ollama" });
    expect(arm.model).toBe("gemma4:31b");
    expect(arm.baseUrl).toBe("https://ollama.com/v1");
    expect(arm.apiKeyEnv).toBe("OLLAMA_API_KEY");
  });

  it("refuses a model with no price on file rather than inventing one", () => {
    expect(() => resolveArm({ provider: "dashscope", model: "made-up-1" })).toThrow(
      /no price on file/u,
    );
  });

  it("accepts an explicit price override for such a model", () => {
    const arm = resolveArm({
      provider: "dashscope",
      model: "made-up-1",
      priceInUsdPerMTok: 1,
      priceOutUsdPerMTok: 2,
    });
    expect(arm.price).toEqual({ inputUsdPerMTok: 1, outputUsdPerMTok: 2 });
  });
});

describe("microUsd and estimateArm", () => {
  it("converts tokens to integer micro-USD", () => {
    expect(microUsd(120, 8, { inputUsdPerMTok: 0.03, outputUsdPerMTok: 0.13 })).toBe(5);
    expect(microUsd(0, 0, { inputUsdPerMTok: 1, outputUsdPerMTok: 1 })).toBe(0);
  });

  it("prices a plan without issuing a call and marks it estimated", () => {
    const estimate = estimateArm({ inputUsdPerMTok: 0.03, outputUsdPerMTok: 0.13 }, [
      { tokensIn: 1_000_000, tokensOut: 0 },
      { tokensIn: 0, tokensOut: 1_000_000 },
    ]);
    expect(estimate.calls).toBe(2);
    expect(estimate.tokensIn).toBe(1_000_000);
    expect(estimate.estimated).toBe(true);
    expect(estimate.costMicroUsd).toBe(160_000);
  });
});

describe("loadApiKey and describeArm", () => {
  it("prefers the environment and never puts the key in the description", () => {
    const arm = testArm();
    const lookup = loadApiKey(arm, { TEST_KEY_ENV: SENTINEL });
    expect(lookup.key?.value).toBe(SENTINEL);
    expect(lookup.key?.source).toBe("env");
    const status = describeArm(arm, lookup);
    expect(status.keyPresent).toBe(true);
    expect(status.keySource).toBe("env");
    expect(JSON.stringify(status)).not.toContain(SENTINEL);
    expect(status.keyDetail).not.toContain(SENTINEL);
  });

  it("falls back to the machine-local key file", () => {
    const dir = mkdtempSync(join(tmpdir(), "sanadset-key-"));
    const keyFile = join(dir, "key");
    writeFileSync(keyFile, `${SENTINEL}\n`, "utf8");
    const lookup = loadApiKey(testArm({ keyFile }), {});
    expect(lookup.key?.source).toBe("file");
    expect(JSON.stringify(describeArm(testArm({ keyFile }), lookup))).not.toContain(SENTINEL);
  });

  it("reports an absent credential without throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "sanadset-key-"));
    const lookup = loadApiKey(testArm({ keyFile: join(dir, "missing") }), {});
    expect(lookup.key).toBeNull();
    expect(describeArm(testArm({ keyFile: join(dir, "missing") }), lookup).keySource).toBe(
      "absent",
    );
  });
});

describe("parseVerdict", () => {
  it("reads a verdict out of fenced or padded JSON", () => {
    expect(parseVerdict('```json\n{"verdict":"same"}\n```')).toBe("same");
    expect(parseVerdict('Sure: {"verdict":"different"} — done')).toBe("different");
    expect(parseVerdict('{"verdict":"uncertain"}')).toBe("uncertain");
  });

  it("returns null for anything that is not a verdict", () => {
    expect(parseVerdict("same")).toBeNull();
    expect(parseVerdict('{"verdict":"probably"}')).toBeNull();
    expect(parseVerdict("{not json}")).toBeNull();
    expect(parseVerdict("")).toBeNull();
  });
});

describe("the provider request shape", () => {
  it("posts a bounded, zero-temperature chat completion with a bearer header", async () => {
    const stub = stubFetch([{ body: verdictBody("same") }]);
    const client = createArmClient({
      arm: resolveArm({ provider: "dashscope" }),
      apiKey: SENTINEL,
      ceiling: 10,
      fetch: stub.fetch,
    });
    expect(await client.adjudicateMatn({ a: "نص أ", b: "نص ب", score: 0.75 })).toBe("same");

    const request = stub.seen[0];
    expect(request?.url).toBe(
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
    );
    expect(request?.init.method).toBe("POST");
    expect(request?.init.headers["content-type"]).toBe("application/json");
    expect(request?.init.headers["authorization"]).toBe(`Bearer ${SENTINEL}`);
    const body = JSON.parse(request?.init.body ?? "{}");
    expect(body.model).toBe("qwen3.7-flash");
    expect(body.temperature).toBe(0);
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toBe(64);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].content).toContain("0.750");
  });

  it("uses the Ollama endpoint for the Ollama profile", async () => {
    const stub = stubFetch([{ body: verdictBody("different") }]);
    const client = createArmClient({
      arm: resolveArm({ provider: "ollama" }),
      apiKey: "k",
      ceiling: 10,
      fetch: stub.fetch,
    });
    await client.adjudicateMatn({ a: "a", b: "b", score: 0.7 });
    expect(stub.seen[0]?.url).toBe("https://ollama.com/v1/chat/completions");
    expect(JSON.parse(stub.seen[0]?.init.body ?? "{}").model).toBe("gemma4:31b");
  });

  it("keeps the sample prompt blind: no lexical score hint", async () => {
    const stub = stubFetch([{ body: verdictBody("same") }]);
    const client = createArmClient({
      arm: resolveArm({ provider: "dashscope" }),
      apiKey: "k",
      ceiling: 10,
      fetch: stub.fetch,
    });
    await client.predictSampleMatn({ a: "نص أ", b: "نص ب" });
    const prompt = JSON.parse(stub.seen[0]?.init.body ?? "{}").messages[1].content as string;
    expect(prompt).not.toContain("similarity");
    expect(prompt).toContain("نص أ");
  });
});

describe("metering", () => {
  it("meters tokens from the response usage block", async () => {
    const stub = stubFetch([{ body: verdictBody("same") }]);
    const client = createArmClient({
      arm: resolveArm({ provider: "dashscope" }),
      apiKey: SENTINEL,
      ceiling: 10,
      fetch: stub.fetch,
    });
    await client.adjudicateMatn({ a: "a", b: "b", score: 0.7 });
    const totals = client.totals();
    expect(totals).toMatchObject({
      calls: 1,
      requests: 1,
      tokensIn: 120,
      tokensOut: 8,
      costMicroUsd: 5,
      estimated: false,
    });
    expect(JSON.stringify(client.calls())).not.toContain(SENTINEL);
    expect(JSON.stringify(totals)).not.toContain(SENTINEL);
  });

  it("marks a response without usage as an estimate", async () => {
    const stub = stubFetch([{ body: verdictBody("same", null) }]);
    const client = createArmClient({
      arm: resolveArm({ provider: "dashscope" }),
      apiKey: "k",
      ceiling: 10,
      fetch: stub.fetch,
    });
    await client.adjudicateMatn({ a: "a", b: "b", score: 0.7 });
    const record = client.calls()[0];
    expect(record?.estimated).toBe(true);
    expect(record?.tokensIn).toBeGreaterThan(0);
    expect(client.totals().estimated).toBe(true);
  });

  it("sums both attempts when a reply had to be retried", async () => {
    const stub = stubFetch([{ body: "not json" }, { body: verdictBody("same") }]);
    const client = createArmClient({
      arm: resolveArm({ provider: "dashscope" }),
      apiKey: "k",
      ceiling: 10,
      fetch: stub.fetch,
    });
    expect(await client.adjudicateMatn({ a: "a", b: "b", score: 0.7 })).toBe("same");
    expect(client.calls()[0]?.attempts).toBe(2);
    const totals = client.totals();
    expect(totals).toMatchObject({ calls: 1, requests: 2, tokensOut: 20 });
    // The first attempt's body carried no usage block, so its share is estimated and the
    // whole record is marked estimated — an estimate is never presented as metered.
    expect(totals.tokensIn).toBeGreaterThan(120);
    expect(totals.estimated).toBe(true);
  });

  it("reports an unparseable reply as uncertain after exactly one retry", async () => {
    const stub = stubFetch([{ body: "not json" }]);
    const client = createArmClient({
      arm: resolveArm({ provider: "dashscope" }),
      apiKey: "k",
      ceiling: 10,
      fetch: stub.fetch,
    });
    expect(await client.adjudicateMatn({ a: "a", b: "b", score: 0.7 })).toBe("uncertain");
    expect(stub.seen).toHaveLength(2);
    expect(client.calls()[0]?.attempts).toBe(2);
  });
});

describe("the request ceiling", () => {
  it("refuses to issue request ceiling + 1", async () => {
    const stub = stubFetch([{ body: verdictBody("same") }]);
    const client = createArmClient({
      arm: resolveArm({ provider: "dashscope" }),
      apiKey: "k",
      ceiling: 2,
      fetch: stub.fetch,
    });
    await client.adjudicateMatn({ a: "a", b: "b", score: 0.7 });
    await client.adjudicateMatn({ a: "a", b: "b", score: 0.7 });
    await expect(client.adjudicateMatn({ a: "a", b: "b", score: 0.7 })).rejects.toBeInstanceOf(
      ModelCallCeilingError,
    );
    expect(stub.seen).toHaveLength(2);
  });

  it("surfaces a provider error instead of degrading it to a verdict", async () => {
    const stub = stubFetch([{ ok: false, status: 429, body: "rate limited" }]);
    const client = createArmClient({
      arm: resolveArm({ provider: "dashscope" }),
      apiKey: "k",
      ceiling: 10,
      fetch: stub.fetch,
    });
    await expect(client.adjudicateMatn({ a: "a", b: "b", score: 0.7 })).rejects.toThrow(/429/u);
  });
});
