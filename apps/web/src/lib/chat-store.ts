import * as v from "valibot";
import {
  AnonymousSessionSchema,
  ChatSessionMessagesSchema,
  type ChatSessionMessages,
} from "@app/contracts";
import { apiFetch } from "./api";

/**
 * Client chat-session state (#11): the anonymous Bearer token and the active
 * session id, persisted in localStorage (ADR-0017 anonymous sessions — low
 * stakes by design). The transcript rehydrates from the server on reload;
 * there is no offline store (SPECS §3.1 — chat needs network anyway).
 *
 * Storage access goes through a lazy wrapper so the module also runs where
 * localStorage is absent (tests, hardened webviews) instead of crashing.
 */

const SESSION_KEY = "kajianq.chat.sessionId";
const TOKEN_KEY = "kajianq.auth.token";

const memory = new Map<string, string>();

function storageGet(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Storage full/blocked: keep the value for this page lifetime.
  }
  memory.set(key, value);
}

function storageRemove(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // Nothing to reclaim.
  }
  memory.delete(key);
}

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

/** Rehydrate the full transcript of a session from the server (#11). */
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
 * Reload-time rehydration: bootstraps a token when none is stored, retries
 * a 401 once with a fresh anonymous session, and maps a 404 (the stored
 * session was reclaimed) to null — a fresh start, not an error.
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
