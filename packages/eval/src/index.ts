/**
 * eval — the domain-agnostic Golden Set benchmark harness (#8).
 *
 * Runs a versioned question set against a chat API target, scores answers
 * deterministically from persisted traces (source-type recall, citation-address
 * recall, citation validity, refusal correctness), persists per-run results to
 * the eval ledger, and caps spend with a hard budget. The engine owns the measurement
 * machinery; the question-set contents and expected-source vocabularies come
 * from the product (kajianq-domain's fixture), never named here.
 */

export { GoldenSetLoadError, assertV0Shape, loadGoldenSetJson, parseGoldenSet } from "./golden-set";
export {
  IndependentProbeLoadError,
  IndependentProbeFixtureSchema,
  IndependentProbeSchema,
  contentCheckPasses,
  failedProbeOutcome,
  foldProbeText,
  formatProbeRun,
  loadIndependentProbesJson,
  parseIndependentProbes,
  probeExitPolicy,
  runProbes,
  scoreProbe,
  type IndependentContentCheck,
  type IndependentProbe,
  type IndependentProbeFixture,
  type ProbeAnswer,
  type ProbeAsk,
  type ProbeContentOutcome,
  type ProbeOutcome,
} from "./independent-probes";
export {
  formatSmokePlan,
  selectSmokeSubset,
  SmokeSubsetError,
  type SmokeSelectOptions,
  type SmokeSelection,
} from "./smoke-subset";
export {
  behaviorAccepted,
  citationAddressRecall,
  citationLabelsPresent,
  citationValidity,
  detectRefusal,
  groundedAnswer,
  refusalCorrectness,
  retrievalEventsOf,
  sourceTypeRecall,
} from "./scorers";
export { Budget, BudgetExceededError, budgetCapFromEnv } from "./budget";
export { answerCitationLabels, answerMetricsSummary, answerStats } from "./harness-outcomes";
export { CitationAlternativesScopeError, requireAlternativesScope } from "./citation-alternatives";
export { CitationGrammarError, requireCitationGrammar } from "./citation-grammar";
export {
  CitationIdentityError,
  requireCitationIdentity,
  resolveIdentity,
} from "./citation-identity";
export {
  EvalConfigError,
  INDEPENDENT_PROBES_DEFAULT_PATH,
  loadEvalProbeConfig,
  loadEvalRunConfig,
  type EvalProbeConfig,
  type EvalRunConfig,
} from "./eval-config";
export {
  ChatTransportError,
  consumeSseToText,
  parseCitationsFrame,
  postChatSse,
  type ChatSseResult,
  type ChatTransportPhase,
} from "./api-client";
export {
  runGoldenSet,
  scoreQuestion,
  buildReport,
  identitySatisfiedSummary,
  type AnswerTraceSource,
  type ChatTransport,
  type HarnessDeps,
  type HarnessQuestionResult,
  type HarnessRunResult,
  type RunLedger,
} from "./harness";
export type {
  ChunkRefLike,
  CitationFrameLike,
  CitationGrammar,
  CitationIdentity,
  QuoteEquivalence,
  RetrievalLike,
  TraceEventLike,
} from "./harness-types";
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
  type BenchProbeOutcome,
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
export { embedDirectionStats, embedExpansionAccuracy } from "@app/contracts";
export { parseRouterBenchFixture, parseSummarizerBenchFixture } from "@app/contracts";
export {
  EMBED_BENCH_DEFAULT_DIR,
  EMBED_BENCH_DEFAULT_EXPANSION_PATH,
  EMBED_BENCH_DEFAULT_PROBE_PATH,
  EMBED_BENCH_DEFAULT_REPORT_PATH,
  EMBED_BENCH_DEFAULT_RUNS_DIR,
  EMBED_BENCH_DEFAULT_SEAL_PATH,
  loadEmbedBenchConfig,
  type EmbedBenchConfig,
} from "./eval-config";
export {
  buildEmbedBenchRun,
  embedBenchRunFilePath,
  embedBenchRunSlug,
  embedBenchSamplesPin,
  loadEmbedBenchRuns,
  loadEmbedBenchSeal,
  writeEmbedBenchRun,
  EmbedBenchStoreError,
  type EmbedBenchSeal,
} from "./embed-bench-store";
export { renderEmbedBenchReport } from "./embed-bench-report";
export {
  runRouterBench,
  scoreRouterCase,
  type RouterBenchAdapters,
  type RouterCaseOutcome,
} from "./router-bench";
export {
  loadRouterBenchRuns,
  loadRouterBenchSeal,
  RouterBenchStoreError,
  routerBenchPromptsPin,
  routerBenchRunFilePath,
  routerBenchSamplesPin,
  writeRouterBenchRun,
  type RouterBenchSeal,
} from "./router-bench-store";
export { renderRouterBenchReport } from "./router-bench-report";
export {
  checkSummarizerCase,
  runSummarizerBench,
  type SummarizerBenchAdapters,
  type SummarizerCaseOutcome,
} from "./summarizer-bench";
export {
  loadSummarizerBenchRuns,
  loadSummarizerBenchSeal,
  SummarizerBenchStoreError,
  summarizerBenchPromptsPin,
  summarizerBenchRunFilePath,
  summarizerBenchSamplesPin,
  writeSummarizerBenchRun,
  type SummarizerBenchSeal,
} from "./summarizer-bench-store";
export { renderSummarizerBenchReport } from "./summarizer-bench-report";
export {
  DECISION_BENCH_DEFAULT_DIR,
  DECISION_BENCH_DEFAULT_FIXTURE_PATH,
  DECISION_BENCH_DEFAULT_REPORT_PATH,
  DECISION_BENCH_DEFAULT_RUNS_DIR,
  DECISION_BENCH_DEFAULT_SEAL_PATH,
  loadDecisionBenchConfig,
  loadDecisionBenchFixtureJson,
  parseDecisionBenchFixture,
  type DecisionBenchConfig,
} from "./decision-bench-config";
export {
  DECISION_GATE_FLOORS,
  accuracyByLanguage,
  accuracyByTask,
  evaluateDecisionGate,
  meanAccuracy,
  runDecisionBench,
  scoreCitationAnswer,
  scoreRelevanceAnswer,
  scoreRerankAnswer,
  type CaseOutcome,
  type DecisionBenchPrompts,
  type DecisionGate,
} from "./decision-bench";
export {
  countSupersededResults,
  decisionBenchPromptsPin,
  decisionBenchRunFilePath,
  decisionBenchRunSlug,
  decisionBenchSamplesPin,
  loadDecisionBenchRuns,
  loadDecisionBenchSeal,
  writeDecisionBenchRun,
  DecisionBenchStoreError,
  type DecisionBenchSeal,
} from "./decision-bench-store";
export { renderDecisionBenchReport } from "./decision-bench-report";
