export { createLogger, type Logger, type LogFields, type LogLevel, type LogSink } from "./logger";
export {
  createMemoryObjectStore,
  createR2ObjectStore,
  createS3ObjectStore,
  type ObjectStore,
  type R2Like,
} from "./object-store";
export { createMemoryConfigStore, type ConfigStore } from "./config-store";
export { createNeonRagStore } from "./rag-store-neon";
export { type NeonRagStoreOptions } from "./rag-store-neon-logging";
export { createRagStore, type RagStoreProvider } from "./rag-store-factory";
// The engine's closed store-failure taxonomy (ADR-0027 decision 7) —
// defined in @app/rag-core, re-exported here so seam consumers need only
// the @app/infra import surface. Consumers switch on `kind`, never on
// adapter or vendor classes.
export { StoreError, type StoreErrorKind } from "@app/rag-core";
export {
  loadProviderConfig,
  parseCandidateKey,
  parseProviderConfig,
  resolveChain,
  ProviderConfigSchema,
  type Candidate,
  type ModelConfig,
  type ProviderConfig,
  type VendorConfig,
} from "./providers/provider-config";
export {
  createChatCompletionsProvider,
  errorKindForStatus,
  isRetryable,
  type FetchLike,
  type ChatCompletionsOptions,
} from "./providers/chat-completions-adapter";
export { resolveRole, type ResolvedRole, type ResolveOptions } from "./providers/provider-factory";
// Retry policies for the two call-site shapes: interactive (default) and
// offline batch jobs, which must ride out a vendor's per-minute window
// instead of giving up after ≈1.5 s (see retry-schedule.ts).
export {
  batchRetrySchedule,
  defaultRetrySchedule,
  perKindRetrySchedule,
  type RetryBudgets,
} from "./providers/retry-schedule";
export {
  type AlignedPairInsert,
  type ChatMessage,
  type DocChild,
  type DocChildInsert,
  type DocParent,
  type DocParentInsert,
  type RagStore,
  type RetrievalTrack,
  type SimilarChild,
} from "./rag-store";
