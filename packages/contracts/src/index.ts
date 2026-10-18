// Every member below is re-exported by hand, and one this list omits reaches a consumer as
// `undefined` — vitest stays green where `tsc` alone says TS2305. `tests/scripts/contracts-barrel.test.mjs`
// refuses that gap by importing this file and every module and comparing the value names the runtime
// sees. A module the package does not publish is a row in `INTERNAL_MODULES` in
// `scripts/contracts-barrel/policy.mjs` — module path to reason — and the row withholds the whole
// module for as long as it stands: to publish it, export its names here and take the row out.
// A star entry and an `export type` entry are refused, so every name this file publishes is named
// on a line of it.
export {
  HealthResponseSchema,
  HealthErrorSchema,
  type HealthResponse,
  type HealthError,
} from "./health";
export {
  CHAT_MESSAGE_MAX_LENGTH,
  ChatErrorSchema,
  ChatMessageTextSchema,
  ChatMetaSchema,
  ChatRequestSchema,
  ChatSessionIdSchema,
  isChatSessionId,
  isStorableText,
  ChatCitationSchema,
  ChatCitationsFrameSchema,
  ChatTraceChunkSchema,
  ChatTraceFrameSchema,
  ChatSessionMessageSchema,
  ChatSessionMessagesSchema,
  type ChatError,
  type ChatMeta,
  type ChatRequest,
  type ChatCitation,
  type ChatCitationsFrame,
  type ChatTraceChunk,
  type ChatTraceFrame,
  type ChatSessionMessage,
  type ChatSessionMessages,
} from "./chat";
export {
  FEEDBACK_INITIAL_STATUS,
  FeedbackAnchorSchema,
  FeedbackAnchorTypeSchema,
  FeedbackCategorySchema,
  FeedbackErrorSchema,
  FeedbackFlagShape,
  FeedbackRatingSchema,
  FeedbackRequestSchema,
  FeedbackResponseSchema,
  FeedbackThumbShape,
  type FeedbackAnchor,
  type FeedbackAnchorType,
  type FeedbackCategory,
  type FeedbackError,
  type FeedbackRating,
  type FeedbackRequest,
  type FeedbackResponse,
} from "./feedback";
export {
  AnonymousSessionSchema,
  DeletedUserSchema,
  AuthErrorSchema,
  type AnonymousSession,
  type DeletedUser,
  type AuthError,
} from "./auth";
export {
  EvalResultOutcomeSchema,
  EvalRunReportSchema,
  ExpectedBehaviorSchema,
  GoldenCitationSchema,
  GoldenQuestionSchema,
  GoldenSetSchema,
  GoldenSourceSchema,
  parseEvalRunReport,
  type EvalResultOutcome,
  type EvalRunReport,
  type GoldenQuestion,
  type GoldenSet,
} from "./eval";
export {
  CitationCaseSchema,
  DecisionBenchFixtureSchema,
  DecisionTaskSchema,
  RelevanceCaseSchema,
  RerankCaseSchema,
  parseDecisionBenchFixture,
  type CitationCase,
  type DecisionBenchFixture,
  type DecisionBenchPrompts,
  type DecisionTask,
  type RelevanceCase,
  type RerankCase,
} from "./decision-bench";
export {
  IngestionReportSchema,
  AlignedPairSchema,
  MorphTokenSchema,
  parseIngestionReport,
  type IngestionReport,
  type AlignedPair,
  type MorphToken,
} from "./ingestion";
export { describeIssue, issuePath, type ValidationIssue } from "./issue-path";
export {
  ChunkRefSchema,
  CostRecordSchema,
  StageSchema,
  TraceEventSchema,
  TraceSchema,
  parseTrace,
  totalCostMicroUsd,
  type ChunkRef,
  type CostRecord,
  type Stage,
  type Trace,
  type TraceEvent,
  type TraceEventKind,
} from "./trace";
