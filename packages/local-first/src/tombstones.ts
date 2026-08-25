import type { NoteRow } from "./merge";

/**
 * Tombstone hygiene. Tombstones carry no payload (a delete must not retain
 * the note's content) and are garbage-collected client-side once they are
 * older than the horizon below. GC runs only after a successful pushPull, so
 * every collected tombstone is server-acknowledged by definition.
 *
 * Horizon: 30 days — any client that syncs at least monthly never resurrects
 * a collected delete. The server keeps its own tombstones; local GC only
 * bounds IndexedDB growth.
 */
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Strip a deleted note to a payload-free tombstone. */
export function toTombstone(id: string, updatedAt: number): NoteRow {
  return { id, title: "", body: "", updatedAt, deleted: true };
}

/** Drop tombstones older than the horizon. Alive rows are never touched. */
export function gcTombstones(
  rows: NoteRow[],
  now = Date.now(),
  ttlMs = TOMBSTONE_TTL_MS,
): NoteRow[] {
  return rows.filter((r) => !r.deleted || now - r.updatedAt < ttlMs);
}
