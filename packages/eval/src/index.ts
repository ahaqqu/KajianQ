/**
 * eval — the domain-agnostic Golden Set benchmark harness (#8).
 *
 * Runs a versioned question set against a chat API target, scores answers
 * deterministically from persisted traces (retrieval recall, citation
 * validity, refusal correctness), persists per-run results to the eval
 * ledger, and caps spend with a hard budget. The engine owns the measurement
 * machinery; the question-set contents and expected-source vocabularies come
 * from the product (kajianq-domain's fixture), never named here.
 */

export { GoldenSetLoadError, assertV0Shape, loadGoldenSetJson, parseGoldenSet } from "./golden-set";
export { selectSmokeSubset, type SmokeSelectOptions, type SmokeSelection } from "./smoke-subset";
export {
  citationValidity,
  detectRefusal,
  refusalCorrectness,
  retrievalEventsOf,
  retrievalRecall,
} from "./scorers";
export { Budget, BudgetExceededError, budgetCapFromEnv } from "./budget";
export { EvalConfigError, loadEvalRunConfig, type EvalRunConfig } from "./eval-config";
export { consumeSseToText, postChatSse, type ChatSseResult } from "./api-client";
export { REFUSAL_MARKERS, createStagingHarness, type StagingHarness } from "./staging-harness";
export {
  runGoldenSet,
  scoreQuestion,
  buildReport,
  type AnswerTraceSource,
  type ChatTransport,
  type HarnessDeps,
  type HarnessQuestionResult,
  type HarnessRunResult,
  type RunLedger,
} from "./harness";
export type { ChunkRefLike, RetrievalLike, TraceEventLike } from "./harness-types";
export {
  BENCH_K,
  GATE_FLOORS,
  cosineSimilarity,
  evaluateGate,
  parseExpansionSelection,
  rankDocs,
  recallAtK,
  reciprocalRank,
  retryInMs,
  scoreDirection,
  scoreExpansionCase,
  totalCostMicroUsd,
  type BenchCandidateResult,
  type BenchCell,
  type BenchDirection,
  type BenchDoc,
  type BenchQuery,
  type ExpansionCase,
  type ExpansionOutcome,
} from "./embed-bench";
export {
  parseExpansionSet,
  parseProbeSet,
  type BenchProbeSet,
  type ExpansionCaseSet,
} from "./embed-bench-fixtures";
export {
  EMBED_BENCH_DEFAULT_EXPANSION_PATH,
  EMBED_BENCH_DEFAULT_PROBE_PATH,
  loadEmbedBenchConfig,
  type EmbedBenchConfig,
} from "./eval-config";
