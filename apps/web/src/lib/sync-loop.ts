import { createLeaderElection } from "./leader";
import {
  loadState,
  pushPull,
  type NotesState,
} from "./notes-store";
import { loadSession } from "./session";

export type SyncStatus = "idle" | "syncing" | "synced" | "offline" | "error";

export function startSyncLoop(
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
    const session = loadSession();
    if (!session) return;
    onStatus("syncing");
    try {
      const state = await loadState();
      const next = await pushPull(state, session.token);
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
