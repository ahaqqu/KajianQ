import * as v from "valibot";

/**
 * One narrator of a transmission row, as the UI renders it: the catalogue id the
 * persisted trace recorded, and the catalogue's canonical Arabic spelling when the
 * display join resolved one. A narrator the catalogue does not hold keeps its id
 * and loses only the name — the chain is never shortened to the narrators that
 * resolved, because that would present a different transmission than was read.
 */
export const ChatChainNarratorSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  nameAr: v.optional(v.pipe(v.string(), v.minLength(1))),
});

export type ChatChainNarrator = v.InferOutput<typeof ChatChainNarratorSchema>;

/**
 * One transmission row of a cited passage: its ordered narrator sequence, its
 * classification and the grader the trace attributed it to.
 *
 * **Every read row is carried, in the trace's own order** — never only the
 * strongest — so a passage whose chains disagree reaches the reader as they are.
 * `grade` and `grader` are present or absent together, mirroring the persisted
 * record; a row with neither is an ungraded transmission and renders as such.
 * `moreMayExist` flags a list the read bounded: the rows shown are a prefix of
 * the stored ones, and the UI must say so rather than present it as the whole.
 */
export const ChatChainSchema = v.object({
  narrators: v.array(ChatChainNarratorSchema),
  grade: v.optional(v.pipe(v.string(), v.minLength(1))),
  grader: v.optional(v.pipe(v.string(), v.minLength(1))),
  sourceRef: v.optional(v.pipe(v.string(), v.minLength(1))),
  moreMayExist: v.optional(v.boolean()),
});

export type ChatChain = v.InferOutput<typeof ChatChainSchema>;
