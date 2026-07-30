import type { Note } from "@app/contracts";
import {
  aliveNotes,
  dbToRow,
  mergeNotes,
  noteToRow,
  rowToNote,
  type NoteDbRow,
} from "@app/local-first";
import type { D1Database } from "../cf-types";

export async function listNotes(
  db: D1Database,
  userId: string,
): Promise<Note[]> {
  const res = await db
    .prepare(
      `SELECT id, title, body, updated_at as updatedAt, deleted
       FROM notes WHERE user_id = ?`,
    )
    .bind(userId)
    .all<NoteDbRow>();
  const rows = (res.results ?? []).map(dbToRow);
  return aliveNotes(rows).map(rowToNote);
}

export async function syncNotes(
  db: D1Database,
  userId: string,
  incoming: Note[],
): Promise<Note[]> {
  const existing = await db
    .prepare(
      `SELECT id, title, body, updated_at as updatedAt, deleted
       FROM notes WHERE user_id = ?`,
    )
    .bind(userId)
    .all<NoteDbRow>();
  const serverRows = (existing.results ?? []).map(dbToRow);
  const clientRows = incoming.map(noteToRow);
  const merged = mergeNotes(serverRows, clientRows);
  for (const row of merged) {
    await db
      .prepare(
        `INSERT INTO notes (id, user_id, title, body, updated_at, deleted)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           body = excluded.body,
           updated_at = excluded.updated_at,
           deleted = excluded.deleted
         WHERE notes.user_id = excluded.user_id`,
      )
      .bind(
        row.id,
        userId,
        row.title,
        row.body,
        row.updatedAt,
        row.deleted ? 1 : 0,
      )
      .run();
  }
  return aliveNotes(merged).map(rowToNote);
}
