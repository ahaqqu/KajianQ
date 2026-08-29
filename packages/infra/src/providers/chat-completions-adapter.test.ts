import { describe, expect, it } from "vitest";
import {
  createChatCompletionsProvider,
  errorKindForStatus,
  isRetryable,
  type FetchLike,
} from "./chat-completions-adapter";
import { chatBody, jsonResponse, testVendor } from "./test-fixtures";

function makeProvider(modelId: "m-chat" | "m-embed", fetchImpl: FetchLike, apiKey = "k-1") {
  return createChatCompletionsProvider({
    vendor: testVendor,
    modelId,
    model: testVendor.models[modelId],
    apiKey,
    fetchImpl,
  });
}

describe("chat-completions adapter", () => {
  it("generate posts to the chat-completions wire and computes cost from usage × price", async () => {
    const calls: { url: string; body: Record<string, unknown>; auth: string | undefined }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
      return jsonResponse(chatBody());
    };
    const provider = makeProvider("m-chat", fetchImpl);

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
    const provider = makeProvider("m-chat", fetchImpl);
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
    const provider = makeProvider("m-chat", fetchImpl);
    await expect(
      provider.generate({ turns: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ name: "ProviderError", kind: "bad_request" });
  });

  it("error responses include the vendor's message body (capped)", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ error: { message: "quota exceeded for this key" } }, 429);
    const provider = makeProvider("m-chat", fetchImpl);
    const err = await provider
      .generate({ turns: [{ role: "user", content: "hi" }] })
      .catch((e: unknown) => e);
    expect((err as Error).message).toContain("quota exceeded");
    expect((err as Error).name).toBe("ProviderError");
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
    const provider = makeProvider("m-embed", fetchImpl);

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
    const provider = makeProvider("m-embed", fetchImpl);
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
    const provider = makeProvider("m-embed", fetchImpl);
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
    const provider = makeProvider("m-chat", fetchImpl);

    const handle = await provider.stream({ turns: [{ role: "user", content: "hi" }] });
    const text: string[] = [];
    for await (const delta of handle.deltas) text.push(delta);
    expect(text.join("")).toBe("Hello");
    const cost = await handle.cost();
    expect(cost.tokensIn).toBe(5);
    expect(cost.tokensOut).toBe(2);
    expect(cost.estimated).toBeFalsy(); // usage chunk was metered
  });

  it("stream without usage reports an estimated cost (never metered-zero)", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"abcdefgh"}}]}',
      "data: [DONE]",
    ].join("\n\n");
    const fetchImpl: FetchLike = async () =>
      new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    const provider = makeProvider("m-chat", fetchImpl);

    const handle = await provider.stream({
      turns: [{ role: "user", content: "12345678" }], // 8 chars → est. 2 in
    });
    for await (const _ of handle.deltas) {
      // drain
    }
    const cost = await handle.cost();
    expect(cost.tokensIn).toBe(2); // estimate: ceil(8/4)
    expect(cost.tokensOut).toBe(2); // estimate: ceil(8/4)
    expect(cost.estimated).toBe(true);
    expect(cost.costMicroUsd).toBeGreaterThan(0);
  });

  it("capability mismatch is a bad_request, not a wire call", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("must not be called");
    };
    const embedOnly = makeProvider("m-embed", fetchImpl);
    await expect(
      embedOnly.generate({ turns: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({ kind: "bad_request" });
  });
});