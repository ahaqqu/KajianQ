import { useEffect, useState } from "react";
import { SCHEMA_VERSION } from "@app/local-first";
import { startSyncLoop, type SyncStatus } from "@app/local-first/client";
import {
  listAlive,
  loadState,
  pushPull,
  removeNote,
  upsertNote,
  type NotesState,
} from "../lib/notes-store";
import { deleteSession, ensureSession, loadSession } from "../lib/session";

/**
 * NotesPage controller: owns notes state, sync-loop wiring, and actions.
 * UI wiring — exercised end-to-end by the notes Playwright-BDD suite.
 */
export function useNotes() {
  const [state, setState] = useState<NotesState>({
    schemaVersion: SCHEMA_VERSION,
    notes: [],
  });
  const [status, setStatus] = useState<SyncStatus>("idle");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let stop = () => {};
    void (async () => {
      try {
        await ensureSession();
      } catch {
        setStatus("offline");
      }
      const s = await loadState();
      setState(s);
      setReady(true);
      stop = startSyncLoop(
        { loadState, pushPull, loadSession },
        setState,
        setStatus,
      );
    })();
    return () => stop();
  }, []);

  const add = async (title: string, body: string) => {
    const next = await upsertNote(state, {
      id: crypto.randomUUID(),
      title,
      body,
      updatedAt: Date.now(),
    });
    setState(next);
  };

  const del = async (id: string) => {
    setState(await removeNote(state, id));
  };

  const wipe = async () => {
    if (await deleteSession()) {
      setState({ schemaVersion: SCHEMA_VERSION, notes: [] });
    }
  };

  return { ready, notes: listAlive(state), status, add, del, wipe };
}
