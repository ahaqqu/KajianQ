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
 *
 * Lines are processed only once fully buffered, so JSON spanning chunk
 * boundaries and CRLF line endings parse correctly; the final line is
 * processed even when the body ends without a trailing newline (a dropped
 * usage chunk there would silently mark the cost estimated).
 */
export async function* readSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, StreamOutcome> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: StreamUsage | undefined;
  let charCount = 0;

  function processLine(line: string): string | undefined {
    // trim() strips CR from CRLF line endings and any stray whitespace.
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return undefined;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") return undefined;
    let chunk: {
      usage?: StreamUsage;
      choices?: { delta?: { content?: string } }[];
    };
    try {
      chunk = JSON.parse(payload) as typeof chunk;
    } catch {
      // Malformed JSON (keep-alive, vendor noise) — skip the line.
      return undefined;
    }
    if (chunk.usage) usage = chunk.usage;
    const delta = chunk.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta.length > 0) {
      charCount += delta.length;
      return delta;
    }
    return undefined;
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const delta = processLine(line);
      if (delta !== undefined) yield delta;
    }
  }
  // Flush the decoder's tail plus any final unterminated line.
  buffer += decoder.decode();
  const delta = processLine(buffer);
  if (delta !== undefined) yield delta;
  return { usage, charCount };
}

/** Token estimate heuristic where no usage was reported (~4 chars/token). */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/**
 * Wrap an SSE stream into deltas + deferred cost. `cost()` never deadlocks:
 * if `deltas` was never consumed, it drains the remainder internally
 * (discarding text) so the promise settles; if consumption is in progress,
 * it simply awaits completion. A mid-flight failure rejects the cost promise
 * so a caller awaiting cost sees the error.
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
  let deltasStarted = false;
  let iterator: AsyncGenerator<string, StreamOutcome> | undefined;

  function settle(done: boolean, value?: StreamOutcome | Error): void {
    if (settled) return;
    settled = true;
    if (done && value && "usage" in value) {
      costResolve(buildCost(value.usage, value.charCount));
    } else if (value instanceof Error) {
      costReject(value);
    }
  }

  function start(): AsyncGenerator<string, StreamOutcome> {
    if (!iterator) iterator = readSseStream(body);
    return iterator;
  }

  async function* deltas(): AsyncIterable<string> {
    deltasStarted = true;
    const it = start();
    try {
      while (true) {
        const next = await it.next();
        if (next.done) {
          settle(true, next.value);
          return;
        }
        yield next.value;
      }
    } catch (err) {
      settle(false, new ProviderError("transport", `stream failed mid-flight: ${String(err)}`));
      throw err;
    }
  }

  async function cost(): Promise<CostRecord> {
    // If deltas were never consumed, drain the remainder (text discarded) so
    // the cost promise settles instead of deadlocking. When a consumer is
    // mid-iteration it owns the generator — racing it here would steal its
    // next delta — so cost() only awaits the promise it will settle.
    if (!settled && !deltasStarted) {
      const it = start();
      deltasStarted = true; // cost() now owns the generator
      while (true) {
        const next = await it.next();
        if (next.done) {
          settle(true, next.value);
          break;
        }
      }
    }
    return costPromise;
  }

  return {
    deltas: deltas(),
    cost,
  };
}