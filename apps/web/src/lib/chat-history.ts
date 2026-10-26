import * as v from "valibot";
import type { ChatSessionMessage } from "@app/contracts";
import { HISTORY_KEY, storageGet, storageRemove, storageSet } from "./chat-storage";

/**
 * The conversations this browser has held, so "new conversation" no longer
 * strands the previous one. Local metadata only — id, first question, locale,
 * start time — never transmitted, and the transcripts themselves stay on the
 * server under the retention window the privacy notice names. The list is
 * capped: it is a way back into recent reading, not an archive.
 *
 * Every entry point goes through `chat-storage`, so the list obeys the consent
 * gate (ADR-0063) like the rest of the chat's state.
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
