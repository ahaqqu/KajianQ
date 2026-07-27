import type { Note } from "@app/shared-zod";
import {
  CLIENT_VERSION,
  SCHEMA_VERSION,
  aliveNotes,
  mergeNotes,
  type NoteRow,
} from "@app/sync-protocol";
import { migrateToLatest } from "./migrations";

const DB_NAME = "apt-notes";
const STORE = "snapshot";

export type NotesState = {
  schemaVersion: number;
  notes: NoteRow[];
};

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
  return aliveNotes(state.notes).map((n) => ({
    id: n.id,
    title: n.title,
    body: n.body,
    updatedAt: n.updatedAt,
    deleted: Boolean(n.deleted),
  }));
}

export async function upsertNote(
  state: NotesState,
  note: NoteRow,
): Promise<NotesState> {
  const next: NotesState = {
    schemaVersion: SCHEMA_VERSION,
    notes: mergeNotes(state.notes, [note]),
  };
  await saveState(next);
  return next;
}

export async function removeNote(
  state: NotesState,
  id: string,
): Promise<NotesState> {
  const prev = state.notes.find((n) => n.id === id);
  const del: NoteRow = {
    id,
    title: prev?.title ?? "",
    body: prev?.body ?? "",
    updatedAt: Date.now(),
    deleted: true,
  };
  return upsertNote(state, del);
}

export async function pushPull(
  state: NotesState,
  token: string,
): Promise<NotesState> {
  const res = await fetch("/v1/sync", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      clientVersion: CLIENT_VERSION,
      notes: state.notes.map((n) => ({
        id: n.id,
        title: n.title,
        body: n.body,
        updatedAt: n.updatedAt,
        deleted: Boolean(n.deleted),
      })),
    }),
  });
  if (res.status === 409) throw new Error("schema_mismatch");
  if (!res.ok) throw new Error(`sync_${res.status}`);
  const body = (await res.json()) as { notes: Note[] };
  const serverRows: NoteRow[] = body.notes.map((n) => ({
    id: n.id,
    title: n.title,
    body: n.body,
    updatedAt: n.updatedAt,
    deleted: n.deleted,
  }));
  const next: NotesState = {
    schemaVersion: SCHEMA_VERSION,
    notes: mergeNotes(state.notes, serverRows),
  };
  await saveState(next);
  return next;
}
