import { Effect, Stream } from "effect";
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
import { estimateTokens, streamSse } from "./sse-stream";
import {
  type ChatRequest,
  type ChatResponse,
  type EmbedResponse,
  computeCost,
  readError,
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

/** Assemble the chat-completions request body shared by generate/stream. */
function buildChatRequest(
  modelId: string,
  spec: PromptSpec,
  stream: boolean,
): ChatRequest {
  return {
    model: modelId,
    messages: spec.turns.map((t) => ({ role: t.role, content: t.content })),
    stream,
    ...(spec.options ?? {}),
  };
}

export function createChatCompletionsProvider(opts: ChatCompletionsOptions): Provider {
  const { vendor, modelId, model, apiKey } = opts;
  const doFetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? 60_000;

  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  };

  async function post(path: string, body: unknown, external?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await doFetch(`${vendor.baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        // `external` aborts when the caller's fiber is interrupted (ADR-0027).
        signal: external ? AbortSignal.any([external, controller.signal]) : controller.signal,
      });
    } catch (err) {
      throw new ProviderError({ kind: "transport", message: `request to ${vendor.baseUrl}${path} failed: ${String(err)}` });
    } finally {
      clearTimeout(timer);
    }
  }

  async function assertOk(res: Response, path: string): Promise<void> {
    if (!res.ok) {
      // Include the vendor's error body (capped) — "quota exceeded" or a
      // safety refusal in the message is the difference between a retry
      // and a config fix.
      throw new ProviderError({
        kind: errorKindForStatus(res.status),
        message: `${path} failed: ${await readError(res)}`,
      });
    }
  }

  /** The wire-level implementation returns promises; the `Provider` surface
   * below wraps them into the seam's `Effect<A, ProviderError>` channel. */
  type ProviderWire = {
    readonly modelId: string;
    /** `signal` aborts the in-flight fetch when the caller's fiber is interrupted. */
    generate(spec: PromptSpec, signal?: AbortSignal): Promise<GenerationResult>;
    stream(spec: PromptSpec, signal?: AbortSignal): Promise<StreamHandle>;
    embed(spec: EmbedSpec, signal?: AbortSignal): Promise<EmbeddingResult>;
  };

  const wire: ProviderWire = {
    modelId,

    async generate(spec: PromptSpec, signal?: AbortSignal): Promise<GenerationResult> {
      if (!model.capabilities.includes("generate")) {
        throw new ProviderError({ kind: "bad_request", message: `model ${modelId} does not support generate` });
      }
      const body = buildChatRequest(modelId, spec, false);
      const started = Date.now();
      const res = await post("/chat/completions", body, signal);
      await assertOk(res, "/chat/completions");
      const json = (await res.json()) as ChatResponse;
      const text = json.choices?.[0]?.message?.content ?? json.choices?.[0]?.text ?? "";
      const meteredIn = json.usage?.prompt_tokens;
      const meteredOut = json.usage?.completion_tokens;
      const isMetered =
        typeof meteredIn === "number" && Number.isFinite(meteredIn) && meteredIn >= 0 &&
        typeof meteredOut === "number" && Number.isFinite(meteredOut) && meteredOut >= 0;
      // Where the vendor reports no usage, estimate from chars and mark the
      // record estimated (ADR-0022) — a trace must never present an estimate
      // as metered.
      const tokensIn = isMetered
        ? meteredIn!
        : spec.turns.reduce((n, t) => n + estimateTokens(t.content.length), 0);
      const tokensOut = isMetered ? meteredOut! : 0;
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

    async stream(spec: PromptSpec, signal?: AbortSignal): Promise<StreamHandle> {
      if (!model.capabilities.includes("stream")) {
        throw new ProviderError({ kind: "bad_request", message: `model ${modelId} does not support stream` });
      }
      const body = buildChatRequest(modelId, spec, true);
      const started = Date.now();
      // The controller outlives the initial fetch: cancelling the deltas
      // stream aborts the body read (ADR-0027 interruption propagation).
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await post("/chat/completions", body, signal)
        .finally(() => clearTimeout(timer))
        .catch((err: unknown) => {
          throw err instanceof ProviderError
            ? err
            : new ProviderError({
                kind: "transport",
                message: `request to ${vendor.baseUrl}/chat/completions failed: ${String(err)}`,
              });
        });
      await assertOk(res, "/chat/completions (stream)");
      if (!res.body) {
        throw new ProviderError({ kind: "transport", message: "stream response has no body" });
      }

      // Cost resolves only when the stream ends (ADR-0022); where the vendor
      // reports no streamed usage, tokens are estimated (~4 chars/token) and
      // the record is marked estimated — never presented as metered. Latency
      // is wall clock to the end of iteration, so a slow consumer inflates
      // it (deliberate; eager buffering rejected as complexity for a
      // Trace-only metric). Deltas surface as a `Stream` whose interruption
      // aborts the in-flight fetch (ADR-0027).
      const raw = streamSse(
        res.body,
        (usage, charCount) => {
        const metered =
          typeof usage?.prompt_tokens === "number" && typeof usage?.completion_tokens === "number";
        const tokensIn = metered
          ? usage!.prompt_tokens!
          : spec.turns.reduce((n, t) => n + estimateTokens(t.content.length), 0);
        const tokensOut = metered ? usage!.completion_tokens! : estimateTokens(charCount);
          return computeCost(
            modelId,
            model.priceMicroUsdPerMTok,
            tokensIn,
            tokensOut,
            Date.now() - started,
            !metered,
          );
        },
        () => controller.abort(),
      );
      return raw;
    },

    async embed(spec: EmbedSpec, signal?: AbortSignal): Promise<EmbeddingResult> {
      if (!model.capabilities.includes("embed")) {
        throw new ProviderError({ kind: "bad_request", message: `model ${modelId} does not support embed` });
      }
      const body = {
        model: modelId,
        input: spec.texts,
        ...(spec.dimensions != null && model.dimensions != null
          ? { dimensions: spec.dimensions }
          : {}),
      };
      const started = Date.now();
      const res = await post("/embeddings", body, signal);
      await assertOk(res, "/embeddings");
      const json = (await res.json()) as EmbedResponse;
      const vectors = (json.data ?? []).map((d) => d.embedding ?? []);
      if (vectors.length !== spec.texts.length) {
        throw new ProviderError({
          kind: "server",
          message: `embeddings returned ${vectors.length} vectors for ${spec.texts.length} texts`,
        });
      }
      // Embeddings meter prompt tokens only. Where the vendor reports none,
      // estimate from input chars (~4 chars/token) — never the text count,
      // which would understate cost by orders of magnitude — and mark the
      // record estimated (ADR-0022).
      const meteredIn = json.usage?.prompt_tokens;
      const isMetered = typeof meteredIn === "number" && Number.isFinite(meteredIn) && meteredIn >= 0;
      const tokensIn = isMetered
        ? meteredIn!
        : spec.texts.reduce((n, t) => n + estimateTokens(t.length), 0);
      return {
        vectors,
        cost: computeCost(
          modelId,
          model.priceMicroUsdPerMTok,
          tokensIn,
          0,
          Date.now() - started,
          !isMetered,
        ),
      };
    },
  };

  const toProviderError = (cause: unknown): ProviderError =>
    cause instanceof ProviderError
      ? cause
      : new ProviderError({ kind: "transport", message: `request to ${vendor.baseUrl} failed: ${String(cause)}` });

  const provider: Provider = {
    modelId,
    // `signal` aborts the in-flight fetch when the caller's fiber is
    // interrupted (ADR-0027 need 4: interruption reaches the provider).
    generate: (spec) =>
      Effect.tryPromise({ try: (signal) => wire.generate(spec, signal), catch: toProviderError }),
    stream: (spec) =>
      Effect.tryPromise({ try: (signal) => wire.stream(spec, signal), catch: toProviderError }),
    embed: (spec) =>
      Effect.tryPromise({ try: (signal) => wire.embed(spec, signal), catch: toProviderError }),
  };

  return provider;
}