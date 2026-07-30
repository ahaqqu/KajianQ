const CHANNEL = "apt-sync-leader";
const LOCK = "apt-leader";

export type LeaderApi = {
  isLeader: () => boolean;
  onPeerMessage: (fn: (data: unknown) => void) => () => void;
  broadcast: (data: unknown) => void;
  destroy: () => void;
};

/** Single-tab leader via Web Locks + BroadcastChannel for peers. */
export function createLeaderElection(): LeaderApi {
  let leader = false;
  const bc =
    typeof BroadcastChannel !== "undefined"
      ? new BroadcastChannel(CHANNEL)
      : null;
  let abort: AbortController | null = null;

  if (typeof navigator !== "undefined" && navigator.locks) {
    abort = new AbortController();
    void navigator.locks.request(
      LOCK,
      { signal: abort.signal },
      async () => {
        leader = true;
        await new Promise<void>(() => {
          /* hold until abort */
        });
      },
    );
  } else {
    leader = true;
  }

  return {
    isLeader: () => leader,
    onPeerMessage(fn) {
      if (!bc) return () => {};
      const handler = (ev: MessageEvent) => fn(ev.data);
      bc.addEventListener("message", handler);
      return () => bc.removeEventListener("message", handler);
    },
    broadcast(data) {
      bc?.postMessage(data);
    },
    destroy() {
      abort?.abort();
      bc?.close();
      leader = false;
    },
  };
}
