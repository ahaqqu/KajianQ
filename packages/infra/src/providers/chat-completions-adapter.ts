import { Effect } from "effect";
import {
  ProviderError,
  type EmbedSpec,
  type EmbeddingResult,
  type GenerationResult,
  type PromptSpec,
  type Provider,
  type StreamHandle,
} from "@app/rag-core";
import type { ModelConfig, VendorConfig } from "./provider-config";
import { streamHandle } from "./chat-stream";
import {
  buildChatRequest,
  computeCost,
  embedWire,
  estimateTokens,
  isGenerationMetered,
  readError,
  withAttemptCost,
  type ChatResponse,
} from "./chat-wire";

/**
 * The generic chat-completions REST adapter (ADR-0022): one protocol
 * implementation covering every vendor whose API speaks the chat-completions
 * wire. It contains no vendor or model names — endpoint, auth, model id, and
 * prices all arrive as config data. `fetch` is injectable so tests drive the
 * wire without a network.
 */

/** Injectable fetch, so tests fake the wire and the smoke script uses the real one. */
export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

/** How the adapter maps an HTTP failure onto ProviderError kinds. */
export function errorKindForStatus(status: number): "rate_limited" | "server" | "bad_request" {
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  return "bad_request";
}

/** True when the fallback wrapper should try the next candidate. */
export function isRetryable(kind: string): boolean {
  return kind === "transport" || kind === "rate_limited" || kind === "server";
}

export type ChatCompletionsOptions = {
  vendor: VendorConfig;
  modelId: string;
  model: ModelConfig;
  apiKey: string;
  fetchImpl?: FetchLike;
  /** Request timeout; the fallback wrapper treats timeouts as transport errors. */
  timeoutMs?: number;
};

/**
 * Build a Provider that speaks the chat-completions wire against
 * `vendor.baseUrl` with `modelId`. All vendor identity is config data.
 */

export function createChatCompletionsProvider(opts: ChatCompletionsOptions): Provider {
  const { vendor, modelId, model, apiKey } = opts;
  const doFetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? 60_000;

  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  };

  const toProviderError = (cause: unknown): ProviderError =>
    cause instanceof ProviderError
      ? cause
      : new ProviderError({
          kind: "transport",
          message: `request to ${vendor.baseUrl} failed: ${String(cause)}`,
        });

  /**
   * Estimated prompt-token cost of a failed attempt that reached the vendor
   * (C2): the vendor saw the full prompt, so its input spend is real even
   * though no completion came back. Estimated from request chars and marked
   * `estimated` — never metered (ADR-0022).
   */
  const attemptCost = (startedAt: number, promptChars: number) =>
    computeCost(
      modelId,
      model.priceMicroUsdPerMTok,
      estimateTokens(promptChars),
      0,
      Date.now() - startedAt,
      true,
    );

  async function post(
    path: string,
    body: unknown,
    // Supplied by stream() so the deltas stream's scope finalizer can abort
    // the wire after post() returns (the controller outlives the fetch).
    controller: AbortController = new AbortController(),
  ): Promise<Response> {
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await doFetch(`${vendor.baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new ProviderError({
        kind: "transport",
        message: `request to ${vendor.baseUrl}${path} failed: ${String(err)}`,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fail on an HTTP error status. The vendor was reached and answered — the
   * attempt's estimated input spend rides on the error (`attemptCosts`, C2)
   * so the caller's trace sink can record it; a failed attempt may never
   * vanish from the cost trail.
   */
  async function assertOk(
    res: Response,
    path: string,
    attempt: { startedAt: number; promptChars: number },
  ): Promise<void> {
    if (!res.ok) {
      // Include the vendor's error body (capped) — "quota exceeded" or a
      // safety refusal in the message is the difference between a retry
      // and a config fix.
      throw withAttemptCost(
        new ProviderError({
          kind: errorKindForStatus(res.status),
          message: `${path} failed: ${await readError(res)}`,
        }),
        attemptCost(attempt.startedAt, attempt.promptChars),
      );
    }
  }

  // The embeddings wire lives in embed-wire.ts (agentic size limit); the
  // deps below close over this adapter's vendor config and cost helpers.
  const embed = embedWire({
    modelId,
    priceIn: model.priceMicroUsdPerMTok.in,
    ...(model.dimensions != null ? { dimensions: model.dimensions } : {}),
    post: (body) => post("/embeddings", body),
    assertOk,
    attemptCost,
  });

  /** The wire-level implementation returns promises; the `Provider` surface
   * below wraps them into the seam's `Effect<A, ProviderError>` channel. */
  type ProviderWire = {
    readonly modelId: string;
    generate(spec: PromptSpec): Promise<GenerationResult>;
    stream(spec: PromptSpec): Promise<StreamHandle>;
    embed(spec: EmbedSpec): Promise<EmbeddingResult>;
  };

  const wire: ProviderWire = {
    modelId,

    async generate(spec: PromptSpec): Promise<GenerationResult> {
      if (!model.capabilities.includes("generate")) {
        throw new ProviderError({
          kind: "bad_request",
          message: `model ${modelId} does not support generate`,
        });
      }
      const body = buildChatRequest(modelId, spec, false);
      const started = Date.now();
      // What the vendor saw of the prompt — the estimate base for a failed
      // attempt's input cost (C2).
      const attempt = {
        startedAt: started,
        promptChars: spec.turns.reduce((n, t) => n + t.content.length, 0),
      };
      const res = await post("/chat/completions", body);
      await assertOk(res, "/chat/completions", attempt);
      // A 200 whose body fails to parse is still a vendor-reaching attempt:
      // the vendor charged for the prompt (and any completion it produced).
      let json: ChatResponse;
      try {
        json = (await res.json()) as ChatResponse;
      } catch (err) {
        throw withAttemptCost(
          new ProviderError({
            kind: "transport",
            message: `chat/completions returned 200 but the body did not parse: ${String(err)}`,
          }),
          attemptCost(attempt.startedAt, attempt.promptChars),
        );
      }
      const text = json.choices?.[0]?.message?.content ?? json.choices?.[0]?.text ?? "";
      const isMetered = isGenerationMetered(json.usage ?? {});
      // Where the vendor reports no usage, estimate from chars and mark the
      // record estimated (ADR-0022) — a trace must never present an estimate
      // as metered.
      const tokensIn = isMetered
        ? json.usage!.prompt_tokens!
        : spec.turns.reduce((n, t) => n + estimateTokens(t.content.length), 0);
      const tokensOut = isMetered ? json.usage!.completion_tokens! : 0;
      return {
        text,
        cost: computeCost(
          modelId,
          model.priceMicroUsdPerMTok,
          tokensIn,
          tokensOut,
          Date.now() - started,
          !isMetered,
        ),
      };
    },

    async stream(spec: PromptSpec): Promise<StreamHandle> {
      if (!model.capabilities.includes("stream")) {
        throw new ProviderError({
          kind: "bad_request",
          message: `model ${modelId} does not support stream`,
        });
      }
      const body = buildChatRequest(modelId, spec, true);
      const started = Date.now();
      const attempt = {
        startedAt: started,
        promptChars: spec.turns.reduce((n, t) => n + t.content.length, 0),
      };
      // The controller outlives post(): the deltas stream's scope finalizer
      // (chat-stream.ts) aborts it, cutting the wire when the consumer
      // interrupts or stops consuming early.
      const controller = new AbortController();
      const res = await post("/chat/completions", body, controller);
      await assertOk(res, "/chat/completions (stream)", attempt);
      if (!res.body) {
        // 200 with no body: the vendor was reached, so the prompt spend is
        // real (C2) even though nothing could be streamed.
        throw withAttemptCost(
          new ProviderError({ kind: "transport", message: "stream response has no body" }),
          attemptCost(attempt.startedAt, attempt.promptChars),
        );
      }
      return streamHandle({
        body: res.body,
        abort: () => controller.abort(),
        modelId,
        price: model.priceMicroUsdPerMTok,
        // Where the vendor reports no streamed usage, prompt tokens are
        // estimated (~4 chars/token); chat-stream.ts marks the record
        // estimated — never presented as metered (ADR-0022).
        promptTokensInEstimate: estimateTokens(attempt.promptChars),
        startedAt: started,
      });
    },

    async embed(spec: EmbedSpec): Promise<EmbeddingResult> {
      if (!model.capabilities.includes("embed")) {
        throw new ProviderError({
          kind: "bad_request",
          message: `model ${modelId} does not support embed`,
        });
      }
      return embed(spec);
    },
  };

  const provider: Provider = {
    modelId,
    generate: (spec) =>
      Effect.tryPromise({ try: () => wire.generate(spec), catch: toProviderError }),
    stream: (spec) => Effect.tryPromise({ try: () => wire.stream(spec), catch: toProviderError }),
    embed: (spec) => Effect.tryPromise({ try: () => wire.embed(spec), catch: toProviderError }),
  };

  return provider;
}
