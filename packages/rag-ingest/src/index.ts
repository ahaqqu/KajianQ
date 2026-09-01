/**
 * rag-ingest — domain-agnostic ingestion pipeline (off-Workers Bun scripts).
 *
 * The engine owns the *shape* of an ingestion run: parse → summarize parents
 * (LLM, costed) → embed both tracks → upsert through the RagStore → emit an
 * IngestionReport. Source-specific parsing is injected by the domain pack
 * through the `SourceParser` seam, never named here.
 */

export {
  runIngestion,
} from "./pipeline";
export {
  CostCollector,
  type AlignedPairInput,
  type IngestionDeps,
  type ParentSummarizer,
  type ParsedChild,
  type ParsedParent,
  type SourceInput,
  type SourceParser,
} from "./types";