import {
  ChatCitationsFrameSchema,
  ChatMetaSchema,
  type ChatCitationsFrame,
  type ChatMeta,
} from "@app/contracts";
import * as v from "valibot";
import { apiFetch } from "./api";
import {
  bootstrapAnonymousToken,
  ChatApiError,
  errorKindOf,
  loadStoredToken,
  saveStoredSessionId,
} from "./chat-store";
import { parseSseStream } from "./sse";

/**
 * The chat stream consumer (#11): POST /v1/chat and walk the SSE wire
 * (`meta → delta(s) → citations → done`, ADR-0034 + ADR-0040). Streaming-
 * native: deltas append as they arrive (single or multiple), the citations
 * frame is validated against the shared contract and handed over whole —
 * the client never parses answer text for citations. Token bootstrap and
 * the one-shot 401 retry (fresh anonymous session) live here so components
 * stay declarative.
 */

export type ChatStreamHandlers = {
  onMeta?: (meta: ChatMeta) => void;
  onDelta?: (text: string) => void;
  onCitations?: (frame: ChatCitationsFrame) => void;
};

export type AskChatInput = {
  message: string;
  sessionId: string | null;
  language: "id" | "en";
  signal?: AbortSignal;
};

export type AskChatResult = { token: string; sessionId: string; meta: ChatMeta };

/** POST one turn, streaming frames to the handlers. Returns the settled ids. */
export async function askChat(
  input: AskChatInput,
  handlers: ChatStreamHandlers = {},
  token: string | null = loadStoredToken(),
): Promise<AskChatResult> {
  // No usable token (first visit, expired storage) → bootstrap before asking.
  let bearer = token ?? (await bootstrapAnonymousToken(input.signal));
  let res = await postChat(input, bearer);
  if (res.status === 401) {
    // Silent token re-bootstrap, retried once (plan decision: 401 edge).
    bearer = await bootstrapAnonymousToken(input.signal);
    res = await postChat(input, bearer);
  }
  if (!res.ok) throw new ChatApiError(errorKindOf(res.status), res.status);
  if (res.body === null) throw new ChatApiError("bad_response", res.status);

  let meta: ChatMeta | null = null;
  for await (const frame of parseSseStream(res.body)) {
    if (frame.event === "meta") {
      // Identity-carrying: a malformed meta is a broken stream — fail hard.
      meta = v.parse(ChatMetaSchema, JSON.parse(frame.data));
      handlers.onMeta?.(meta);
    } else if (frame.event === "delta") {
      handlers.onDelta?.(frame.data);
    } else if (frame.event === "citations") {
      // Optional decoration: a frame that fails the contract is skipped (the
      // answer text stands; no chips) — never allowed to break the turn.
      const value = parseJsonSafe(frame.data);
      if (value === undefined) continue;
      const parsed = v.safeParse(ChatCitationsFrameSchema, value);
      if (parsed.success) handlers.onCitations?.(parsed.output);
    }
    // `done` and any future frame types need no client-side action.
  }
  if (meta === null) throw new ChatApiError("bad_response", res.status);
  saveStoredSessionId(meta.sessionId);
  return { token: bearer, sessionId: meta.sessionId, meta };
}

/** JSON.parse that yields undefined instead of throwing on garbage data. */
function parseJsonSafe(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
}

async function postChat(input: AskChatInput, bearer: string): Promise<Response> {
  return apiFetch("/chat", {
    method: "POST",
    token: bearer,
    signal: input.signal,
    body: JSON.stringify({
      message: input.message,
      ...(input.sessionId !== null ? { sessionId: input.sessionId } : {}),
      language: input.language,
    }),
  });
}
