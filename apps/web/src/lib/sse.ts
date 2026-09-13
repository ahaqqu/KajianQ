/**
 * Minimal SSE frame parser for the chat stream (#11). Server frames are
 * `event: <name>\ndata: <line>\n\n` with multi-line payloads emitted as one
 * `data:` line per raw line (the SSE spec) — a frame's data joins with `\n`.
 * All spec-legal line endings are handled (`\n`, `\r\n`, `\r`, in any mix):
 * each decoded chunk is normalized to `\n` before scanning, with a trailing
 * `\r` carried into the next chunk so a `\r\n` split across reads cannot
 * masquerade as the blank-line frame delimiter (thermo-review A2). Unknown
 * event names are yielded too: the consumer decides what to ignore, so the
 * wire can gain frames without breaking this client.
 */

export type SseFrame = { event: string; data: string };

/**
 * Consume a `text/event-stream` body, yielding one frame per blank-line-
 * delimited block. Handles mixed line endings via normalization, comment
 * lines (`:…`), and a final frame without a trailing blank line (stream
 * close terminates it).
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame, void, unknown> {
  const decoder = new TextDecoder();
  let buffer = "";
  let pendingCr = false;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let chunk = decoder.decode(value, { stream: true });
      // A `\r` at a chunk edge may be the first half of a `\r\n` that lands
      // in the next chunk: carry it so the split pair stays ONE line break —
      // normalizing it now would fabricate a blank-line delimiter.
      if (pendingCr) {
        chunk = `\r${chunk}`;
        pendingCr = false;
      }
      if (chunk.endsWith("\r")) {
        pendingCr = true;
        chunk = chunk.slice(0, -1);
      }
      buffer += chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      for (;;) {
        const boundary = findBoundary(buffer);
        if (boundary === null) break;
        const frame = parseFrame(buffer.slice(0, boundary.at));
        if (frame !== null) yield frame;
        buffer = buffer.slice(boundary.at + boundary.length);
      }
    }
    buffer += decoder.decode();
    if (pendingCr) buffer += "\r";
    const tail = parseFrame(buffer);
    if (tail !== null) yield tail;
  } finally {
    reader.releaseLock();
  }
}

/**
 * The first frame delimiter in the buffer. The stream is normalized to `\n`
 * line endings at decode time, so the blank-line delimiter is always
 * `\n\n` — mixed endings were already collapsed.
 */
function findBoundary(buffer: string): { at: number; length: number } | null {
  const at = buffer.indexOf("\n\n");
  return at === -1 ? null : { at, length: 2 };
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
