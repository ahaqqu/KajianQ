import type { Note } from "@app/contracts";
import type { NoteRow } from "./merge";

/** Raw D1 `notes` table row (`deleted` stored as 0/1). */
export type NoteDbRow = {
  id: string;
  title: string;
  body: string;
  updatedAt: number;
  deleted: number;
};

/** NoteRow → wire Note (`deleted` normalized to a boolean). */
export function rowToNote(row: NoteRow): Note {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    updatedAt: row.updatedAt,
    deleted: Boolean(row.deleted),
  };
}

/** Wire Note → NoteRow. */
export function noteToRow(note: Note): NoteRow {
  return {
    id: note.id,
    title: note.title,
    body: note.body,
    updatedAt: note.updatedAt,
    deleted: note.deleted,
  };
}

/** D1 row → NoteRow (`deleted` 0/1 → boolean). */
export function dbToRow(row: NoteDbRow): NoteRow {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    updatedAt: row.updatedAt,
    deleted: row.deleted === 1,
  };
}
