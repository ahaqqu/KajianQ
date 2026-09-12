/**
 * Minimal SSE frame parser for the chat stream (#11). Server frames are
 * `event: <name>\ndata: <line>\n\n` with multi-line payloads emitted as one
 * `data:` line per raw line (the SSE spec) — a frame's data joins with `\n`.
 * Frame delimiters may be `\n\n`, `\r\n\r\n`, or `\r\r` (the SSE spec allows
 * all three). Unknown event names are yielded too: the consumer decides what
 * to ignore, so the wire can gain frames without breaking this client.
 */

export type SseFrame = { event: string; data: string };

/**
 * Consume a `text/event-stream` body, yielding one frame per blank-line-
 * delimited block. Handles `\r\n` (strip `\r`), comment lines (`:…`), and a
 * final frame without a trailing blank line (stream close terminates it).
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame, void, unknown> {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const boundary = findBoundary(buffer);
        if (boundary === null) break;
        const frame = parseFrame(buffer.slice(0, boundary.at));
        if (frame !== null) yield frame;
        buffer = buffer.slice(boundary.at + boundary.length);
      }
    }
    buffer += decoder.decode();
    const tail = parseFrame(buffer);
    if (tail !== null) yield tail;
  } finally {
    reader.releaseLock();
  }
}

/** The first frame delimiter in the buffer, as index + delimiter length. */
function findBoundary(buffer: string): { at: number; length: number } | null {
  let found: { at: number; length: number } | null = null;
  for (const [delimiter, length] of [
    ["\n\n", 2],
    ["\r\n\r\n", 4],
    ["\r\r", 2],
  ] as const) {
    const at = buffer.indexOf(delimiter);
    if (at !== -1 && (found === null || at < found.at)) found = { at, length };
  }
  return found;
}

/** Parse one blank-line-delimited block; null for comments/blanks. */
function parseFrame(block: string): SseFrame | null {
  const lines = block.split("\n").map((line) => line.replace(/\r$/, ""));
  let event = "message";
  const data: string[] = [];
  let sawData = false;
  for (const line of lines) {
    if (line === "" || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      sawData = true;
      // SSE strips a single optional leading space after the colon; further
      // spaces are payload (a leading-space answer delta must survive).
      data.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (!sawData) return null;
  return { event, data: data.join("\n") };
}
