import type { CostRecord } from "@app/contracts";
import type {
  EmbedSpec,
  EmbeddingResult,
  GenerationResult,
  PromptSpec,
  Provider,
  StreamHandle,
} from "@app/rag-core";
import { ProviderError } from "@app/rag-core";
import type { ModelConfig, VendorConfig } from "./provider-config";
import { estimateTokens, wrapSseStream } from "./sse-stream";

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

/** Micro-USD per MTok → micro-USD per token, keeping integer math exact. */
function microUsdPerToken(perMTok: number): number {
  // 1 MTok = 1e6 tokens, 1 USD = 1e6 micro-USD → perMTok micro-USD per MTok
  // equals perMTok/1e6 micro-USD per token. Prices are integers in micro-USD
  // per MTok; per-token cost may be fractional, so we keep a rational and
  // round at the end via Math.ceil on the total (never under-report cost).
  return perMTok / 1_000_000;
}

function computeCost(
  modelId: string,
  price: { in: number; out: number },
  tokensIn: number,
  tokensOut: number,
  latencyMs: number,
  estimated = false,
): CostRecord {
  const exact =
    tokensIn * microUsdPerToken(price.in) + tokensOut * microUsdPerToken(price.out);
  return {
    modelId,
    tokensIn,
    tokensOut,
    latencyMs: Math.round(latencyMs),
    // Ceil so a metered-looking cost can never under-report (a fraction of a
    // micro-USD rounds up, never down).
    costMicroUsd: Math.ceil(exact),
    estimated,
  };
}

/** Chat-completions wire request body (one shape for generate/stream). */
interface ChatRequest {
  model: string;
  messages: { role: string; content: string }[];
  stream: boolean;
  [key: string]: unknown;
}

/** Wire-level chat-completions response (the fields we consume). */
interface ChatResponse {
  choices?: { message?: { content?: string }; text?: string }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string; code?: string };
}

/** Wire-level embeddings response. */
interface EmbedResponse {
  data?: { embedding?: number[] }[];
  usage?: { prompt_tokens?: number; total_tokens?: number };
  error?: { message?: string; code?: string };
}

async function readError(res: Response): Promise<string> {
  let detail = "";
  try {
    detail = await res.text();
  } catch {
    // Body unreadable — the status line is all we have.
  }
  return `HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`;
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

  async function post(path: string, body: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await doFetch(`${vendor.baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new ProviderError("transport", `request to ${vendor.baseUrl}${path} failed: ${String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async function assertOk(res: Response, path: string): Promise<void> {
    if (!res.ok) {
      // Include the vendor's error body (capped) — "quota exceeded" or a
      // safety refusal in the message is the difference between a retry
      // and a config fix.
      throw new ProviderError(
        errorKindForStatus(res.status),
        `${path} failed: ${await readError(res)}`,
      );
    }
  }

  const provider: Provider = {
    modelId,

    async generate(spec: PromptSpec): Promise<GenerationResult> {
      if (!model.capabilities.includes("generate")) {
        throw new ProviderError("bad_request", `model ${modelId} does not support generate`);
      }
      const body: ChatRequest = {
        model: modelId,
        messages: spec.turns.map((t) => ({ role: t.role, content: t.content })),
        stream: false,
        ...(spec.options ?? {}),
      };
      const started = Date.now();
      const res = await post("/chat/completions", body);
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

    async stream(spec: PromptSpec): Promise<StreamHandle> {
      if (!model.capabilities.includes("stream")) {
        throw new ProviderError("bad_request", `model ${modelId} does not support stream`);
      }
      const body: ChatRequest = {
        model: modelId,
        messages: spec.turns.map((t) => ({ role: t.role, content: t.content })),
        stream: true,
        ...(spec.options ?? {}),
      };
      const started = Date.now();
      const res = await post("/chat/completions", body);
      await assertOk(res, "/chat/completions (stream)");
      if (!res.body) {
        throw new ProviderError("transport", "stream response has no body");
      }

      // Cost resolves only when the stream ends (ADR-0022); where the vendor
      // reports no streamed usage, tokens are estimated (~4 chars/token) and
      // the record is marked estimated — never presented as metered.
      // Latency note: measures wall clock from request start to the end of
      // iteration, so a slow consumer inflates it. Deliberate — decoupling
      // the reader from consumer pull (eager buffering) would add complexity
      // and memory to every stream to fix a Trace-only metric.
      return wrapSseStream(res.body, (usage, charCount) => {
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
      });
    },

    async embed(spec: EmbedSpec): Promise<EmbeddingResult> {
      if (!model.capabilities.includes("embed")) {
        throw new ProviderError("bad_request", `model ${modelId} does not support embed`);
      }
      const body = {
        model: modelId,
        input: spec.texts,
        ...(spec.dimensions != null && model.dimensions != null
          ? { dimensions: spec.dimensions }
          : {}),
      };
      const started = Date.now();
      const res = await post("/embeddings", body);
      await assertOk(res, "/embeddings");
      const json = (await res.json()) as EmbedResponse;
      const vectors = (json.data ?? []).map((d) => d.embedding ?? []);
      if (vectors.length !== spec.texts.length) {
        throw new ProviderError(
          "server",
          `embeddings returned ${vectors.length} vectors for ${spec.texts.length} texts`,
        );
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

  return provider;
}