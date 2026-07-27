import { z } from "zod";
import { NoteSchema } from "./note";

export const SyncRequestSchema = z.object({
  schemaVersion: z.number().int().positive(),
  clientVersion: z.string().min(1),
  notes: z.array(NoteSchema),
});

export type SyncRequest = z.infer<typeof SyncRequestSchema>;

export const SyncResponseSchema = z.object({
  schemaVersion: z.number().int().positive(),
  notes: z.array(NoteSchema),
});

export type SyncResponse = z.infer<typeof SyncResponseSchema>;
