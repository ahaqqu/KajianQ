import { chatPersistenceAllowed } from "./consent";

/**
 * The browser-storage layer of the chat: the page-lifetime map every chat key
 * falls back to, and the one gate they all write through (ADR-0063).
 *
 * Nothing here decides what a key means; it decides whether a key may leave the
 * page. Until the reader agrees to keep the conversation, a write lands in the
 * map only — the chat works, the tab keeps its state, and a reload starts a new
 * anonymous session. Removal always reaches `localStorage`: deleting is not
 * keeping.
 */

/** The `localStorage` keys the chat owns, exported so the /about notice's
 * storage card (`privacy-notice-storage.ts`) names them from here instead of
 * duplicating the literals. */
export const SESSION_KEY = "kajianq.chat.sessionId";
export const TOKEN_KEY = "kajianq.auth.token";
export const HISTORY_KEY = "kajianq.chat.history";

/** Every key the gate covers: the grant and the withdrawal walk this list. */
const CHAT_KEYS = [TOKEN_KEY, SESSION_KEY, HISTORY_KEY] as const;

const memory = new Map<string, string>();

export function storageGet(key: string): string | null {
  if (chatPersistenceAllowed()) {
    try {
      return globalThis.localStorage?.getItem(key) ?? memory.get(key) ?? null;
    } catch {
      return memory.get(key) ?? null;
    }
  }
  return memory.get(key) ?? null;
}

export function storageSet(key: string, value: string): void {
  if (chatPersistenceAllowed()) {
    try {
      globalThis.localStorage?.setItem(key, value);
    } catch {
      // Storage full/blocked: keep the value for this page lifetime.
    }
  }
  memory.set(key, value);
}

export function storageRemove(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // Nothing to reclaim.
  }
  memory.delete(key);
}

/**
 * The grant path: the chat state already in the map goes to `localStorage`, so
 * the conversation that earned "keep it here" is the one it keeps. No-op unless
 * the reader has just agreed.
 */
export function persistChatState(): void {
  if (!chatPersistenceAllowed()) return;
  for (const key of CHAT_KEYS) {
    const value = memory.get(key);
    if (value === undefined) continue;
    try {
      globalThis.localStorage?.setItem(key, value);
    } catch {
      // Blocked: memory still serves the tab.
    }
  }
}

/**
 * The withdrawal path: every chat key leaves `localStorage` while the tab keeps
 * its copy in the map, so the open conversation stays on screen and is
 * forgotten when the tab closes. The consent record itself is `setConsent`'s.
 */
export function forgetChatState(): void {
  for (const key of CHAT_KEYS) {
    try {
      const stored = globalThis.localStorage?.getItem(key);
      if (stored !== null && stored !== undefined) memory.set(key, stored);
      globalThis.localStorage?.removeItem(key);
    } catch {
      // Nothing to reclaim.
    }
  }
}
