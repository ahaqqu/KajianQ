import {
  ProviderError,
  type CostRecord,
  type EmbedSpec,
  type EmbeddingResult,
  type PromptSpec,
} from "@app/rag-core";

/** Wire-level shapes, cost settlement helpers, and the embeddings wire for the
 * chat-completions protocol — what the adapter halves share. No vendor or model
 * names here: everything arrives as config data, and vendor-reaching failures
 * keep their spend on the cost trail. */

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

export function buildChatRequest(modelId: string, spec: PromptSpec, stream: boolean): ChatRequest {
  return {
    model: modelId,
    messages: spec.turns.map((t) => ({ role: t.role, content: t.content })),
    stream,
    ...spec.options,
  };
}

/** Read a non-OK response's error detail, capped: the vendor's own words
 * ("quota exceeded", a safety refusal) decide between a retry and a config fix. */
export async function readError(res: Response): Promise<string> {
  let detail = "";
  try {
    detail = await res.text();
  } catch {
    // Body unreadable — the status line is all we have.
  }
  return `HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`;
}

/** Token estimate heuristic where the vendor reports no usage (~4 chars/token). */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** Per-MTok price → per-token price; the quotient may be fractional, so a cost
 * is only integer once the token counts are folded in. */
function microUsdPerToken(perMTok: number): number {
  return perMTok / 1_000_000;
}

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

function isMetered(tokens: number | undefined): boolean {
  return typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0;
}

export function isGenerationMetered(usage: {
  prompt_tokens?: number;
  completion_tokens?: number;
}): boolean {
  return isMetered(usage.prompt_tokens) && isMetered(usage.completion_tokens);
}

/** True when the vendor reported metered prompt tokens; embeddings meter prompt only. */
export function isPromptMetered(usage: { prompt_tokens?: number }): boolean {
  return isMetered(usage.prompt_tokens);
}

/** Stamp a failure from an attempt that *reached the vendor* — an HTTP response
 * came back, or the streamed body cut mid-flight after partial output — so that
 * attempt's spend stays on the cost trail even though the attempt failed. The
 * record is an estimate unless the vendor reported metered tokens.
 *
 * The stamped error is a fresh instance of the same class: spread-copying a
 * `Data.TaggedError` drops prototype state (`instanceof`, `_tag`, `message`). */
export function withAttemptCost(err: ProviderError, cost: CostRecord): ProviderError {
  if (err.attemptCosts !== undefined) return err;
  return new (err.constructor as new (props: ProviderErrorProps) => ProviderError)({
    kind: err.kind,
    message: err.message,
    ...(err.candidates !== undefined ? { candidates: err.candidates } : {}),
    attemptCosts: [cost],
  });
}

type ProviderErrorProps = {
  kind: ProviderError["kind"];
  message: string;
  candidates?: readonly string[];
  attemptCosts?: readonly CostRecord[];
};

export type EmbedWireDeps = {
  modelId: string;
  /** Prompt-token price (micro-USD per MTok); output price is unused for embeddings. */
  priceIn: number;
  /** The model's supported output dimensions (MRL truncation), when known. */
  dimensions?: number;
  /** POST the request body; failures surface as `ProviderError`. */
  post(body: unknown): Promise<Response>;
  /** Fail on an HTTP error status with the attempt's cost attached. */
  assertOk(
    res: Response,
    path: string,
    attempt: { startedAt: number; promptChars: number },
  ): Promise<void>;
  /** Estimated prompt-token cost of a vendor-reaching failed attempt. */
  attemptCost(startedAt: number, promptChars: number): CostRecord;
};

export function embedWire(deps: EmbedWireDeps) {
  return async function embed(spec: EmbedSpec): Promise<EmbeddingResult> {
    const body = {
      model: deps.modelId,
      input: spec.texts,
      // Output dimensionality: the model's *configured* `dimensions` is the
      // default, not a hint — the corpus schema is built around it and the
      // RagStore adapter rejects any vector of another length, while a live
      // endpoint answers with the model's native size unless asked otherwise.
      // A caller may still override per call to compare candidates deliberately.
      ...(deps.dimensions != null ? { dimensions: spec.dimensions ?? deps.dimensions } : {}),
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
      // The vendor embedded (and billed) the input before answering wrong, so
      // the attempt keeps its cost on the trail: metered prompt tokens where
      // reported, otherwise an estimate marked `estimated`.
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
    // estimate from input chars (~4 chars/token) — never the text count, which
    // would understate cost by orders of magnitude — and mark it estimated.
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
