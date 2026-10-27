import { useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { ChatSessionMessages } from "@app/contracts";
import { conversationFileName, conversationMarkdown, saveConversationFile } from "./chat-export";
import {
  OPEN_SESSION_EVENT,
  clearChatHistory,
  forgetChatState,
  loadChatHistory,
  markChatSessionExpired,
  persistChatState,
  rehydrateSession,
  removeChatHistoryEntry,
  saveStoredSessionId,
  setConsent,
  useConsent,
  type ChatHistoryEntry,
} from "./chat-store";

/**
 * The conversation-history drawer's state: the list, the two requests a row can
 * make (open, download), the removal, and the storage switch. It lives out of
 * the drawer because that is where the logic belongs — the drawer is layout.
 *
 * Opening rehydrates through the transcript endpoint FIRST, then hands the
 * fetched transcript to the mounted chat through `OPEN_SESSION_EVENT` — the
 * drawer is rendered by the header on every route, the chat hook only on the
 * chat route. That order is what lets an expired conversation be answered where
 * the reader is looking (the row turns "Expired"), instead of closing the
 * drawer and leaving them on a blank chat or a generic error card.
 */

/** Why the list is showing a message instead of acting on the row. */
export type HistoryNotice = "expired" | "failed" | "download-failed";

/** A row's request: the transcript, or why there is none. */
type Loaded =
  | { ok: true; transcript: ChatSessionMessages }
  | { ok: false; notice: Exclude<HistoryNotice, "download-failed"> };

export function useChatHistory(onOpened: () => void) {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const consent = useConsent();
  const [entries, setEntries] = useState<readonly ChatHistoryEntry[]>(() => loadChatHistory());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<HistoryNotice | null>(null);

  const refresh = (): void => setEntries(loadChatHistory());

  /** A row's request meets the server here: a 404 marks the row, it is not an error. */
  const load = async (entry: ChatHistoryEntry): Promise<Loaded> => {
    try {
      const transcript = await rehydrateSession(entry.id);
      if (transcript !== null) return { ok: true, transcript };
    } catch {
      return { ok: false, notice: "failed" };
    }
    markChatSessionExpired(entry.id);
    refresh();
    return { ok: false, notice: "expired" };
  };

  const run = async (
    entry: ChatHistoryEntry,
    act: (transcript: ChatSessionMessages) => void,
    failure: HistoryNotice,
  ): Promise<void> => {
    if (busyId !== null) return;
    setBusyId(entry.id);
    setNotice(null);
    const result = await load(entry);
    if (result.ok) {
      try {
        act(result.transcript);
      } catch {
        setNotice(failure);
      }
    } else {
      setNotice(result.notice);
    }
    setBusyId(null);
  };

  const open = (entry: ChatHistoryEntry): Promise<void> =>
    run(
      entry,
      (transcript) => {
        saveStoredSessionId(entry.id);
        window.dispatchEvent(
          new CustomEvent(OPEN_SESSION_EVENT, { detail: { id: entry.id, transcript } }),
        );
        // No chat mounted (a static page): the stored id is what the chat
        // rehydrates from once the navigation lands.
        if (pathname !== "/") void navigate({ to: "/" });
        onOpened();
      },
      "failed",
    );

  const download = (entry: ChatHistoryEntry): Promise<void> =>
    run(
      entry,
      (transcript) =>
        saveConversationFile(
          conversationFileName(entry.title, entry.startedAt),
          conversationMarkdown(transcript, entry.locale, entry.title),
        ),
      "download-failed",
    );

  const remove = (id: string): void => {
    removeChatHistoryEntry(id);
    refresh();
  };

  const clear = (): void => {
    clearChatHistory();
    refresh();
  };

  /** The storage switch: withdrawing erases what is stored, granting keeps the tab. */
  const setKeep = (keep: boolean): void => {
    if (keep) {
      setConsent("store");
      persistChatState();
    } else {
      setConsent("session-only");
      forgetChatState();
    }
    refresh();
  };

  return {
    entries,
    consent,
    notice,
    busy: busyId !== null,
    open,
    download,
    remove,
    clear,
    setKeep,
  };
}
