import type { NoteRow } from "@app/sync-protocol";

export type ClientSnapshot = {
  schemaVersion: number;
  notes: NoteRow[];
};

/** v1 greetings-only → v2 notes store */
export function migrateV1ToV2(snap: ClientSnapshot): ClientSnapshot {
  if (snap.schemaVersion >= 2) return snap;
  return { schemaVersion: 2, notes: snap.notes ?? [] };
}

export function migrateToLatest(snap: ClientSnapshot): ClientSnapshot {
  let cur = snap;
  if (cur.schemaVersion < 2) cur = migrateV1ToV2(cur);
  return cur;
}

export function migrateDownV2ToV1(snap: ClientSnapshot): ClientSnapshot {
  return { schemaVersion: 1, notes: snap.notes };
}
