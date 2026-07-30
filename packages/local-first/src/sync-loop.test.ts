import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotesState } from "./migrations";
import { startSyncLoop, type SyncLoopDeps, type SyncStatus } from "./sync-loop";

const stateA: NotesState = {
  schemaVersion: 2,
  notes: [{ id: "a", title: "t", body: "b", updatedAt: 1 }],
};
const stateB: NotesState = { schemaVersion: 2, notes: [], clockFloor: 42 };

function makeDeps(overrides: Partial<SyncLoopDeps> = {}): SyncLoopDeps {
  return {
    loadState: vi.fn().mockResolvedValue(stateA),
    pushPull: vi.fn().mockResolvedValue(stateB),
    loadSession: vi.fn().mockReturnValue({ token: "tok" }),
    ...overrides,
  };
}

describe("startSyncLoop", () => {
  let stops: Array<() => void> = [];
  const start = (
    deps: SyncLoopDeps,
    onState: (s: NotesState) => void,
    onStatus: (s: SyncStatus) => void,
  ) => {
    const stop = startSyncLoop(deps, onState, onStatus);
    stops.push(stop);
    return stop;
  };

  beforeEach(() => {
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("navigator", { onLine: true, locks: undefined });
  });

  afterEach(() => {
    for (const stop of stops) stop();
    stops = [];
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("syncs immediately and reports state + status", async () => {
    const deps = makeDeps();
    const onState = vi.fn();
    const onStatus = vi.fn();
    start(deps, onState, onStatus);

    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith("synced"));
    expect(deps.pushPull).toHaveBeenCalledWith(stateA, "tok");
    expect(onState).toHaveBeenCalledWith(stateB);
    expect(onStatus).toHaveBeenCalledWith("syncing");
  });

  it("reports offline and does not hit the network", async () => {
    vi.stubGlobal("navigator", { onLine: false, locks: undefined });
    const deps = makeDeps();
    const onStatus = vi.fn();
    start(deps, vi.fn(), onStatus);

    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith("offline"));
    expect(deps.loadSession).not.toHaveBeenCalled();
    expect(deps.pushPull).not.toHaveBeenCalled();
  });

  it("does nothing without a session", async () => {
    const deps = makeDeps({ loadSession: vi.fn().mockReturnValue(null) });
    const onStatus = vi.fn();
    start(deps, vi.fn(), onStatus);

    await new Promise((r) => setTimeout(r, 20));
    expect(deps.pushPull).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalledWith("syncing");
  });

  it("stays idle when this tab is not the leader", async () => {
    vi.stubGlobal("navigator", {
      onLine: true,
      locks: { request: vi.fn().mockReturnValue(new Promise(() => {})) },
    });
    const deps = makeDeps();
    start(deps, vi.fn(), vi.fn());

    await new Promise((r) => setTimeout(r, 20));
    expect(deps.loadSession).not.toHaveBeenCalled();
  });

  it("retries with backoff after a failure, then recovers", async () => {
    vi.useFakeTimers();
    const deps = makeDeps({
      pushPull: vi
        .fn()
        .mockRejectedValueOnce(new Error("sync_500"))
        .mockResolvedValue(stateB),
    });
    const onState = vi.fn();
    const onStatus = vi.fn();
    start(deps, onState, onStatus);

    await vi.advanceTimersByTimeAsync(0);
    expect(onStatus).toHaveBeenCalledWith("error");
    expect(onState).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(onState).toHaveBeenCalledWith(stateB);
    expect(onStatus).toHaveBeenCalledWith("synced");
  });

  it("applies state broadcast by the leader peer", async () => {
    const deps = makeDeps();
    const onState = vi.fn();
    start(deps, onState, vi.fn());
    await vi.waitFor(() => expect(onState).toHaveBeenCalledWith(stateB));

    const peerState: NotesState = {
      schemaVersion: 2,
      notes: [{ id: "p", title: "peer", body: "", updatedAt: 9 }],
    };
    const sender = new BroadcastChannel("apt-sync-leader");
    sender.postMessage({ type: "state", state: peerState });
    await vi.waitFor(() => expect(onState).toHaveBeenCalledWith(peerState));

    onState.mockClear();
    sender.postMessage({ type: "state" });
    sender.postMessage({ type: "other", state: peerState });
    await new Promise((r) => setTimeout(r, 20));
    expect(onState).not.toHaveBeenCalled();
    sender.close();
  });

  it("syncs again on online and focus events", async () => {
    const deps = makeDeps();
    start(deps, vi.fn(), vi.fn());
    await vi.waitFor(() => expect(deps.pushPull).toHaveBeenCalledTimes(1));

    const handlers = new Map<string, () => void>();
    for (const call of (window.addEventListener as ReturnType<typeof vi.fn>).mock
      .calls) {
      handlers.set(call[0] as string, call[1] as () => void);
    }
    handlers.get("online")?.();
    await vi.waitFor(() => expect(deps.pushPull).toHaveBeenCalledTimes(2));
    handlers.get("focus")?.();
    await vi.waitFor(() => expect(deps.pushPull).toHaveBeenCalledTimes(3));
  });

  it("stops cleanly: listeners removed, no further syncs", async () => {
    const pushPull = vi.fn().mockResolvedValue(stateB);
    const deps = makeDeps({ pushPull });
    const stop = start(deps, vi.fn(), vi.fn());
    await vi.waitFor(() => expect(pushPull).toHaveBeenCalled());

    stop();
    expect(window.removeEventListener).toHaveBeenCalledWith(
      "online",
      expect.any(Function),
    );
    expect(window.removeEventListener).toHaveBeenCalledWith(
      "focus",
      expect.any(Function),
    );

    vi.useFakeTimers();
    const calls = pushPull.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(pushPull.mock.calls.length).toBe(calls);
  });
});
