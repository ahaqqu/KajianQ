/**
 * The `RagStore` seam's halves, re-exported through one barrel so the composition
 * interface (`rag-store.ts`) can name every one of them within the agentic import
 * cap. This is a pure re-grouping — each seam module keeps its own concern, and no
 * logic lives here.
 */
export type { RagStoreAdmin } from "./rag-store-admin-seam";
export type { RagStoreCorpus, StoreError } from "./rag-store-corpus-seam";
export type { RagStoreEvalLedger, RagStoreEvalRunWrite } from "./rag-store-eval-seam";
export type { RagStoreFeedback } from "./rag-store-feedback-seam";
export type { RagStoreModelConfig } from "./rag-store-model-config-seam";
export type { RagStoreNarrators } from "./rag-store-narrator-seam";
export type { RagStoreTrace } from "./rag-store-trace-seam";
