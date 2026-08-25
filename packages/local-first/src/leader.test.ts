import { afterEach, describe, expect, it, vi } from "vitest";
import { createLeaderElection, type LeaderApi } from "./leader";

describe("createLeaderElection", () => {
  let apis: LeaderApi[] = [];

  afterEach(() => {
    for (const api of apis) api.destroy();
    apis = [];
    vi.unstubAllGlobals();
  });

  it("elects itself leader immediately when Web Locks are unavailable", () => {
    vi.stubGlobal("navigator", { locks: undefined });
    const api = createLeaderElection();
    apis.push(api);
    expect(api.isLeader()).toBe(true);
    api.destroy();
    expect(api.isLeader()).toBe(false);
  });

  it("becomes leader via the Web Locks callback and aborts on destroy", () => {
    let acquired: (() => Promise<void>) | undefined;
    const request = vi.fn(
      (_name: string, _opts: { signal: AbortSignal }, cb: () => Promise<void>) => {
        acquired = cb;
        return new Promise<void>(() => {});
      },
    );
    vi.stubGlobal("navigator", { locks: { request } });
    const api = createLeaderElection();
    apis.push(api);

    expect(request).toHaveBeenCalledWith(
      "apt-leader",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      expect.any(Function),
    );
    expect(api.isLeader()).toBe(false);

    void acquired?.();
    expect(api.isLeader()).toBe(true);

    const signal = request.mock.calls[0]?.[1].signal;
    api.destroy();
    expect(signal?.aborted).toBe(true);
    expect(api.isLeader()).toBe(false);
  });

  it("delivers broadcast messages to peers on the channel", async () => {
    vi.stubGlobal("navigator", { locks: undefined });
    const a = createLeaderElection();
    const b = createLeaderElection();
    apis.push(a, b);

    const received = new Promise<unknown>((resolve) => {
      b.onPeerMessage((data) => resolve(data));
    });
    a.broadcast({ type: "state", state: { schemaVersion: 2, notes: [] } });
    expect(await received).toEqual({
      type: "state",
      state: { schemaVersion: 2, notes: [] },
    });
  });

  it("unsubscribes peer listeners", async () => {
    vi.stubGlobal("navigator", { locks: undefined });
    const a = createLeaderElection();
    const b = createLeaderElection();
    apis.push(a, b);

    const fn = vi.fn();
    const unsub = b.onPeerMessage(fn);
    unsub();
    a.broadcast({ type: "state" });
    await new Promise((r) => setTimeout(r, 20));
    expect(fn).not.toHaveBeenCalled();
  });

  it("degrades to no-op messaging without BroadcastChannel", () => {
    vi.stubGlobal("navigator", { locks: undefined });
    vi.stubGlobal("BroadcastChannel", undefined);
    const api = createLeaderElection();
    apis.push(api);

    const unsub = api.onPeerMessage(() => {});
    expect(() => {
      api.broadcast({ type: "state" });
      unsub();
    }).not.toThrow();
  });
});
