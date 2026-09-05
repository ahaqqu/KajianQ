import type { CostRecord } from "@app/contracts";

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

/** Wire-level embeddings response. */
export interface EmbedResponse {
  data?: { embedding?: number[] }[];
  usage?: { prompt_tokens?: number; total_tokens?: number };
  error?: { message?: string; code?: string };
}

export async function readError(res: Response): Promise<string> {
  let detail = "";
  try {
    detail = await res.text();
  } catch {
    // Body unreadable — the status line is all we have.
  }
  return `HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`;
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
