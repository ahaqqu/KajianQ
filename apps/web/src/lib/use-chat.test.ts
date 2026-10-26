// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ChatSessionMessages } from "@app/contracts";
import { useChat } from "./use-chat";
import { MessageCard } from "../components/chat/MessageCard";

// React 19 + vitest: mark the environment for act() (renderHook's flushes).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The rehydration/streaming boundary: a transcript result that lands after a
 * turn began must never clobber the optimistic turns — they are the live
 * answer's only body, and the stream's patches key on their ids. The hook
 * discards a snapshot fetched before the current turn completed and any
 * snapshot that arrives while a turn is in flight; neither is deferred past
 * the turn, and the completed turn is never hidden by a pre-turn transcript.
 *
 * The same rule has to hold across a route remount: the transcript query cache
 * is a module singleton that outlives the page, so a mount after a completed
 * turn must fetch its own transcript instead of applying the pre-turn snapshot
 * the cache still holds.
 */

type ChatMeta = { sessionId: string; messageId: string };

const mocks = vi.hoisted(() => ({
  loadStoredSessionId: vi.fn<() => string | null>(),
  clearStoredSessionId: vi.fn(),
  saveStoredSessionId: vi.fn(),
  archiveChatFromMessages: vi.fn(),
  markChatSessionExpired: vi.fn(),
  rehydrateSession: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  askChat: vi.fn<
    (
      body: unknown,
      handlers: {
        onMeta?: (meta: { sessionId: string; messageId: string }) => void;
        onDelta: (delta: string) => void;
      },
    ) => Promise<void>
  >(),
  sendFeedback: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock("./chat-store", () => ({
  OPEN_SESSION_EVENT: "kajianq:open-session",
  loadStoredSessionId: mocks.loadStoredSessionId,
  clearStoredSessionId: mocks.clearStoredSessionId,
  saveStoredSessionId: mocks.saveStoredSessionId,
  archiveChatFromMessages: mocks.archiveChatFromMessages,
  markChatSessionExpired: mocks.markChatSessionExpired,
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
vi.mock("./feedback", () => ({ sendFeedback: mocks.sendFeedback }));

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
/**
 * What the rehydration endpoint serves once the turn is persisted: the old pair
 * plus the turn, with the server's ids and the settled answer text (which the
 * live stream has not produced — it streams `Jawaban `).
 */
const TURN_TRANSCRIPT: ChatSessionMessages = {
  sessionId: "sess-1",
  truncated: false,
  messages: [
    ...OLD_MESSAGES,
    { id: "m2", role: "user", content: "Siapa Nabi Muhammad?", createdAt: 3 },
    { id: "m3", role: "assistant", content: "Jawaban lengkap", createdAt: 4 },
  ],
};

/** The anonymous session's transcript after its first turn. */
const ANON_FIRST_TURN: ChatSessionMessages = {
  sessionId: "sess-anon",
  truncated: false,
  messages: [
    { id: "a0", role: "user", content: "Siapa Nabi Muhammad?", createdAt: 1 },
    { id: "a1", role: "assistant", content: "Jawaban pertama", createdAt: 2 },
  ],
};
/** The same session's transcript after the second turn (same mount as its first). */
const ANON_SECOND_TURN: ChatSessionMessages = {
  ...ANON_FIRST_TURN,
  messages: [
    ...ANON_FIRST_TURN.messages,
    { id: "a2", role: "user", content: "Pertanyaan kedua", createdAt: 3 },
    { id: "a3", role: "assistant", content: "Jawaban kedua", createdAt: 4 },
  ],
};

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
  let onMeta: (meta: ChatMeta) => void = () => {};
  mocks.askChat.mockImplementation(
    (
      _body: unknown,
      handlers: { onMeta?: (meta: ChatMeta) => void; onDelta: (delta: string) => void },
    ) => {
      onDelta = handlers.onDelta;
      if (handlers.onMeta) onMeta = handlers.onMeta;
      return answer.promise;
    },
  );
  const { result, unmount } = renderHook(() => useChat("id"), { wrapper: wrapperFor(client) });
  return {
    client,
    result,
    unmount,
    transcript,
    answer,
    send: (text = "Siapa Nabi Muhammad?") => act(() => result.current.send(text)),
    delta: (text = "Jawaban ") => act(() => onDelta(text)),
    /** The stream's `meta` frame: the session the server minted or confirmed. */
    meta: (sessionId: string, messageId = "live-message") =>
      act(() => onMeta({ sessionId, messageId })),
  };
}

/** Mount one instance of the hook on a client (a route mount or remount). */
function mountChat(client: QueryClient) {
  return renderHook(() => useChat("id"), { wrapper: wrapperFor(client) });
}

/** Start a transcript request while the turn is streaming (a reconnect refetch). */
function refetchMidTurn(chat: ReturnType<typeof setupChat>): void {
  act(() => {
    void chat.client.refetchQueries({ queryKey: TRANSCRIPT_KEY });
  });
}

/**
 * A chat surface wired to the real components: the hook's turns rendered as
 * `MessageCard`s with the same persisted-id gate the page applies, plus a
 * button that starts a turn so a test can drive the pre-`meta` window.
 */
function ChatAffordances() {
  const chat = useChat("id");
  return createElement(
    "div",
    null,
    createElement(
      "button",
      {
        type: "button",
        "data-testid": "probe-send",
        onClick: () => chat.send("Siapa Nabi Muhammad?"),
      },
      "send",
    ),
    chat.messages.map((message) =>
      createElement(MessageCard, {
        key: message.id,
        message,
        persisted: chat.persistedMessageIds.has(message.id),
      }),
    ),
  );
}

describe("useChat — transcript vs. the live turn and the route", () => {
  beforeEach(() => {
    let n = 0;
    vi.stubGlobal("crypto", { randomUUID: () => `id-${++n}` });
    mocks.loadStoredSessionId.mockReturnValue("sess-1");
  });
  afterEach(() => {
    cleanup();
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

  it("re-keys the live answer to the streamed message id, so feedback names the persisted row", async () => {
    const chat = setupChat();

    chat.send();
    const userId = chat.result.current.messages[0]?.id;
    const placeholderId = chat.result.current.messages[1]?.id;
    // The optimistic answer's id is a client-local placeholder: it names no row.
    expect(placeholderId).toBeDefined();
    expect(chat.result.current.persistedMessageIds.has(placeholderId!)).toBe(false);
    // The first frame names the persisted answer, before any delta arrives.
    chat.meta("sess-1", "m-server-1");
    chat.delta("Jawaban ");
    act(() => chat.answer.resolve());
    await waitFor(() => expect(chat.result.current.busy).toBe(false));

    // The assistant turn carries the id the stream named — the id rehydration
    // returns — and later patches land on it; the user turn keeps its local key.
    expect(chat.result.current.messages[1]).toMatchObject({
      id: "m-server-1",
      role: "assistant",
      content: "Jawaban ",
    });
    expect(chat.result.current.messages[0]?.id).toBe(userId);
    // From `meta` on, that id is a persisted row the feedback may address.
    expect(chat.result.current.persistedMessageIds.has("m-server-1")).toBe(true);
    expect(chat.result.current.persistedMessageIds.has(placeholderId!)).toBe(false);
  });

  it("withholds feedback until meta names the row, then posts the streamed id", async () => {
    const answer = deferred<void>();
    let onMeta: (meta: ChatMeta) => void = () => {};
    mocks.askChat.mockImplementation(
      (_body: unknown, handlers: { onMeta?: (meta: ChatMeta) => void }) => {
        onMeta = handlers.onMeta ?? (() => {});
        return answer.promise;
      },
    );
    // The transcript query never resolves; the live turn is the only content.
    mocks.rehydrateSession.mockReturnValue(new Promise(() => {}));
    mocks.sendFeedback.mockResolvedValue({
      id: "fb1",
      messageId: "live-row-9",
      rating: "up",
      anchor: null,
      status: "pending",
    });

    const view = render(
      createElement(QueryClientProvider, { client: makeClient() }, createElement(ChatAffordances)),
    );
    fireEvent.click(screen.getByTestId("probe-send"));

    // Before `meta` the answer is addressed by its client-local placeholder,
    // which names no row: the affordance is not rendered and nothing is posted.
    expect(screen.queryByTestId("feedback-up")).toBeNull();
    expect(mocks.sendFeedback).not.toHaveBeenCalled();

    act(() => onMeta({ sessionId: "sess-1", messageId: "live-row-9" }));

    // After `meta`, the affordance appears and the click posts the streamed id.
    fireEvent.click(screen.getByTestId("feedback-up"));
    await waitFor(() =>
      expect(mocks.sendFeedback).toHaveBeenCalledWith("live-row-9", { rating: "up" }),
    );
    act(() => answer.resolve());
    view.unmount();
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

  it("a route remount shows the completed turn, not the cached pre-turn transcript", async () => {
    const first = deferred<ChatSessionMessages | null>();
    const chat = setupChat({ initialTranscript: first.promise });
    first.resolve(OLD_TRANSCRIPT);
    await waitFor(() => expect(chat.result.current.messages).toEqual(OLD_MESSAGES));

    // One completed turn: its pair lives in this instance until the endpoint
    // serves it, and the mount-time snapshot in the cache is now pre-turn.
    chat.send();
    chat.delta();
    act(() => chat.answer.resolve());
    await waitFor(() => expect(chat.result.current.busy).toBe(false));
    expect(chat.result.current.messages).toHaveLength(4);
    chat.unmount();

    // Navigating back mounts a fresh instance on the same (shared) client,
    // whose cache still holds the snapshot fetched before the turn.
    mocks.rehydrateSession.mockResolvedValue(TURN_TRANSCRIPT);
    const remount = mountChat(chat.client);
    // That snapshot is not this mount's transcript: it must not be applied, not
    // even for the render before this mount's own response lands.
    expect(remount.result.current.messages).toEqual([]);
    expect(remount.result.current.loadingTranscript).toBe(true);

    await waitFor(() => expect(remount.result.current.messages).toHaveLength(4));
    expect(remount.result.current.messages[3]).toMatchObject({
      role: "assistant",
      content: "Jawaban lengkap",
    });
    expect(remount.result.current.loadingTranscript).toBe(false);
  });

  it("a failed remount fetch shows a load error instead of the cached pre-turn transcript", async () => {
    const first = deferred<ChatSessionMessages | null>();
    const chat = setupChat({ initialTranscript: first.promise });
    first.resolve(OLD_TRANSCRIPT);
    await waitFor(() => expect(chat.result.current.messages).toEqual(OLD_MESSAGES));
    chat.send();
    chat.delta();
    act(() => chat.answer.resolve());
    await waitFor(() => expect(chat.result.current.busy).toBe(false));
    chat.unmount();

    // The cache's pre-turn snapshot is not a fallback: it would hide the
    // completed turn, so a failed load reports its error instead.
    mocks.rehydrateSession.mockRejectedValue(new Error("store down"));
    const remount = mountChat(chat.client);
    await waitFor(() => expect(remount.result.current.error).toBe("load"));
    expect(remount.result.current.messages).toEqual([]);
    expect(remount.result.current.loadingTranscript).toBe(false);
  });

  it("an anonymous session shows the completed turn across route remounts", async () => {
    // A first visit stores no session: the id is minted by the turn's `meta`
    // frame and persisted by the client once the stream settles.
    let stored: string | null = null;
    mocks.loadStoredSessionId.mockImplementation(() => stored);
    mocks.clearStoredSessionId.mockImplementation(() => {
      stored = null;
    });

    const visit = setupChat();
    expect(mocks.rehydrateSession).not.toHaveBeenCalled();
    visit.send();
    visit.delta();
    visit.meta("sess-anon");
    stored = "sess-anon";
    act(() => visit.answer.resolve());
    await waitFor(() => expect(visit.result.current.busy).toBe(false));
    expect(visit.result.current.messages).toHaveLength(2);
    visit.unmount();

    // Back on the chat: the stored id enables rehydration, which serves the turn.
    mocks.rehydrateSession.mockResolvedValue(ANON_FIRST_TURN);
    const firstMount = mountChat(visit.client);
    await waitFor(() => expect(firstMount.result.current.messages).toHaveLength(2));

    // A second turn in this mount, then away and back again: the cache now
    // holds the snapshot fetched before that turn.
    const secondAnswer = deferred<void>();
    let secondDelta: (delta: string) => void = () => {};
    mocks.askChat.mockImplementation(
      (
        _body: unknown,
        handlers: { onMeta?: (meta: ChatMeta) => void; onDelta: (delta: string) => void },
      ) => {
        secondDelta = handlers.onDelta;
        return secondAnswer.promise;
      },
    );
    act(() => firstMount.result.current.send("Pertanyaan kedua"));
    act(() => secondDelta("Jawaban "));
    act(() => secondAnswer.resolve());
    await waitFor(() => expect(firstMount.result.current.busy).toBe(false));
    expect(firstMount.result.current.messages).toHaveLength(4);
    firstMount.unmount();

    mocks.rehydrateSession.mockResolvedValue(ANON_SECOND_TURN);
    const secondMount = mountChat(visit.client);
    expect(secondMount.result.current.messages).toEqual([]);
    await waitFor(() => expect(secondMount.result.current.messages).toHaveLength(4));
    expect(secondMount.result.current.messages[3]).toMatchObject({
      role: "assistant",
      content: "Jawaban kedua",
    });
  });

  it("a mount makes one transcript request and a remount makes exactly one more", async () => {
    const client = makeClient();
    mocks.rehydrateSession.mockResolvedValue(OLD_TRANSCRIPT);
    const first = mountChat(client);
    await waitFor(() => expect(first.result.current.messages).toEqual(OLD_MESSAGES));
    expect(mocks.rehydrateSession).toHaveBeenCalledTimes(1);
    first.unmount();

    const second = mountChat(client);
    await waitFor(() => expect(second.result.current.messages).toEqual(OLD_MESSAGES));
    expect(mocks.rehydrateSession).toHaveBeenCalledTimes(2);

    // Settled: the ownership rule does not refetch against its own snapshot.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    expect(mocks.rehydrateSession).toHaveBeenCalledTimes(2);
  });

  it("a second live mount cannot turn the ownership rule into a request loop", async () => {
    // Two live mounts are a precondition violation (the route mounts one page),
    // so the cap on each mount's recovery request is what keeps them from
    // hammering the endpoint: a macrotask-resolved transcript lets a loop run
    // far enough to be observed if that boundary ever disappears.
    const client = makeClient();
    let requests = 0;
    mocks.rehydrateSession.mockImplementation(() => {
      requests += 1;
      return new Promise((resolve) => setTimeout(() => resolve(OLD_TRANSCRIPT), 0));
    });
    mountChat(client);
    mountChat(client);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    const settled = requests;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(requests).toBe(settled);
    expect(requests).toBeLessThanOrEqual(3);
  });

  it("a mount after a module re-evaluation gets its own identity and transcript", async () => {
    // What Vite's HMR does to a hook module: the registry is cleared and the
    // module is evaluated again. Identity must not be re-issued by that.
    const client = makeClient();
    mocks.rehydrateSession.mockResolvedValue(OLD_TRANSCRIPT);
    const first = mountChat(client);
    await waitFor(() => expect(first.result.current.messages).toEqual(OLD_MESSAGES));
    const firstId = (
      client.getQueryData(TRANSCRIPT_KEY) as { requestedByMount?: string } | undefined
    )?.requestedByMount;
    expect(firstId).toBeDefined();
    first.unmount();

    vi.resetModules();
    const reEvaluated = await import("./use-chat");
    mocks.rehydrateSession.mockResolvedValue(OLD_TRANSCRIPT);
    const second = renderHook(() => reEvaluated.useChat("id"), { wrapper: wrapperFor(client) });
    // The cached snapshot belongs to the earlier module's mount, so this mount
    // fetches its own instead of adopting it.
    expect(second.result.current.messages).toEqual([]);
    await waitFor(() => expect(second.result.current.messages).toEqual(OLD_MESSAGES));
    const secondId = (
      client.getQueryData(TRANSCRIPT_KEY) as { requestedByMount?: string } | undefined
    )?.requestedByMount;
    expect(secondId).toBeDefined();
    expect(secondId).not.toBe(firstId);
    expect(mocks.rehydrateSession).toHaveBeenCalledTimes(2);
  });
});

describe("useChat — the conversation history", () => {
  it("archives the conversation being left before a new one clears it", async () => {
    mocks.loadStoredSessionId.mockReturnValue("sess-1");
    const chat = setupChat({ initialTranscript: Promise.resolve(OLD_TRANSCRIPT) });
    await waitFor(() => expect(chat.result.current.messages).toHaveLength(2));

    act(() => chat.result.current.newSession());

    expect(mocks.archiveChatFromMessages).toHaveBeenCalledWith({
      id: "sess-1",
      messages: OLD_MESSAGES,
      locale: "id",
    });
    expect(chat.result.current.messages).toEqual([]);
    expect(mocks.clearStoredSessionId).toHaveBeenCalled();
  });

  it("adopts a conversation opened from the drawer without fetching it again", async () => {
    mocks.loadStoredSessionId.mockReturnValue(null);
    const chat = setupChat();
    const opened: ChatSessionMessages = {
      sessionId: "sess-old",
      truncated: false,
      messages: [{ id: "x1", role: "user", content: "Pertanyaan lama", createdAt: 1 }],
    };

    act(() => {
      window.dispatchEvent(
        new CustomEvent("kajianq:open-session", { detail: { id: "sess-old", transcript: opened } }),
      );
    });

    expect(mocks.saveStoredSessionId).toHaveBeenCalledWith("sess-old");
    await waitFor(() =>
      expect(chat.result.current.messages.map((message) => message.id)).toEqual(["x1"]),
    );
    expect(chat.result.current.persistedMessageIds.has("x1")).toBe(true);
    expect(mocks.rehydrateSession).not.toHaveBeenCalled();
  });
});
