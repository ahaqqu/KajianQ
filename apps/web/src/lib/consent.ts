import { useSyncExternalStore } from "react";

/**
 * The reader's answer to "keep this conversation in this browser?" (ADR-0063).
 *
 * The question is asked once and the answer is itself stored — one word, no
 * personal data — so it is not asked again. `null` means the reader has not
 * answered yet, and that state is treated exactly like "keep nothing": the chat
 * works, and nothing about it is written to the browser.
 *
 * The answer is a module-level value with subscribers rather than React state
 * because the card (the chat view) and the drawer (the header) both act on it
 * and neither owns the other.
 */
export type ChatConsent = "store" | "session-only";

export const CONSENT_KEY = "kajianq.consent";

const CHOICES: readonly string[] = ["store", "session-only"];
// Only used where localStorage refuses writes: the choice then holds for the
// tab, which is all it can do. The stored value is the source of truth, so a
// reader who clears site data is asked again.
let writeBlockedChoice: ChatConsent | null = null;
const listeners = new Set<() => void>();

function read(): ChatConsent | null {
  try {
    const raw = globalThis.localStorage?.getItem(CONSENT_KEY);
    return raw !== null && raw !== undefined && CHOICES.includes(raw)
      ? (raw as ChatConsent)
      : writeBlockedChoice;
  } catch {
    return writeBlockedChoice;
  }
}

export function loadConsent(): ChatConsent | null {
  return read();
}

export function setConsent(choice: ChatConsent): void {
  try {
    globalThis.localStorage?.setItem(CONSENT_KEY, choice);
    writeBlockedChoice = null;
  } catch {
    writeBlockedChoice = choice;
  }
  notify();
}

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Another tab answered or withdrew: the record is the same one this tab reads,
 * so its views follow without a reload (the `storage` event never fires in the
 * tab that made the change, hence `setConsent`'s own notify).
 */
function onStorage(event: StorageEvent): void {
  if (event.key === null || event.key === CONSENT_KEY) notify();
}

/** Whether the chat keys may be written to localStorage (ADR-0063's one gate). */
export function chatPersistenceAllowed(): boolean {
  return loadConsent() === "store";
}

export function useConsent(): ChatConsent | null {
  return useSyncExternalStore(subscribe, loadConsent, loadConsent);
}

function subscribe(listener: () => void): () => void {
  const watched = listeners.size === 0;
  listeners.add(listener);
  if (watched) globalThis.window?.addEventListener?.("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) globalThis.window?.removeEventListener?.("storage", onStorage);
  };
}
