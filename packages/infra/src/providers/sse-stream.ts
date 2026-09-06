/**
 * SSE wire-format parsing for the chat-completions adapter: reads `data:`
 * lines off the response body and yields content deltas. Cost settlement and
 * cancellation live in `chat-stream.ts`; this module knows nothing about
 * either — its contract is deltas in, usage + char count out.
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
