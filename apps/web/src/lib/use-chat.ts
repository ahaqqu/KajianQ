import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  ChatCitationsFrame,
  ChatSessionMessage,
  ChatSessionMessages,
  ChatTraceFrame,
} from "@app/contracts";
import { askChat } from "./chat-client";
import {
  ChatApiError,
  clearStoredSessionId,
  loadStoredSessionId,
  rehydrateSession,
} from "./chat-store";

/**
 * The chat page's state machine: full-transcript rehydration on reload
 * (TanStack Query over the rehydration endpoint), a streaming-native live
 * turn, session id + token persistence, and the typed error surface. The
 * session id state feeds ONLY the mount-time rehydration; a live turn's
 * session id rides a ref so the query never clobbers a streaming answer.
 *
 * A transcript snapshot is applied only when no turn is in flight and no turn
 * has completed since its request began: the snapshot carries the completion
 * epoch at request time, so a result fetched before a turn's write completed
 * is discarded — never deferred — rather than hiding the completed turn. A
 * snapshot that answers `null` (the stored session was reclaimed) is session
 * invalidation, not transcript content, and clears the stored id even when
 * its content is discarded.
 */

export type ChatError = "rate_limited" | "unavailable" | "generic" | "load" | null;

/** A transcript response together with the turn epoch it was requested in. */
type TranscriptSnapshot = {
  transcript: ChatSessionMessages | null;
  completedTurnEpoch: number;
};

export function useChat(locale: "id" | "en") {
  const [sessionId, setSessionId] = useState<string | null>(loadStoredSessionId());
  const [messages, setMessages] = useState<readonly ChatSessionMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ChatError>(null);
  const [online, setOnline] = useState(true);
  const liveSessionRef = useRef<string | null>(loadStoredSessionId());
  // Incremented when a turn completes. A snapshot records this at request
  // time: a turn that completed after that point is not in the response.
  const completedTurnEpochRef = useRef(0);

  const transcript = useQuery({
    queryKey: ["chat-transcript", sessionId],
    enabled: sessionId !== null,
    staleTime: Infinity,
    retry: false,
    queryFn: async ({ signal }): Promise<TranscriptSnapshot> => {
      const completedTurnEpoch = completedTurnEpochRef.current;
      const result = await rehydrateSession(sessionId!, signal);
      return { transcript: result, completedTurnEpoch };
    },
  });

  // `dataUpdatedAt` of the transcript result this effect last applied — or
  // discarded because a turn was in flight or had completed since the request.
  // One ref gives the effect its apply-exactly-once rule across the busy flips
  // that re-run it.
  const appliedTranscriptAtRef = useRef(0);

  useEffect(() => {
    if (transcript.isError) setError("load");
    const snapshot = transcript.data;
    if (snapshot === undefined) return;
    // A `null` transcript is the store's 404: the stored session is gone.
    // That is session invalidation, not transcript content, so it runs even
    // when the snapshot is discarded as stale — but only while the stored id
    // is still the one this request probed (a live turn's `meta` may have
    // saved a newer id since).
    if (snapshot.transcript === null && loadStoredSessionId() === sessionId) {
      clearStoredSessionId();
      liveSessionRef.current = null;
      setSessionId(null);
    }
    // A transcript snapshot is discarded — never deferred — when a turn is in
    // flight, or when a turn completed after its request began: it was fetched
    // before that turn's write, so applying it would hide the completed turn.
    // `busy` alone cannot carry this rule because React can render a stale
    // result's arrival together with the turn-completion render.
    if (busy || snapshot.completedTurnEpoch < completedTurnEpochRef.current) {
      appliedTranscriptAtRef.current = transcript.dataUpdatedAt;
      return;
    }
    // Apply each result exactly once: the busy flips re-run this effect
    // without new data.
    if (transcript.dataUpdatedAt <= appliedTranscriptAtRef.current) return;
    appliedTranscriptAtRef.current = transcript.dataUpdatedAt;
    setMessages(snapshot.transcript?.messages ?? []);
  }, [busy, sessionId, transcript.data, transcript.dataUpdatedAt, transcript.isError]);

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

  const send = useCallback(
    (text: string): void => {
      if (busy) return;
      setError(null);
      setBusy(true);
      const userTurn: ChatSessionMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: text,
        createdAt: Date.now(),
      };
      const assistantId = crypto.randomUUID();
      const assistantTurn: ChatSessionMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        createdAt: Date.now(),
      };
      setMessages((prev) => [...prev, userTurn, assistantTurn]);
      const patchAssistant = (patch: Partial<ChatSessionMessage>): void =>
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, ...patch } : m)));
      askChat(
        { message: text, sessionId: liveSessionRef.current, language: locale },
        {
          onMeta: (meta) => {
            liveSessionRef.current = meta.sessionId;
          },
          onDelta: (delta) =>
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + delta } : m)),
            ),
          onCitations: (frame: ChatCitationsFrame) => patchAssistant({ citations: frame }),
          onTrace: (frame: ChatTraceFrame) => patchAssistant({ trace: frame }),
        },
      )
        .catch((err: unknown) => {
          setMessages((prev) => prev.filter((m) => m.id !== assistantId));
          setError(
            err instanceof ChatApiError && err.kind === "rate_limited"
              ? "rate_limited"
              : err instanceof ChatApiError && err.kind === "unavailable"
                ? "unavailable"
                : "generic",
          );
        })
        .finally(() => {
          completedTurnEpochRef.current += 1;
          setBusy(false);
        });
    },
    [busy, locale],
  );

  const newSession = useCallback((): void => {
    clearStoredSessionId();
    liveSessionRef.current = null;
    setSessionId(null);
    setMessages([]);
    setError(null);
  }, []);

  return {
    messages,
    busy,
    error,
    online,
    loadingTranscript: transcript.isPending && sessionId !== null,
    transcriptTruncated: transcript.data?.transcript?.truncated ?? false,
    send,
    newSession,
  };
}
