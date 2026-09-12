// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSessionMessages } from "@app/contracts";
import { useChat } from "./use-chat";

// React 19 + vitest: mark the environment for act() (renderHook's flushes).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The rehydration/streaming boundary (thermo-review A1, #11): a transcript
 * result that resolves while a turn is in flight must never clobber the
 * optimistic turns — they are the live answer's only body, and the stream's
 * patches key on their ids. The guard lives in the hook's effect: a mid-turn
 * transcript result is discarded, never deferred past the turn (it was
 * fetched before the turn's write, so applying it late would hide the
 * completed turn instead).
 */

const mocks = vi.hoisted(() => ({
  loadStoredSessionId: vi.fn<() => string | null>(),
  clearStoredSessionId: vi.fn(),
  rehydrateSession: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  askChat: vi.fn<(body: unknown, handlers: { onDelta: (delta: string) => void }) => Promise<void>>(),
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

/** Fresh QueryClient per test: no cross-test cache leakage. */
function makeWrapper(): (props: { children: ReactNode }) => ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }) => createElement(QueryClientProvider, { client }, children);
}

/** Flush a full scheduler turn: React Query notifies on a macrotask, so an
 * empty async act (microtasks only) does not deliver its state updates. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
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

  it("a transcript resolving mid-turn never clobbers the streaming turn (thermo-review A1)", async () => {
    const transcript = deferred<ChatSessionMessages>();
    mocks.rehydrateSession.mockReturnValue(transcript.promise);
    const answer = deferred<void>();
    let onDelta: (delta: string) => void = () => {};
    mocks.askChat.mockImplementation(
      (_body: unknown, handlers: { onDelta: (delta: string) => void }) => {
        onDelta = handlers.onDelta;
        return answer.promise;
      },
    );

    const { result } = renderHook(() => useChat("id"), { wrapper: makeWrapper() });

    // The rehydration fetch is still in flight when the user sends.
    act(() => result.current.send("Siapa Nabi Muhammad?"));
    expect(result.current.busy).toBe(true);
    expect(result.current.messages.map((m) => m.role)).toEqual(["user", "assistant"]);

    // The answer starts streaming, then the transcript query resolves with
    // the pre-send history (it cannot contain the in-flight turn).
    act(() => onDelta("Jawaban "));
    act(() => transcript.resolve(OLD_TRANSCRIPT));
    await flush();

    // Without the busy guard, this is where the optimistic turns vanish and
    // the subsequent deltas become no-ops on the removed assistant id.
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0]).toMatchObject({
      role: "user",
      content: "Siapa Nabi Muhammad?",
    });
    expect(result.current.messages[1]).toMatchObject({ role: "assistant", content: "Jawaban " });

    // The turn completes: the discarded transcript must not apply late either.
    act(() => answer.resolve());
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[1]).toMatchObject({ content: "Jawaban " });
  });

  it("applies the transcript when no turn is in flight (normal rehydration)", async () => {
    mocks.rehydrateSession.mockResolvedValue(OLD_TRANSCRIPT);
    const { result } = renderHook(() => useChat("id"), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.messages).toEqual(OLD_MESSAGES));
    expect(result.current.loadingTranscript).toBe(false);
  });

  it("starts clean when the stored session was reclaimed server-side", async () => {
    mocks.rehydrateSession.mockResolvedValue(null);
    const { result } = renderHook(() => useChat("id"), { wrapper: makeWrapper() });
    await waitFor(() => expect(mocks.clearStoredSessionId).toHaveBeenCalled());
    expect(result.current.messages).toEqual([]);
    expect(result.current.loadingTranscript).toBe(false);
  });

  it("surfaces a load error when rehydration fails", async () => {
    mocks.rehydrateSession.mockRejectedValue(new Error("store down"));
    const { result } = renderHook(() => useChat("id"), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.error).toBe("load"));
  });
});
