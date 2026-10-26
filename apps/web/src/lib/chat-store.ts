import * as v from "valibot";
import {
  AnonymousSessionSchema,
  ChatSessionMessagesSchema,
  type ChatSessionMessages,
} from "@app/contracts";
import { apiFetch } from "./api";
import { SESSION_KEY, TOKEN_KEY, storageGet, storageRemove, storageSet } from "./chat-storage";

/**
 * The chat's server side: the anonymous Bearer token and the active session id,
 * plus the transcript calls. The keys themselves live behind `chat-storage`, so
 * they obey the consent gate (ADR-0063) without a call site deciding for itself.
 *
 * The transcript rehydrates from the server whenever the chat page mounts — a
 * reload or a return to the route — and there is no offline store (SPECS §3.1 —
 * chat needs network anyway).
 */

/**
 * Fired when a conversation is opened from the history drawer. The drawer is
 * rendered by the header on every page, while the live chat hook exists only on
 * the chat route, so the two speak through this event: the drawer rehydrates
 * the transcript (it needs the answer to render "expired" in place), persists
 * the id, and the mounted chat adopts the already-fetched transcript instead of
 * fetching it twice. On any other route no listener runs and the navigation to
 * the chat rehydrates from the stored id.
 */
export const OPEN_SESSION_EVENT = "kajianq:open-session";

export const loadStoredSessionId = (): string | null => storageGet(SESSION_KEY);
export const saveStoredSessionId = (id: string): void => storageSet(SESSION_KEY, id);
/** "New session": the next question creates a fresh session; the token stays. */
export const clearStoredSessionId = (): void => storageRemove(SESSION_KEY);
export const loadStoredToken = (): string | null => storageGet(TOKEN_KEY);
export const saveStoredToken = (token: string): void => storageSet(TOKEN_KEY, token);

/** Typed failure of every guarded call this module and chat-client make. */
export class ChatApiError extends Error {
  constructor(
    readonly kind: "unauthorized" | "rate_limited" | "unavailable" | "bad_response",
    readonly status: number,
  ) {
    super(`${kind} (${status})`);
    this.name = "ChatApiError";
  }
}

export function errorKindOf(status: number): ChatApiError["kind"] {
  if (status === 401) return "unauthorized";
  if (status === 429) return "rate_limited";
  if (status === 502 || status === 503) return "unavailable";
  return "bad_response";
}

/**
 * Mint an anonymous session (ADR-0017) and persist the token. The token
 * comes back exactly once; every caller retries a 401 through here.
 */
export async function bootstrapAnonymousToken(signal?: AbortSignal): Promise<string> {
  const res = await apiFetch("/auth/anonymous", { method: "POST", signal });
  if (!res.ok) throw new ChatApiError(errorKindOf(res.status), res.status);
  const session = v.parse(AnonymousSessionSchema, await res.json());
  saveStoredToken(session.token);
  return session.token;
}

export async function fetchSessionMessages(
  sessionId: string,
  token: string,
  signal?: AbortSignal,
): Promise<ChatSessionMessages> {
  const res = await apiFetch(`/chat/sessions/${encodeURIComponent(sessionId)}/messages`, {
    token,
    signal,
  });
  if (!res.ok) throw new ChatApiError(errorKindOf(res.status), res.status);
  return v.parse(ChatSessionMessagesSchema, await res.json());
}

/**
 * Mount-time rehydration: bootstraps a token when none is stored, retries a
 * 401 once with a fresh anonymous session, and maps a 404 (the stored session
 * was reclaimed) to null — a fresh start, not an error.
 */
export async function rehydrateSession(
  sessionId: string,
  signal?: AbortSignal,
): Promise<ChatSessionMessages | null> {
  const stored = loadStoredToken();
  const token = stored ?? (await bootstrapAnonymousToken(signal));
  try {
    return await fetchSessionMessages(sessionId, token, signal);
  } catch (err) {
    if (err instanceof ChatApiError && err.status === 404) return null;
    if (err instanceof ChatApiError && err.kind === "unauthorized") {
      return fetchSessionMessages(sessionId, await bootstrapAnonymousToken(signal), signal);
    }
    throw err;
  }
}

/**
 * Re-exported so the chat's modules keep one import: the history list, the
 * storage gate and the consent record all belong to the same chat state, and
 * their owners are split only to keep each module small.
 */
export {
  HISTORY_KEY,
  SESSION_KEY,
  TOKEN_KEY,
  forgetChatState,
  persistChatState,
} from "./chat-storage";
export {
  CHAT_HISTORY_LIMIT,
  archiveChatFromMessages,
  archiveChatSession,
  clearChatHistory,
  loadChatHistory,
  markChatSessionExpired,
  removeChatHistoryEntry,
  type ChatHistoryEntry,
} from "./chat-history";
export { CONSENT_KEY, loadConsent, setConsent, useConsent, type ChatConsent } from "./consent";
