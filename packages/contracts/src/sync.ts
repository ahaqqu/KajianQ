import * as v from "valibot";
import { NoteSchema } from "./note";

/**
 * Sync request item. Unlike `NoteSchema`, the title may be empty: deleted
 * notes sync as payload-stripped tombstones (see `toTombstone` in
 * `@app/local-first`), and the wire contract must accept them.
 */
export const SyncNoteSchema = v.object({
  ...NoteSchema.entries,
  title: v.pipe(v.string(), v.maxLength(200)),
});

export type SyncNote = v.InferOutput<typeof SyncNoteSchema>;

export const SyncRequestSchema = v.object({
  schemaVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  clientVersion: v.pipe(v.string(), v.minLength(1)),
  notes: v.array(SyncNoteSchema),
});

export type SyncRequest = v.InferOutput<typeof SyncRequestSchema>;

export const SyncResponseSchema = v.object({
  schemaVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  serverNow: v.pipe(v.number(), v.integer(), v.minValue(0)),
  notes: v.array(NoteSchema),
});

export type SyncResponse = v.InferOutput<typeof SyncResponseSchema>;
