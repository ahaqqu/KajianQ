/**
 * SSE-consuming HTTP client for `/v1/chat` (#8): the harness POSTs a question
 * and consumes the server's `text/event-stream` response, buffering text
 * deltas into the full answer and capturing the event-stream metadata the
 * server emits (trace/message ids). Non-streamed *consume* of a streamed
 * response — the wire stays SSE from the start (the product contract); the
 * harness just collapses it.
 */

/** The parsed outcome of one `/v1/chat` SSE round-trip. */
export type ChatSseResult = {
  /** The buffered answer text (concatenated `delta` events). */
  text: string;
  /** The answer message id the server assigned (from `meta` events). */
  messageId: string | null;
  /** The answer's trace id (from `meta` events). */
  traceId: string | null;
  /** Raw events in arrival order, for debugging failing runs. */
  events: { event: string; data: string }[];
};

export type ChatClientInput = {
  baseUrl: string;
  token: string;
  question: string;
  sessionId?: string;
  language?: "id" | "en";
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

/**
 * Parse one SSE frame stream into structured events. Exported for tests.
 * Handles the `event:`/`data:` field split; multi-line `data` joins with \n.
 */
export async function consumeSseToText(body: ReadableStream<Uint8Array>): Promise<ChatSseResult> {
  const decoder = new TextDecoder();
  let buffer = "";
  const events: { event: string; data: string }[] = [];
  const deltas: string[] = [];
  let messageId: string | null = null;
  let traceId: string | null = null;

  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const parsed = parseFrame(frame);
      if (!parsed) continue;
      events.push(parsed);
      if (parsed.event === "delta") {
        deltas.push(parsed.data);
      } else if (parsed.event === "meta") {
        const meta = parseChatMeta(parsed.data);
        if (meta.malformed !== undefined) {
          // B6: a malformed meta frame is diagnosable, never swallowed —
          // one bounded stderr warning per malformed frame.
          console.warn(`eval: malformed SSE meta payload: ${meta.malformed}`);
        }
        if (meta.messageId) messageId = meta.messageId;
        if (meta.traceId) traceId = meta.traceId;
      }
    }
  }
  return { text: deltas.join(""), messageId, traceId, events };
}

/** The parsed meta event payload (message/trace ids, null when absent). */
export type ChatMetaParse =
  | { messageId: string | null; traceId: string | null; malformed?: undefined }
  | { messageId: null; traceId: null; malformed: string };

/**
 * Parse one `meta` frame payload. Thermo-review B6: a malformed payload is
 * surfaced (with the raw data) instead of silently swallowed, so an operator
 * can see why a run scored answers without trace ids.
 */
export function parseChatMeta(data: string): ChatMetaParse {
  try {
    const meta = JSON.parse(data) as { messageId?: string; traceId?: string };
    return { messageId: meta.messageId ?? null, traceId: meta.traceId ?? null };
  } catch {
    // Never silently discard: the raw payload rides along (bounded) for logs.
    return { messageId: null, traceId: null, malformed: data.slice(0, 200) };
  }
}

/** Parse one `event:`/`data:` frame. Returns null for comments/blanks. */
function parseFrame(frame: string): { event: string; data: string } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

/** POST one question to `/v1/chat` and consume the SSE response. */
export async function postChatSse(input: ChatClientInput): Promise<ChatSseResult> {
  const doFetch = input.fetchImpl ?? fetch;
  const res = await doFetch(`${input.baseUrl.replace(/\/$/, "")}/v1/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.token}`,
      accept: "text/event-stream",
    },
    body: JSON.stringify({
      message: input.question,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.language !== undefined ? { language: input.language } : {}),
    }),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  if (!res.ok || res.body === null) {
    throw new Error(`/v1/chat returned ${res.status}: ${await safeText(res)}`);
  }
  return consumeSseToText(res.body);
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "<unreadable body>";
  }
}
