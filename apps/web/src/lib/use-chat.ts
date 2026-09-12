import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ChatCitationsFrame, ChatSessionMessage } from "@app/contracts";
import { askChat } from "./chat-client";
import {
  ChatApiError,
  clearStoredSessionId,
  loadStoredSessionId,
  rehydrateSession,
} from "./chat-store";

/**
 * The chat page's state machine (#11): full-transcript rehydration on reload
 * (TanStack Query over the rehydration endpoint), a streaming-native live
 * turn, session id + token persistence, and the typed error surface. The
 * session id state feeds ONLY the mount-time rehydration; a live turn's
 * session id rides a ref so the query never clobbers a streaming answer —
 * and neither does its `messages` result: a transcript (re)load that resolves
 * while a turn is in flight is discarded, never applied over the optimistic
 * turns (thermo-review A1).
 */

export type ChatError = "rate_limited" | "unavailable" | "generic" | "load" | null;

export function useChat(locale: "id" | "en") {
  const [sessionId, setSessionId] = useState<string | null>(loadStoredSessionId());
  const [messages, setMessages] = useState<readonly ChatSessionMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ChatError>(null);
  const [online, setOnline] = useState(true);
  const liveSessionRef = useRef<string | null>(loadStoredSessionId());

  const transcript = useQuery({
    queryKey: ["chat-transcript", sessionId],
    enabled: sessionId !== null,
    staleTime: Infinity,
    retry: false,
    queryFn: ({ signal }) => rehydrateSession(sessionId!, signal),
  });

  // `dataUpdatedAt` of the transcript result this effect last applied — or
  // discarded because a turn was in flight. One ref gives the effect its
  // apply-exactly-once rule across the busy flips that re-run it.
  const appliedTranscriptAtRef = useRef(0);

  useEffect(() => {
    console.log("EFFECT", { busy, data: transcript.data === undefined ? "undef" : transcript.data === null ? "null" : "defined", dataUpdatedAt: transcript.dataUpdatedAt, marker: appliedTranscriptAtRef.current });
    if (transcript.isError) setError("load");
    if (transcript.data === undefined) return;
    // (thermo-review A1) A transcript (re)load must never clobber an
    // in-flight streaming turn: the optimistic turns it would overwrite are
    // the live answer's only body, and the stream's patches key on their
    // ids. A result that resolves mid-turn is DISCARDED — not deferred —
    // because it was fetched before the turn's write, so applying it after
    // the turn would hide the completed turn instead.
    if (busy) {
      console.log("DISCARD", transcript.dataUpdatedAt);
      appliedTranscriptAtRef.current = transcript.dataUpdatedAt;
      return;
    }
    // Apply each result exactly once: the busy flips re-run this effect
    // without new data.
    if (transcript.dataUpdatedAt <= appliedTranscriptAtRef.current) return;
    appliedTranscriptAtRef.current = transcript.dataUpdatedAt;
    setMessages(transcript.data?.messages ?? []);
    if (transcript.data === null) {
      // The stored session was reclaimed server-side: start clean.
      clearStoredSessionId();
      liveSessionRef.current = null;
      setSessionId(null);
    }
  }, [busy, transcript.data, transcript.dataUpdatedAt, transcript.isError]);

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
        .finally(() => setBusy(false));
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
    transcriptTruncated: transcript.data?.truncated ?? false,
    send,
    newSession,
  };
}
