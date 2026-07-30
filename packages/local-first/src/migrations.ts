import type { NoteRow } from "./merge";

/**
 * Client store snapshot, persisted whole in IndexedDB. `clockFloor` is the
 * server-bias floor for future `updatedAt` stamps (see clock.ts); absent on
 * snapshots written before clock discipline existed.
 */
export type NotesState = {
  schemaVersion: number;
  notes: NoteRow[];
  clockFloor?: number | undefined;
};

/** v1 greetings-only → v2 notes store */
export function migrateV1ToV2(snap: NotesState): NotesState {
  if (snap.schemaVersion >= 2) return snap;
  return { schemaVersion: 2, notes: snap.notes };
}

export function migrateToLatest(snap: NotesState): NotesState {
  let cur = snap;
  if (cur.schemaVersion < 2) cur = migrateV1ToV2(cur);
  return cur;
}

export function migrateDownV2ToV1(snap: NotesState): NotesState {
  return { schemaVersion: 1, notes: snap.notes };
}
