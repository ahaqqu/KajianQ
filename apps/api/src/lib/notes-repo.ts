import type { Note } from "@app/shared-zod";
import { aliveNotes, mergeNotes, type NoteRow } from "@app/sync-protocol";
import type { D1Database } from "../cf-types";

function toNote(row: NoteRow): Note {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    updatedAt: row.updatedAt,
    deleted: Boolean(row.deleted),
  };
}

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
    .all<{
      id: string;
      title: string;
      body: string;
      updatedAt: number;
      deleted: number;
    }>();
  const rows = (res.results ?? []).map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    updatedAt: r.updatedAt,
    deleted: r.deleted === 1,
  }));
  return aliveNotes(rows).map(toNote);
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
    .all<{
      id: string;
      title: string;
      body: string;
      updatedAt: number;
      deleted: number;
    }>();
  const serverRows: NoteRow[] = (existing.results ?? []).map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    updatedAt: r.updatedAt,
    deleted: r.deleted === 1,
  }));
  const clientRows: NoteRow[] = incoming.map((n) => ({
    id: n.id,
    title: n.title,
    body: n.body,
    updatedAt: n.updatedAt,
    deleted: n.deleted,
  }));
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
  return aliveNotes(merged).map(toNote);
}
