import type { CostRecord } from "@app/contracts";
import type { ProviderError } from "@app/rag-core";

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
export function withAttemptCost(
  err: ProviderError,
  cost: CostRecord,
): ProviderError {
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
