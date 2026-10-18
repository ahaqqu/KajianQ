// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ChatSessionMessages } from "@app/contracts";
import { useChat } from "./use-chat";

// React 19 + vitest: mark the environment for act() (renderHook's flushes).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The rehydration/streaming boundary: a transcript result that lands after a
 * turn began must never clobber the optimistic turns — they are the live
 * answer's only body, and the stream's patches key on their ids. The hook
 * discards a snapshot fetched before the current turn completed and any
 * snapshot that arrives while a turn is in flight; neither is deferred past
 * the turn, and the completed turn is never hidden by a pre-turn transcript.
 */

const mocks = vi.hoisted(() => ({
  loadStoredSessionId: vi.fn<() => string | null>(),
  clearStoredSessionId: vi.fn(),
  rehydrateSession: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  askChat:
    vi.fn<(body: unknown, handlers: { onDelta: (delta: string) => void }) => Promise<void>>(),
}));

vi.mock("./chat-store", () => ({
  loadStoredSessionId: mocks.loadStoredSessionId,
  clearStoredSessionId: mocks.clearStoredSessionId,
  rehydrateSession: mocks.rehydrateSession,
  // use-chat maps ChatApiError kinds onto its typed error surface.
  ChatApiError: class ChatApiError extends Error {
    constructor(
      readonly kind: string,
      readonly status: number,
    ) {
      super(`${kind} (${status})`);
    }
  },
}));
vi.mock("./chat-client", () => ({ askChat: mocks.askChat }));

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const OLD_MESSAGES: ChatSessionMessages["messages"] = [
  { id: "m0", role: "user", content: "Pertanyaan lama", createdAt: 1 },
  { id: "m1", role: "assistant", content: "Jawaban lama", createdAt: 2 },
];
const OLD_TRANSCRIPT: ChatSessionMessages = {
  sessionId: "sess-1",
  truncated: false,
  messages: OLD_MESSAGES,
};
/** Distinct from the applied history so its delivery is observable via the hook. */
const LATE_TRANSCRIPT: ChatSessionMessages = { ...OLD_TRANSCRIPT, truncated: true };

const TRANSCRIPT_KEY = ["chat-transcript", "sess-1"] as const;

/** Fresh QueryClient per test: no cross-test cache leakage. */
function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrapperFor(client: QueryClient): (props: { children: ReactNode }) => ReactNode {
  return ({ children }) => createElement(QueryClientProvider, { client }, children);
}

/**
 * Render the hook with a deferred transcript query and a deferred answer.
 * `initialTranscript` makes the mount-time rehydration resolve from its own
 * promise, so a later refetch is the scenario's transcript request.
 */
function setupChat(
  options: { client?: QueryClient; initialTranscript?: Promise<ChatSessionMessages | null> } = {},
) {
  const client = options.client ?? makeClient();
  const transcript = deferred<ChatSessionMessages | null>();
  if (options.initialTranscript) {
    mocks.rehydrateSession.mockReturnValueOnce(options.initialTranscript);
  }
  mocks.rehydrateSession.mockReturnValue(transcript.promise);
  const answer = deferred<void>();
  let onDelta: (delta: string) => void = () => {};
  mocks.askChat.mockImplementation(
    (_body: unknown, handlers: { onDelta: (delta: string) => void }) => {
      onDelta = handlers.onDelta;
      return answer.promise;
    },
  );
  const { result } = renderHook(() => useChat("id"), { wrapper: wrapperFor(client) });
  return {
    client,
    result,
    transcript,
    answer,
    send: (text = "Siapa Nabi Muhammad?") => act(() => result.current.send(text)),
    delta: (text = "Jawaban ") => act(() => onDelta(text)),
  };
}

/** Start a transcript request while the turn is streaming (a reconnect refetch). */
function refetchMidTurn(chat: ReturnType<typeof setupChat>): void {
  act(() => {
    void chat.client.refetchQueries({ queryKey: TRANSCRIPT_KEY });
  });
}

describe("useChat — transcript vs. in-flight turn", () => {
  beforeEach(() => {
    let n = 0;
    vi.stubGlobal("crypto", { randomUUID: () => `id-${++n}` });
    mocks.loadStoredSessionId.mockReturnValue("sess-1");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("a transcript resolving mid-turn never replaces the streaming turn", async () => {
    const chat = setupChat();

    // The rehydration fetch is still in flight when the user sends.
    chat.send();
    expect(chat.result.current.busy).toBe(true);
    expect(chat.result.current.messages.map((m) => m.role)).toEqual(["user", "assistant"]);

    // The answer starts streaming, then the transcript query resolves with
    // the pre-send history (it cannot contain the in-flight turn).
    chat.delta();
    act(() => chat.transcript.resolve(OLD_TRANSCRIPT));
    // Wait until the result has been observed while the turn is streaming:
    // the hook's discard — not the assertion's timing — is what must keep the
    // optimistic turns.
    await waitFor(() => expect(chat.result.current.loadingTranscript).toBe(false));

    // Without the guard, this is where the optimistic turns vanish and
    // the subsequent deltas become no-ops on the removed assistant id.
    expect(chat.result.current.messages).toHaveLength(2);
    expect(chat.result.current.messages[0]).toMatchObject({
      role: "user",
      content: "Siapa Nabi Muhammad?",
    });
    expect(chat.result.current.messages[1]).toMatchObject({
      role: "assistant",
      content: "Jawaban ",
    });

    // The turn completes: the discarded transcript must not apply late either.
    act(() => chat.answer.resolve());
    await waitFor(() => expect(chat.result.current.busy).toBe(false));
    expect(chat.result.current.messages).toHaveLength(2);
    expect(chat.result.current.messages[1]).toMatchObject({ content: "Jawaban " });
  });

  it("a transcript fetched before the turn never replaces it when it resolves after the turn", async () => {
    const chat = setupChat();

    // The rehydration fetch is still in flight when the user sends, and the
    // turn completes before the pre-send transcript resolves.
    chat.send();
    chat.delta();
    act(() => chat.answer.resolve());
    await waitFor(() => expect(chat.result.current.busy).toBe(false));

    // Applying that transcript now would hide the completed turn.
    chat.transcript.resolve(OLD_TRANSCRIPT);
    await waitFor(() => expect(chat.result.current.loadingTranscript).toBe(false));

    expect(chat.result.current.messages).toHaveLength(2);
    expect(chat.result.current.messages[0]).toMatchObject({
      role: "user",
      content: "Siapa Nabi Muhammad?",
    });
    expect(chat.result.current.messages[1]).toMatchObject({
      role: "assistant",
      content: "Jawaban ",
    });
  });

  it("a transcript requested mid-turn never replaces the turn when it resolves after the turn", async () => {
    const first = deferred<ChatSessionMessages | null>();
    const chat = setupChat({ initialTranscript: first.promise });
    first.resolve(OLD_TRANSCRIPT);
    await waitFor(() => expect(chat.result.current.messages).toEqual(OLD_MESSAGES));

    // The turn adds its optimistic pair; the transcript refetch starts while
    // the turn is streaming (the reconnect path) and resolves afterwards.
    chat.send();
    chat.delta();
    refetchMidTurn(chat);
    act(() => chat.answer.resolve());
    await waitFor(() => expect(chat.result.current.busy).toBe(false));
    act(() => chat.transcript.resolve(LATE_TRANSCRIPT));
    await waitFor(() => expect(chat.result.current.transcriptTruncated).toBe(true));

    // The refetch was requested before this turn's write completed: applying
    // it would collapse the two completed turns back to the pre-turn pair.
    expect(chat.result.current.messages).toHaveLength(4);
    expect(chat.result.current.messages[2]).toMatchObject({
      role: "user",
      content: "Siapa Nabi Muhammad?",
    });
    expect(chat.result.current.messages[3]).toMatchObject({
      role: "assistant",
      content: "Jawaban ",
    });
  });

  it("a transcript requested mid-turn and resolving mid-turn never replaces the streaming turn", async () => {
    const first = deferred<ChatSessionMessages | null>();
    const chat = setupChat({ initialTranscript: first.promise });
    first.resolve(OLD_TRANSCRIPT);
    await waitFor(() => expect(chat.result.current.messages).toEqual(OLD_MESSAGES));

    chat.send();
    chat.delta();
    refetchMidTurn(chat);
    act(() => chat.transcript.resolve(LATE_TRANSCRIPT));
    await waitFor(() => expect(chat.result.current.transcriptTruncated).toBe(true));

    // No turn has completed since the request began, so only the in-flight
    // guard can keep the streaming pair.
    expect(chat.result.current.busy).toBe(true);
    expect(chat.result.current.messages).toHaveLength(4);
    expect(chat.result.current.messages[3]).toMatchObject({
      role: "assistant",
      content: "Jawaban ",
    });

    act(() => chat.answer.resolve());
    await waitFor(() => expect(chat.result.current.busy).toBe(false));
    expect(chat.result.current.messages).toHaveLength(4);
    expect(chat.result.current.messages[3]).toMatchObject({ content: "Jawaban " });
  });

  it("a pre-turn null transcript resolving after the turn still clears the stored session", async () => {
    const chat = setupChat();
    chat.send();
    chat.delta();
    act(() => chat.answer.resolve());
    await waitFor(() => expect(chat.result.current.busy).toBe(false));

    // A 404 is session invalidation, not stale content: it must clear the dead
    // id even though the snapshot itself is discarded, and keep the turn.
    chat.transcript.resolve(null);
    await waitFor(() => expect(mocks.clearStoredSessionId).toHaveBeenCalledTimes(1));
    expect(chat.result.current.messages).toHaveLength(2);
    expect(chat.result.current.messages[1]).toMatchObject({ content: "Jawaban " });

    // The dead id must not be replayed by a later send.
    chat.send("Pertanyaan kedua");
    const bodies = mocks.askChat.mock.calls.map(([body]) => body as { sessionId: string | null });
    expect(bodies.map((body) => body.sessionId)).toEqual(["sess-1", null]);
  });

  it("a pre-turn null transcript settling with the turn's completion keeps the turn", async () => {
    const chat = setupChat();
    chat.send();
    chat.delta();
    chat.transcript.resolve(null);
    act(() => chat.answer.resolve());
    await waitFor(() => expect(mocks.clearStoredSessionId).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(chat.result.current.busy).toBe(false));

    expect(chat.result.current.messages).toHaveLength(2);
    expect(chat.result.current.messages[1]).toMatchObject({ content: "Jawaban " });
  });

  it("applies the transcript when no turn is in flight (normal rehydration)", async () => {
    mocks.rehydrateSession.mockResolvedValue(OLD_TRANSCRIPT);
    const { result } = renderHook(() => useChat("id"), { wrapper: wrapperFor(makeClient()) });
    await waitFor(() => expect(result.current.messages).toEqual(OLD_MESSAGES));
    expect(result.current.loadingTranscript).toBe(false);
  });

  it("starts clean when the stored session was reclaimed server-side", async () => {
    mocks.rehydrateSession.mockResolvedValue(null);
    const { result } = renderHook(() => useChat("id"), { wrapper: wrapperFor(makeClient()) });
    await waitFor(() => expect(mocks.clearStoredSessionId).toHaveBeenCalled());
    expect(result.current.messages).toEqual([]);
    expect(result.current.loadingTranscript).toBe(false);
  });

  it("surfaces a load error when rehydration fails", async () => {
    mocks.rehydrateSession.mockRejectedValue(new Error("store down"));
    const { result } = renderHook(() => useChat("id"), { wrapper: wrapperFor(makeClient()) });
    await waitFor(() => expect(result.current.error).toBe("load"));
  });
});
