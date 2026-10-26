import * as v from "valibot";
import {
  AnonymousSessionSchema,
  ChatSessionMessagesSchema,
  type ChatSessionMessage,
  type ChatSessionMessages,
} from "@app/contracts";
import { apiFetch } from "./api";

/**
 * Client chat-session state: the anonymous Bearer token and the active
 * session id, persisted in localStorage (ADR-0017 anonymous sessions — low
 * stakes by design). The transcript rehydrates from the server whenever the
 * chat page mounts — a reload or a return to the route — and there is no
 * offline store (SPECS §3.1 — chat needs network anyway).
 *
 * Storage access goes through a lazy wrapper so the module also runs where
 * localStorage is absent (tests, hardened webviews) instead of crashing.
 */

/** The `localStorage` keys this module owns, exported so the /about notice's
 * storage card (`privacy-notice-storage.ts`) names them from here instead of
 * duplicating the literals. */
export const SESSION_KEY = "kajianq.chat.sessionId";
export const TOKEN_KEY = "kajianq.auth.token";
/** The conversations this browser has held, newest first (see the history API below). */
export const HISTORY_KEY = "kajianq.chat.history";

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
 * The history list: the conversations this browser has held, so "new
 * conversation" no longer strands the previous one. Local metadata only — id,
 * first question, locale, start time — never transmitted, and the transcripts
 * themselves stay on the server under the retention window the privacy notice
 * names. The list is capped: it is a way back into recent reading, not an
 * archive.
 */
export const CHAT_HISTORY_LIMIT = 20;

const HistoryEntrySchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  title: v.pipe(v.string(), v.minLength(1)),
  locale: v.picklist(["id", "en"]),
  startedAt: v.pipe(v.number(), v.integer()),
  /** The server no longer holds this conversation (a 404 on open). */
  expired: v.optional(v.boolean()),
});

export type ChatHistoryEntry = v.InferOutput<typeof HistoryEntrySchema>;

const HistorySchema = v.array(HistoryEntrySchema);

/** The stored list, or an empty one when absent or unreadable — never a throw. */
export function loadChatHistory(): ChatHistoryEntry[] {
  const raw = storageGet(HISTORY_KEY);
  if (raw === null) return [];
  try {
    return v.parse(HistorySchema, JSON.parse(raw));
  } catch {
    // Malformed or foreign JSON is treated as no history, not as an error the
    // chat has to handle: the list is a convenience, not a source of truth.
    return [];
  }
}

function saveChatHistory(entries: readonly ChatHistoryEntry[]): void {
  storageSet(HISTORY_KEY, JSON.stringify(entries));
}

/**
 * Records a conversation at the front of the list. Re-archiving an id keeps its
 * original start time (the conversation did not restart) and never duplicates
 * it; the oldest entry falls off past the cap.
 */
export function archiveChatSession(entry: {
  id: string;
  title: string;
  locale: "id" | "en";
  startedAt: number;
}): void {
  const existing = loadChatHistory();
  const prior = existing.find((row) => row.id === entry.id);
  const next = [
    {
      id: entry.id,
      title: entry.title,
      locale: entry.locale,
      startedAt: prior?.startedAt ?? entry.startedAt,
      ...(prior?.expired === true ? { expired: true } : {}),
    },
    ...existing.filter((row) => row.id !== entry.id),
  ].slice(0, CHAT_HISTORY_LIMIT);
  saveChatHistory(next);
}

/**
 * Archives the conversation a set of messages belongs to, when it has a first
 * question to name it by. An empty transcript (a fresh chat) has nothing to
 * remember and is not recorded.
 */
export function archiveChatFromMessages({
  id,
  messages,
  locale,
}: {
  id: string;
  messages: readonly ChatSessionMessage[];
  locale: "id" | "en";
}): void {
  const first = messages.find((message) => message.role === "user");
  if (first === undefined) return;
  archiveChatSession({
    id,
    title: first.content.slice(0, 120),
    locale,
    startedAt: first.createdAt,
  });
}

export function markChatSessionExpired(id: string): void {
  saveChatHistory(
    loadChatHistory().map((row) => (row.id === id ? { ...row, expired: true } : row)),
  );
}

export function removeChatHistoryEntry(id: string): void {
  saveChatHistory(loadChatHistory().filter((row) => row.id !== id));
}

export function clearChatHistory(): void {
  storageRemove(HISTORY_KEY);
}
