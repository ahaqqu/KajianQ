import type { CostRecord } from "@app/contracts";
import { ProviderError } from "@app/rag-core";

/**
 * SSE stream parsing for the chat-completions adapter, split out to keep the
 * adapter under the agentic size limit. Parses `data:` lines, surfaces text
 * deltas, and resolves the call's CostRecord when the stream completes —
 * estimated when the vendor reports no streamed usage (ADR-0022: an estimate
 * must never be presented as metered).
 */

export interface StreamUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export type StreamOutcome = {
  usage: StreamUsage | undefined;
  charCount: number;
};

/**
 * Read an SSE body to completion, yielding content deltas and reporting the
 * usage chunk (if any) plus the total emitted character count.
 */
export async function* readSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, StreamOutcome> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: StreamUsage | undefined;
  let charCount = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const chunk = JSON.parse(payload) as {
          usage?: StreamUsage;
          choices?: { delta?: { content?: string } }[];
        };
        if (chunk.usage) usage = chunk.usage;
        const delta = chunk.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) {
          charCount += delta.length;
          yield delta;
        }
      } catch {
        // Ignore keep-alive and non-JSON lines.
      }
    }
  }
  return { usage, charCount };
}

/** Token estimate heuristic where no usage was reported (~4 chars/token). */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/**
 * Wrap an SSE stream into deltas + deferred cost. `onFailure` rejects the
 * cost promise so a caller awaiting cost on a broken stream sees the error.
 */
export function wrapSseStream(
  body: ReadableStream<Uint8Array>,
  buildCost: (outcome: StreamUsage | undefined, charCount: number) => CostRecord,
): {
  deltas: AsyncIterable<string>;
  cost: () => Promise<CostRecord>;
} {
  let costResolve: (cost: CostRecord) => void;
  let costReject: (err: unknown) => void;
  const costPromise = new Promise<CostRecord>((resolveCost, rejectCost) => {
    costResolve = resolveCost;
    costReject = rejectCost;
  });
  let settled = false;

  async function* deltas(): AsyncIterable<string> {
    try {
      const iterator = readSseStream(body);
      while (true) {
        const next = await iterator.next();
        if (next.done) {
          if (!settled) {
            settled = true;
            costResolve(buildCost(next.value.usage, next.value.charCount));
          }
          return;
        }
        yield next.value;
      }
    } catch (err) {
      if (!settled) {
        settled = true;
        costReject(
          new ProviderError("transport", `stream failed mid-flight: ${String(err)}`),
        );
      }
      throw err;
    }
  }

  return {
    deltas: deltas(),
    cost: () => costPromise,
  };
}