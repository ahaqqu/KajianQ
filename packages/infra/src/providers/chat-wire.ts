import {
  ProviderError,
  type CostRecord,
  type EmbedSpec,
  type EmbeddingResult,
  type PromptSpec,
} from "@app/rag-core";

/**
 * Wire-level shapes, cost settlement helpers, and the embeddings wire for
 * the chat-completions protocol (ADR-0022) — one module holding what the
 * adapter halves share, so each stays under the agentic size limit
 * (generate lives in the adapter, streaming in chat-stream.ts). No vendor
 * or model names here: everything arrives as config data. Cost settlement
 * follows the metered/estimated rules (ADR-0022) and vendor-reaching
 * failures keep their spend on the cost trail (review C2).
 */

/** Chat-completions wire request body (one shape for generate/stream). */
export interface ChatRequest {
  model: string;
  messages: { role: string; content: string }[];
  stream: boolean;
  [key: string]: unknown;
}

/** Wire-level chat-completions response (the fields we consume). */
export interface ChatResponse {
  choices?: { message?: { content?: string }; text?: string }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string; code?: string };
}

/** Wire-level embeddings response (the fields we consume). */
export interface EmbedResponse {
  data?: { embedding?: number[] }[];
  usage?: { prompt_tokens?: number; total_tokens?: number };
  error?: { message?: string; code?: string };
}

/** Assemble the chat-completions request body shared by generate/stream. */
export function buildChatRequest(modelId: string, spec: PromptSpec, stream: boolean): ChatRequest {
  return {
    model: modelId,
    messages: spec.turns.map((t) => ({ role: t.role, content: t.content })),
    stream,
    ...spec.options,
  };
}

/** Read a non-OK response's error detail, capped — the vendor's own words
 * ("quota exceeded", a safety refusal) are the difference between a retry
 * and a config fix. */
export async function readError(res: Response): Promise<string> {
  let detail = "";
  try {
    detail = await res.text();
  } catch {
    // Body unreadable — the status line is all we have.
  }
  return `HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`;
}

/* ---------------------------------------------------------------------------
 * Cost settlement helpers (formerly chat-cost.ts).
 * --------------------------------------------------------------------------- */

/** Token estimate heuristic where the vendor reports no usage (~4 chars/token). */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** Micro-USD per MTok → micro-USD per token, keeping integer math exact. */
function microUsdPerToken(perMTok: number): number {
  // 1 MTok = 1e6 tokens, 1 USD = 1e6 micro-USD → perMTok micro-USD per MTok
  // equals perMTok/1e6 micro-USD per token. Prices are integers in micro-USD
  // per MTok; per-token cost may be fractional, so we keep a rational and
  // round at the end via Math.ceil on the total (never under-report cost).
  return perMTok / 1_000_000;
}

/** Compute a call's CostRecord from metered (or estimated) token counts. */
export function computeCost(
  modelId: string,
  price: { in: number; out: number },
  tokensIn: number,
  tokensOut: number,
  latencyMs: number,
  estimated = false,
): CostRecord {
  const exact = tokensIn * microUsdPerToken(price.in) + tokensOut * microUsdPerToken(price.out);
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

/** True when a wire-reported token count is a usable metered value. */
function isMetered(tokens: number | undefined): boolean {
  return typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0;
}

/** True when the vendor reported a complete generation usage block. */
export function isGenerationMetered(usage: {
  prompt_tokens?: number;
  completion_tokens?: number;
}): boolean {
  return isMetered(usage.prompt_tokens) && isMetered(usage.completion_tokens);
}

/** True when the vendor reported metered prompt tokens (embeddings meter prompt only). */
export function isPromptMetered(usage: { prompt_tokens?: number }): boolean {
  return isMetered(usage.prompt_tokens);
}

/**
 * Stamp a failure from an attempt that *reached the vendor* (traceability
 * rule 4, review C2): the vendor processed the request — an HTTP response
 * came back, or the streamed body cut mid-flight after partial output — so
 * that attempt's spend must stay on the cost trail even though the attempt
 * failed. The record is an estimate unless the vendor reported metered
 * tokens, and is marked `estimated` accordingly — never presented as metered
 * (ADR-0022). An error that already carries `attemptCosts` passes through
 * unchanged, so aggregation sites can call this unconditionally.
 *
 * The stamped error is a fresh instance of the same class (spread-copying a
 * `Data.TaggedError` drops prototype state — `instanceof`, `_tag`, and the
 * Error `message` — which callers rely on).
 */
export function withAttemptCost(err: ProviderError, cost: CostRecord): ProviderError {
  if (err.attemptCosts !== undefined) return err;
  // `Data.TaggedError` fields are non-enumerable, so a spread ({...err})
  // would silently drop `message`/`candidates` — copy them explicitly.
  return new (err.constructor as new (props: ProviderErrorProps) => ProviderError)({
    kind: err.kind,
    message: err.message,
    ...(err.candidates !== undefined ? { candidates: err.candidates } : {}),
    attemptCosts: [cost],
  });
}

/** The field shape `ProviderError`'s constructor takes (rag-core seam). */
type ProviderErrorProps = {
  kind: ProviderError["kind"];
  message: string;
  candidates?: readonly string[];
  attemptCosts?: readonly CostRecord[];
};

/* ---------------------------------------------------------------------------
 * The embeddings wire (formerly embed-wire.ts).
 * --------------------------------------------------------------------------- */

/**
 * The embeddings half of the chat-completions adapter (ADR-0022), split from
 * the generate/stream halves to keep each module under the agentic size
 * limit. Same wire discipline: no vendor or model names — everything arrives
 * as config data; cost settlement follows the same metered/estimated rules
 * (ADR-0022) and vendor-reaching failures keep their cost on the trail (C2).
 */

/** What an HTTP error on the embeddings wire looks like (from assertOk). */
export type EmbedWireDeps = {
  modelId: string;
  /** Prompt-token price (micro-USD per MTok); output price is unused for embeddings. */
  priceIn: number;
  /** The model's supported output dimensions (MRL truncation), when known. */
  dimensions?: number;
  /** POST the request body; failures surface as `ProviderError`. */
  post(body: unknown): Promise<Response>;
  /** Fail on an HTTP error status with the attempt's cost attached (C2). */
  assertOk(
    res: Response,
    path: string,
    attempt: { startedAt: number; promptChars: number },
  ): Promise<void>;
  /** Estimated prompt-token cost of a vendor-reaching failed attempt (C2). */
  attemptCost(startedAt: number, promptChars: number): CostRecord;
};

/** Build the wire-level embeddings call shared by every vendor protocol user. */
export function embedWire(deps: EmbedWireDeps) {
  return async function embed(spec: EmbedSpec): Promise<EmbeddingResult> {
    const body = {
      model: deps.modelId,
      input: spec.texts,
      // Requested output dimensions where both the caller asked and the
      // model supports truncation (MRL).
      ...(spec.dimensions != null && deps.dimensions != null
        ? { dimensions: spec.dimensions }
        : {}),
    };
    const started = Date.now();
    const attempt = {
      startedAt: started,
      promptChars: spec.texts.reduce((n, t) => n + t.length, 0),
    };
    const res = await deps.post(body);
    await deps.assertOk(res, "/embeddings", attempt);
    const json = (await res.json()) as EmbedResponse;
    const vectors = (json.data ?? []).map((d) => d.embedding ?? []);
    if (vectors.length !== spec.texts.length) {
      // The vendor embedded (and billed) the input before answering wrong:
      // a vendor-reaching failed attempt keeps its cost on the trail (C2).
      // Metered prompt tokens are preferred where the vendor reported them;
      // the fallback estimate is marked `estimated`.
      const isMetered = isPromptMetered(json.usage ?? {});
      throw withAttemptCost(
        new ProviderError({
          kind: "server",
          message: `embeddings returned ${vectors.length} vectors for ${spec.texts.length} texts`,
        }),
        isMetered
          ? computeCost(
              deps.modelId,
              { in: deps.priceIn, out: 0 },
              json.usage!.prompt_tokens!,
              0,
              Date.now() - started,
              false,
            )
          : deps.attemptCost(attempt.startedAt, attempt.promptChars),
      );
    }
    // Embeddings meter prompt tokens only. Where the vendor reports none,
    // estimate from input chars (~4 chars/token) — never the text count,
    // which would understate cost by orders of magnitude — and mark the
    // record estimated (ADR-0022).
    const isMetered = isPromptMetered(json.usage ?? {});
    const tokensIn = isMetered
      ? json.usage!.prompt_tokens!
      : spec.texts.reduce((n, t) => n + estimateTokens(t.length), 0);
    return {
      vectors,
      cost: computeCost(
        deps.modelId,
        { in: deps.priceIn, out: 0 },
        tokensIn,
        0,
        Date.now() - started,
        !isMetered,
      ),
    };
  };
}
