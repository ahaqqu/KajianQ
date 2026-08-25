import { createLeaderElection } from "./leader";
import type { NotesState } from "./migrations";

export type SyncStatus = "idle" | "syncing" | "synced" | "offline" | "error";

/** Store/session seams injected by the app so the loop stays app-agnostic. */
export type SyncLoopDeps = {
  loadState: () => Promise<NotesState>;
  pushPull: (state: NotesState, token: string) => Promise<NotesState>;
  loadSession: () => { token: string } | null;
};

export function startSyncLoop(
  deps: SyncLoopDeps,
  onState: (s: NotesState) => void,
  onStatus: (s: SyncStatus) => void,
): () => void {
  const leader = createLeaderElection();
  let stopped = false;
  let attempt = 0;

  const run = async () => {
    if (stopped || !leader.isLeader()) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      onStatus("offline");
      return;
    }
    const session = deps.loadSession();
    if (!session) return;
    onStatus("syncing");
    try {
      const state = await deps.loadState();
      const next = await deps.pushPull(state, session.token);
      onState(next);
      leader.broadcast({ type: "state", state: next });
      onStatus("synced");
      attempt = 0;
    } catch {
      attempt += 1;
      onStatus("error");
      const delay = Math.min(30_000, 500 * 2 ** attempt);
      setTimeout(() => void run(), delay);
    }
  };

  const unsub = leader.onPeerMessage((data) => {
    const msg = data as { type?: string; state?: NotesState };
    if (msg.type === "state" && msg.state) onState(msg.state);
  });

  const onOnline = () => void run();
  const onFocus = () => void run();
  window.addEventListener("online", onOnline);
  window.addEventListener("focus", onFocus);
  void run();
  const interval = setInterval(() => void run(), 60_000);

  return () => {
    stopped = true;
    unsub();
    leader.destroy();
    window.removeEventListener("online", onOnline);
    window.removeEventListener("focus", onFocus);
    clearInterval(interval);
  };
}
