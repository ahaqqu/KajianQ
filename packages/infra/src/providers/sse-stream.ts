import { Effect, Stream } from "effect";
import type { CostRecord } from "@app/contracts";
import { ProviderError } from "@app/rag-core";

/**
 * SSE stream handling for the chat-completions adapter, split out to keep the
 * adapter under the agentic size limit. Parses `data:` lines, surfaces text
 * deltas as a `Stream`, and resolves the call's `CostRecord` when the stream
 * completes — estimated when the vendor reports no streamed usage (ADR-0022:
 * an estimate must never be presented as metered).
 *
 * ADR-0027: the deltas are a `Stream` and interruption propagates — a
 * consumer that stops reading (client cancelled generation) aborts the
 * underlying fetch through the `cancel` hook, and the in-flight pump fails,
 * which settles the deferred cost as a transport failure.
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
 * Minimal push/pull queue decoupling the eager pump from stream consumption:
 * the pump always runs to completion (so the deferred cost settles even if
 * the caller never consumes the deltas), while consumer pulls can be
 * cancelled when the stream is interrupted.
 */
class DeltaQueue {
  readonly #buffer: string[] = [];
  #pending:
    | { resolve: (r: IteratorResult<string>) => void; reject: (e: unknown) => void }
    | undefined;
  #failed = false;
  #failure: unknown;
  #closed = false;
  #cancelled = false;

  push(delta: string): void {
    if (this.#pending) {
      const p = this.#pending;
      this.#pending = undefined;
      p.resolve({ value: delta, done: false });
    } else {
      this.#buffer.push(delta);
    }
  }

  close(): void {
    this.#closed = true;
    if (this.#pending) {
      const p = this.#pending;
      this.#pending = undefined;
      p.resolve({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    this.#failed = true;
    this.#failure = error;
    if (this.#pending) {
      const p = this.#pending;
      this.#pending = undefined;
      p.reject(error);
    }
  }

  /** Cancel consumers: pending and future pulls reject; pushes are dropped. */
  cancel(): void {
    this.#cancelled = true;
    if (this.#pending) {
      const p = this.#pending;
      this.#pending = undefined;
      p.reject(new Error("stream consumer cancelled"));
    }
  }

  async next(): Promise<IteratorResult<string>> {
    if (this.#buffer.length > 0) {
      const value = this.#buffer.shift();
      return { value: value as string, done: false };
    }
    if (this.#failed) throw this.#failure;
    if (this.#cancelled) throw new Error("stream consumer cancelled");
    if (this.#closed) return { value: undefined, done: true };
    return new Promise<IteratorResult<string>>((resolve, reject) => {
      this.#pending = { resolve, reject };
    });
  }
}

/**
 * Wrap an SSE body into an interruption-propagating stream handle (ADR-0027).
 *
 * The pump starts eagerly so `cost()` always settles once the call ends,
 * whether or not the caller consumed the deltas. `cancel` runs when the
 * consumer's Stream exits for any reason — including interruption — and
 * aborts the underlying fetch, failing the in-flight pump and thereby the
 * deferred cost (a cancelled generation cannot be metered; the caller records
 * the cancellation through its trace sink).
 */
export function streamSse(
  body: ReadableStream<Uint8Array>,
  buildCost: (usage: StreamUsage | undefined, charCount: number) => CostRecord,
  cancel: () => void,
): {
  deltas: Stream.Stream<string, ProviderError>;
  cost: () => Effect.Effect<CostRecord, ProviderError>;
} {
  const queue = new DeltaQueue();
  let costResolve: (cost: CostRecord) => void;
  let costReject: (err: unknown) => void;
  const costPromise = new Promise<CostRecord>((resolveCost, rejectCost) => {
    costResolve = resolveCost;
    costReject = rejectCost;
  });
  let settled = false;

  function settleDone(outcome: StreamOutcome): void {
    if (settled) return;
    settled = true;
    costResolve(buildCost(outcome.usage, outcome.charCount));
  }

  function settleFailed(err: unknown): void {
    if (settled) return;
    settled = true;
    costReject(
      new ProviderError({ kind: "transport", message: `stream failed mid-flight: ${String(err)}` }),
    );
  }

  // The eager pump owns the SSE body; its reads are what the abort signal
  // reaches, so an aborted fetch ends the pump and settles the cost.
  void (async () => {
    try {
      const iterator = readSseStream(body);
      while (true) {
        const next = await iterator.next();
        if (next.done) {
          queue.close();
          settleDone(next.value);
          break;
        }
        queue.push(next.value);
      }
    } catch (err) {
      queue.fail(err);
      settleFailed(err);
    }
  })();

  const toProviderError = (cause: unknown): ProviderError =>
    new ProviderError({ kind: "transport", message: `stream failed mid-flight: ${String(cause)}` });

  /**
   * A single-iterator async iterable over the queue. `return()` — which
   * `Stream.fromAsyncIterable` runs when its scope closes, including on
   * interruption — resolves the pending pull instead of leaving it hanging;
   * without this, `iterator.return()` queues behind the blocked `next()` and
   * interruption deadlocks.
   */
  function bufferedIterable(): AsyncIterable<string> {
    let closeResolve: (() => void) | undefined;
    const closePromise = new Promise<void>((resolve) => {
      closeResolve = resolve;
    });
    const iterator: AsyncIterator<string, undefined> = {
      next(): Promise<IteratorResult<string, undefined>> {
        return Promise.race([
          queue.next(),
          closePromise.then((): IteratorResult<string, undefined> => ({ value: undefined, done: true })),
        ]);
      },
      async return(): Promise<IteratorResult<string, undefined>> {
        closeResolve?.();
        queue.cancel();
        return { value: undefined, done: true };
      },
    };
    return { [Symbol.asyncIterator]: () => iterator };
  }

  const deltas = Stream.fromAsyncIterable(bufferedIterable(), toProviderError).pipe(
    // Runs when the consumer's Stream exits — including interruption — so a
    // cancelled generation aborts the in-flight fetch (ADR-0027 need 4).
    Stream.ensuringWith(() =>
      Effect.sync(() => {
        queue.cancel();
        cancel();
      }),
    ),
  );

  return {
    deltas,
    cost: () => Effect.tryPromise({ try: () => costPromise, catch: toProviderError }),
  };
}
