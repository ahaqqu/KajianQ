/**
 * SSE-consuming HTTP client for `/v1/chat`: the harness POSTs a question and
 * consumes the server's `text/event-stream` response, buffering text deltas
 * into the full answer and capturing the event-stream metadata the server emits
 * (trace/message ids). Non-streamed *consume* of a streamed response — the wire
 * stays SSE from the start (the product contract); the harness just collapses it.
 */

import type { CitationFrameLike } from "./harness-types";

/** The parsed outcome of one `/v1/chat` SSE round-trip. */
export type ChatSseResult = {
  /** The buffered answer text (concatenated `delta` events). */
  text: string;
  /** The answer message id the server assigned (from `meta` events). */
  messageId: string | null;
  /** The answer's trace id (from `meta` events). */
  traceId: string | null;
  /**
   * The server's structured citations frame (ADR-0040), parsed from the
   * `citations` SSE frame. `null` when the frame was absent or malformed — the
   * scorer then falls back to the trace's `grounded` labels and the answer text.
   */
  citations: CitationFrameLike | null;
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
  let citations: CitationFrameLike | null = null;

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
          // A malformed meta frame is diagnosable, never swallowed — one
          // bounded stderr warning per malformed frame.
          console.warn(`eval: malformed SSE meta payload: ${meta.malformed}`);
        }
        if (meta.messageId) messageId = meta.messageId;
        if (meta.traceId) traceId = meta.traceId;
      } else if (parsed.event === "citations") {
        citations = parseCitationsFrame(parsed.data);
      }
    }
  }
  return { text: deltas.join(""), messageId, traceId, citations, events };
}

/**
 * Parse the `citations` SSE frame payload (ADR-0040) into the label list the
 * scorer reads. Structurally tolerant: a frame missing the `citations` array,
 * or carrying entries without a string `label`, yields `null` — the scorer's
 * fallback path — rather than a partially-read frame that could silently drop
 * a legitimate citation. Malformed JSON is diagnosable, never swallowed.
 */
export function parseCitationsFrame(data: string): CitationFrameLike | null {
  try {
    const parsed = JSON.parse(data) as { citations?: unknown };
    if (!Array.isArray(parsed.citations)) return null;
    const labels: string[] = [];
    for (const entry of parsed.citations) {
      const label = (entry as { label?: unknown } | null)?.label;
      if (typeof label === "string" && label !== "") labels.push(label);
    }
    return { citations: labels.map((label) => ({ label })) };
  } catch {
    console.warn(`eval: malformed SSE citations payload: ${data.slice(0, 200)}`);
    return null;
  }
}

/** The parsed meta event payload (message/trace ids, null when absent). */
export type ChatMetaParse =
  | { messageId: string | null; traceId: string | null; malformed?: undefined }
  | { messageId: null; traceId: null; malformed: string };

/**
 * Parse one `meta` frame payload. A malformed payload is surfaced (with the raw
 * data) instead of silently swallowed, so an operator can see why a run scored
 * answers without trace ids.
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

/**
 * Parse one `event:`/`data:` frame. Returns null for comments/blanks.
 *
 * A `data:` field drops **exactly one** leading space (the optional space
 * after the colon, per the SSE spec) — never `trimStart()`. The route replays
 * the vendor's own delta sequence, so a delta routinely begins with a space;
 * trimming all leading whitespace silently rewrites the answer on the wire and
 * can make the scorer miss a citation the persisted answer holds.
 */
function parseFrame(frame: string): { event: string; data: string } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) {
      const value = line.slice(5);
      dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
    }
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

/**
 * Which part of the `/v1/chat` round-trip failed: `connect` before any response
 * headers (DNS, refused, timeout), `response` once the edge answered with a
 * non-2xx (or a 2xx with no body), or `stream` after a 200's headers when the
 * body broke mid-read.
 */
export type ChatTransportPhase = "connect" | "response" | "stream";

/**
 * A `/v1/chat` request that produced no answer: the edge answered with a
 * non-2xx status, the connection failed, or the answer stream broke after its
 * headers.
 *
 * `status` is the response status when the edge answered, `null` otherwise;
 * `phase` says whether an answer could have existed. Together they are what a
 * caller needs to tell "the target was not available" from "the target answered
 * and the answer was bad": only a `connect` failure or a `response`-phase
 * 502/503/504 is readiness. A `stream` failure is answered-then-failed — the app
 * accepted the request and may already have spent on the turn — so it must not
 * be retried as a readiness retry. `detail` is the bounded response body, or the
 * network cause, and it stays in `message` for the run log.
 */
export class ChatTransportError extends Error {
  constructor(
    readonly status: number | null,
    readonly detail: string,
    readonly phase: ChatTransportPhase,
  ) {
    super(
      status === null
        ? `/v1/chat request failed: ${detail}`
        : `/v1/chat returned ${status}: ${detail}`,
    );
    this.name = "ChatTransportError";
  }
}

/** The bounded cause text for a failed fetch or stream, `cause` included: the
 * fetch layer reports "fetch failed" and puts the actionable code one level down. */
function transportCause(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause instanceof Error ? err.cause.message : undefined;
  return cause !== undefined && cause !== "" ? `${err.message}: ${cause}` : err.message;
}

/** POST one question to `/v1/chat` and consume the SSE response. */
export async function postChatSse(input: ChatClientInput): Promise<ChatSseResult> {
  const doFetch = input.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${input.baseUrl.replace(/\/$/, "")}/v1/chat`, {
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
  } catch (err) {
    throw new ChatTransportError(null, transportCause(err), "connect");
  }
  if (!res.ok || res.body === null) {
    throw new ChatTransportError(
      res.status,
      res.body === null ? "no response body" : await safeText(res),
      "response",
    );
  }
  try {
    return await consumeSseToText(res.body);
  } catch (err) {
    throw new ChatTransportError(null, `stream failed: ${transportCause(err)}`, "stream");
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "<unreadable body>";
  }
}
