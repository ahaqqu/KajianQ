import { useEffect, useState } from "react";
import type { ChatSessionMessages } from "@app/contracts";
import { OPEN_SESSION_EVENT } from "./chat-store";

/**
 * The two small subscriptions the chat's state machine sits on: the browser's
 * connectivity (the transcript's offline banner reads it) and the history
 * drawer's open request. They live together because each is a page-lifetime
 * listener with no state of its own worth spreading across modules; the chat
 * hook imports them in one statement.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const sync = (): void => setOnline(window.navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);
  return online;
}

/** Subscribes the live chat to the history drawer's already-fetched transcript. */
export function useOpenSession(
  onOpen: (id: string, transcript: ChatSessionMessages) => void,
): void {
  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<{ id: string; transcript: ChatSessionMessages }>).detail;
      if (detail !== undefined) onOpen(detail.id, detail.transcript);
    };
    window.addEventListener(OPEN_SESSION_EVENT, handler);
    return () => window.removeEventListener(OPEN_SESSION_EVENT, handler);
  }, [onOpen]);
}
