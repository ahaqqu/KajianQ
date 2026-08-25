import * as v from "valibot";

export const NoteSchema = v.object({
  id: v.pipe(v.string(), v.uuid()),
  title: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  body: v.pipe(v.string(), v.maxLength(10_000)),
  updatedAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
  deleted: v.boolean(),
});

export type Note = v.InferOutput<typeof NoteSchema>;

export const NoteListSchema = v.object({
  notes: v.array(NoteSchema),
});
