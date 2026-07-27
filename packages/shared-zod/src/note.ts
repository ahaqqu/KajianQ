import { z } from "zod";

export const NoteSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(200),
  body: z.string().max(10_000),
  updatedAt: z.number().int().nonnegative(),
  deleted: z.boolean(),
});

export type Note = z.infer<typeof NoteSchema>;

export const NoteInputSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(10_000).optional(),
});

export type NoteInput = z.infer<typeof NoteInputSchema>;

export const NoteListSchema = z.object({
  notes: z.array(NoteSchema),
});
