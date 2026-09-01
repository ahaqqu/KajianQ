import * as v from "valibot";
import { CostRecordSchema } from "./trace";

/**
 * Ingestion contracts (#6). These shapes are shared by the ingestion pipeline
 * (`@app/rag-ingest`), the domain packs that drive it, and the CLI scripts
 * that persist reports. They are deliberately domain-agnostic: a source
 * document's address inside its corpus is an opaque `citation` object, and
 * languages are role-named (`primary`/`secondary`) rather than named after
 * any natural language (AGENTS.md rule 1 — the domain pack binds roles to
 * concrete languages at its boundary).
 */

/**
 * The batch report every ingestion run must produce and persist
 * (kajianq-traceability rule 4: "batch jobs produce reports — stored and
 * citable, never skipped"). The shape is generic over the counted facts; a
 * domain pack extends it via the opaque `details` record.
 */
export const IngestionReportSchema = v.object({
  /** Correlates the report to the pipeline run that produced it. */
  runId: v.pipe(v.string(), v.minLength(1)),
  /** The corpus-level identity of what was ingested, e.g. a source key. */
  sourceKey: v.pipe(v.string(), v.minLength(1)),
  startedAt: v.pipe(v.number(), v.integer()),
  finishedAt: v.pipe(v.number(), v.integer()),
  /** Documents (parents) written, after dedup/upsert. */
  parentsWritten: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /** Chunks (children) written, after dedup/upsert. */
  childrenWritten: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /** Chunks rejected by validation — quarantined counts, never force-merged. */
  quarantined: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /** Sum of every recorded LLM/embedding call cost, in micro-USD. */
  costMicroUsd: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /** Per-call cost records — the report is the persisted trace of the run. */
  llmCalls: v.array(CostRecordSchema),
  /** Domain-specific counters and sampled checks (opaque to the engine). */
  details: v.optional(v.record(v.string(), v.unknown())),
});

export type IngestionReport = v.InferOutput<typeof IngestionReportSchema>;

/** Parse an untrusted report payload (persisted JSONB) back into the type. */
export function parseIngestionReport(report: unknown): IngestionReport {
  return v.parse(IngestionReportSchema, report);
}

/**
 * One aligned source/target pair — the export unit a downstream terminology
 * build consumes (ADR-0014: the aligned pairs are the seed source for the
 * concept-graph build). `citation` is the pair's address in its corpus
 * (opaque here; the domain pack defines the shape). `text` carries one entry
 * per role so consumers can select a language track without re-parsing.
 */
export const AlignedPairSchema = v.object({
  /** Stable pair key, unique within the corpus (e.g. a source-scoped id). */
  pairId: v.pipe(v.string(), v.minLength(1)),
  citation: v.record(v.string(), v.unknown()),
  /** Primary-track text (the canonical evidence layer, ADR-0013). */
  textPrimary: v.pipe(v.string(), v.minLength(1)),
  /** Secondary-track text (the display/fallback layer, ADR-0013). */
  textSecondary: v.pipe(v.string(), v.minLength(1)),
});

export type AlignedPair = v.InferOutput<typeof AlignedPairSchema>;

/**
 * Per-token morphology attached alongside a primary-track text (ADR-0014:
 * lemma+root are a build dependency, keyed to the same diacritized text).
 * `lemma`/`root` are verbatim from the morphology source; `segment` is the
 * surface form of the token, and `type` distinguishes a stem from an affix.
 */
export const MorphTokenSchema = v.object({
  /** 1-based word position within the pair's primary text. */
  word: v.pipe(v.number(), v.integer(), v.minValue(1)),
  /** 1-based segment position within the word. */
  segment: v.pipe(v.number(), v.integer(), v.minValue(1)),
  /** Surface form of this segment, in the source's own script. */
  form: v.pipe(v.string(), v.minLength(1)),
  /** The morphological segment type (stem, prefix, suffix). */
  type: v.picklist(["STEM", "PREFIX", "SUFFIX"]),
  /** Canonical lemma, when the segment has one (affixes do not). */
  lemma: v.optional(v.pipe(v.string(), v.minLength(1))),
  /** Triliteral/quadriliteral root, when the segment has one. */
  root: v.optional(v.pipe(v.string(), v.minLength(1))),
  /** The part-of-speech tag from the morphology source. */
  pos: v.pipe(v.string(), v.minLength(1)),
});

export type MorphToken = v.InferOutput<typeof MorphTokenSchema>;