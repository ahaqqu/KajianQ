import { SyncResponseSchema, type Note } from "@app/contracts";
import {
  CLIENT_VERSION,
  SCHEMA_VERSION,
  aliveNotes,
  gcTombstones,
  mergeNotes,
  noteToRow,
  raiseClockFloor,
  rowToNote,
  stampNow,
  toTombstone,
  type NoteRow,
} from "@app/local-first";
import { migrateToLatest, type NotesState } from "@app/local-first/client";
import * as v from "valibot";
import { apiFetch } from "./api";

export type { NotesState };

const DB_NAME = "apt-notes";
const STORE = "snapshot";

async function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadState(): Promise<NotesState> {
  const db = await idb();
  const raw = await new Promise<NotesState | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const g = tx.objectStore(STORE).get("main");
    g.onsuccess = () => resolve(g.result as NotesState | undefined);
    g.onerror = () => reject(g.error);
  });
  db.close();
  const base = raw ?? { schemaVersion: SCHEMA_VERSION, notes: [] };
  return migrateToLatest(base);
}

export async function saveState(state: NotesState): Promise<void> {
  const db = await idb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(state, "main");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export function listAlive(state: NotesState): Note[] {
  return aliveNotes(state.notes).map(rowToNote);
}

export async function upsertNote(
  state: NotesState,
  note: NoteRow,
): Promise<NotesState> {
  const stamped: NoteRow = {
    ...note,
    updatedAt: stampNow(state.clockFloor, note.updatedAt),
  };
  const next: NotesState = {
    schemaVersion: SCHEMA_VERSION,
    notes: mergeNotes(state.notes, [stamped]),
    clockFloor: state.clockFloor,
  };
  await saveState(next);
  return next;
}

export async function removeNote(
  state: NotesState,
  id: string,
): Promise<NotesState> {
  return upsertNote(state, toTombstone(id, stampNow(state.clockFloor)));
}

export async function pushPull(
  state: NotesState,
  token: string,
): Promise<NotesState> {
  const res = await apiFetch("/sync", {
    method: "POST",
    token,
    body: JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      clientVersion: CLIENT_VERSION,
      notes: state.notes.map(rowToNote),
    }),
  });
  if (res.status === 409) throw new Error("schema_mismatch");
  if (!res.ok) throw new Error(`sync_${res.status}`);
  const body = v.parse(SyncResponseSchema, await res.json());
  const next: NotesState = {
    schemaVersion: SCHEMA_VERSION,
    notes: gcTombstones(mergeNotes(state.notes, body.notes.map(noteToRow))),
    clockFloor: raiseClockFloor(state.clockFloor, body.serverNow),
  };
  await saveState(next);
  return next;
}
