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
 * The chat page's state machine: full-transcript rehydration on mount
 * (TanStack Query over the rehydration endpoint), a streaming-native live
 * turn, session id + token persistence, and the typed error surface. The
 * session id state feeds ONLY the mount-time rehydration; a live turn's
 * session id rides a ref so the query never clobbers a streaming answer.
 *
 * A transcript snapshot is applied only when the current mount of the page
 * requested it and no turn is in flight or has completed since that request
 * began: the snapshot carries the mount id and the completion epoch at request
 * time. The epoch counter is per component instance while the query cache is
 * module-wide and outlives the route, so a snapshot fetched before a turn that
 * completed in an earlier mount cannot be told from a current one by its epoch:
 * the mount that requested it can, and so a mount always fetches its own
 * transcript and discards — never defers — whatever the cache still holds. A
 * snapshot that answers `null` (the stored session was reclaimed) is session
 * invalidation, not transcript content, and clears the stored id even when
 * its content is discarded.
 *
 * One mount of the chat page consumes the hook at a time: the transcript cache
 * and the stored session are shared, so a second live mount would keep
 * discarding the other's snapshot and fetching its own, each capped at one
 * recovery request — a stuck view, not a transcript. The route mounts one
 * page; a second consumer is a bug, not a configuration to support.
 */

export type ChatError = "rate_limited" | "unavailable" | "generic" | "load" | null;

/** A transcript response together with the request's turn epoch and mount. */
type TranscriptSnapshot = {
  transcript: ChatSessionMessages | null;
  completedTurnEpoch: number;
  /** The `mountId` of the page mount that requested the snapshot. */
  requestedByMount: string;
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
  // This mount's identity, for the lifetime of this component instance. It
  // comes from the platform, not from module state, so a module re-evaluation
  // cannot hand a later mount an earlier mount's identity.
  const [mountId] = useState(() => crypto.randomUUID());

  const transcript = useQuery({
    queryKey: ["chat-transcript", sessionId],
    enabled: sessionId !== null,
    staleTime: Infinity,
    retry: false,
    queryFn: async ({ signal }): Promise<TranscriptSnapshot> => {
      const completedTurnEpoch = completedTurnEpochRef.current;
      const result = await rehydrateSession(sessionId!, signal);
      return { transcript: result, completedTurnEpoch, requestedByMount: mountId };
    },
  });

  // Whether the transcript result in hand is the one this mount requested. A
  // snapshot fetched by an earlier mount is not, whatever its epoch says.
  const transcriptIsThisMount = transcript.data?.requestedByMount === mountId;

  // `dataUpdatedAt` of the transcript result this effect last applied — or
  // discarded because another mount requested it, a turn was in flight, or a
  // turn had completed since the request. One ref gives the effect its
  // apply-exactly-once rule across the busy flips that re-run it.
  const appliedTranscriptAtRef = useRef(0);

  // The transcript this view is built from is the one this mount requests. The
  // cache can still hold a snapshot fetched before a turn completed in an
  // earlier mount, and nothing in that snapshot reveals it, so a mount whose
  // result belongs elsewhere asks for its own — including once a settled result
  // from an earlier mount's in-flight request arrives, which the cache would
  // otherwise keep as current. A failed load surfaces its error and is not
  // retried here.
  //
  // One recovery request per mount: in the supported single-consumer state a
  // mount asks at most once, and if a second live mount ever shared the cache
  // the cap keeps the two from fetching against each other in a loop.
  const recoveryRequestedRef = useRef(false);
  useEffect(() => {
    if (sessionId === null || transcriptIsThisMount || transcript.isError) return;
    if (transcript.fetchStatus !== "idle" || recoveryRequestedRef.current) return;
    recoveryRequestedRef.current = true;
    void transcript.refetch();
  }, [
    sessionId,
    transcriptIsThisMount,
    transcript.fetchStatus,
    transcript.isError,
    transcript.refetch,
  ]);

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
    // A snapshot this mount did not request was fetched before the route
    // remounted, so it may predate a turn completed in that earlier mount —
    // which its per-instance epoch cannot reveal. It is discarded, never
    // applied even briefly; the mount's own result is what supplies the
    // transcript.
    if (!transcriptIsThisMount) return;
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
  }, [
    busy,
    sessionId,
    transcript.data,
    transcript.dataUpdatedAt,
    transcript.isError,
    transcriptIsThisMount,
  ]);

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
    // The rehydration window lasts until this mount owns a transcript — a
    // settled result from an earlier mount does not end it — and excludes a
    // failed load, which surfaces its own error instead.
    loadingTranscript: sessionId !== null && !transcriptIsThisMount && !transcript.isError,
    // Only this mount's transcript describes what the view shows, so its
    // truncation flag is the one the view may state.
    transcriptTruncated: transcriptIsThisMount
      ? (transcript.data?.transcript?.truncated ?? false)
      : false,
    send,
    newSession,
  };
}
