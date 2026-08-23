/**
 * rag-ingest — domain-agnostic ingestion pipeline (off-Workers Bun scripts).
 *
 * Skeleton seam for the DARS engine: source records are parsed, cleaned, and
 * chunked into `Chunk`-shaped units handed to the store through the RagStore
 * adapter. Engine code here stays domain-agnostic — source-specific parsing is
 * injected by the domain pack, never named here.
 *
 * Real ingestion stages arrive with the corpus tickets (#6, #7) against the
 * RagStore (#4) and Provider (#5) seams. This skeleton exists so the package
 * boundary and typed contract are in place from the foundation.
 */

import type { Chunk } from "@app/rag-core";

/** A raw source document as ingested, prior to cleaning/chunking. */
export type SourceDocument = {
  id: string;
  /** Raw source text, immutable (ADR: never overwrite text_raw). */
  textRaw: string;
  metadata?: Record<string, unknown>;
};

/** Parse+clean+chunk a source document into retrieval-ready chunks. */
export interface IngestStage {
  run(doc: SourceDocument): Promise<readonly Chunk[]>;
}
