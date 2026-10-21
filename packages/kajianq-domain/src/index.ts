/**
 * kajianq-domain — the KajianQ domain pack on top of the DARS engine.
 *
 * All Islamic-domain logic lives here (and in `apps/`), never in the engine
 * packages. This pack supplies the domain inputs the engine treats as opaque:
 * retrieval metadata filters, prompt templates (parameterized by language),
 * and the domain vocabulary of CONTEXT.md.
 */

/**
 * The filter dimensions (Madzhab / Grade / Matn-Sharh) and their types are
 * owned by `./filters` — one list each, and the router narrows the model's
 * hints against the same ones retrieval is filtered by. Re-exported here so
 * the pack has one public surface; nothing in this barrel declares a second
 * copy.
 */
export {
  GRADES,
  MADZHABS,
  TEXT_LAYERS,
  type Grade,
  type KajianQFilters,
  type Madzhab,
  type TextLayer,
} from "./filters";

export {
  TOTAL_SURAHS,
  TOTAL_AYAHS,
  ayahMetadata,
  formatQuranCitation,
  parseQuranCitation,
  surahSourceKey,
  ayahPairId,
  type QuranAyah,
  type QuranSurahMeta,
  type QuranCitation,
  type QuranAlignedPair,
  type SourceType,
} from "./quran-source";
export {
  cleanTranslation,
  parseSurahFile,
  parseSurahList,
  parseMorphology,
  assertAyahIntegrity,
  missingMorphologyCoverage,
  morphologyWordCountDiffs,
  type SurahFileAyah,
  type SurahListEntry,
} from "./quran-parse";
export {
  buildCorpus,
  bundleQuranSources,
  corpusWordCountDiffs,
  quranSourceParser,
  type QuranCorpus,
} from "./quran-ingest";
export {
  archiveFingerprint,
  quranPairSink,
  surahSummarizer,
  type SummarizerProvider,
} from "./quran-llm";
export {
  HADITH_COLLECTIONS,
  HADITH_COLLECTION_NAMES,
  formatHadithCitation,
  hadithMetadata,
  hadithPairId,
  hadithSourceKey,
  isHadithCollection,
  isWeakGrade,
  mapGrades,
  parseHadithCitation,
  type HadithCitation,
  type HadithCollection,
  type HadithRecord,
  type HadithSourceType,
} from "./hadith-source";
export {
  HadithIdentityError,
  identityResolver,
  parseHadithIdentitySet,
  type HadithIdentityGroup,
  type HadithIdentitySet,
} from "./hadith-identity";
export { alignEditions, type AlignmentStats } from "./hadith-align";
export {
  assertHadithIntegrity,
  parseHadithEdition,
  type EditionHadith,
  type HadithEdition,
} from "./hadith-parse";
export {
  buildHadithCorpus,
  bundleHadithSources,
  corpusGradeStats,
  decodeHadithArchive,
  gradeConsolidationStats,
  hadithSourceParser,
  type HadithCorpus,
} from "./hadith-ingest";
export {
  hadithPairKeyFor,
  hadithPairSink,
  hadithSectionSummarizer,
  type HadithSummarizerProvider,
} from "./hadith-llm";

// -- Embedding benchmark gate (ADR-0013/0014) ------------------------------
export {
  authorProbes,
  benchDocIdHadith,
  benchDocIdQuran,
  corpusFingerprint,
  hadithBenchDocs,
  parseEditions,
  quranBenchDocs,
  stratifiedSubset,
  strideSample,
  type DomainBenchDoc,
} from "./embed-bench-corpus";
export { EXPANSION_SYSTEM_PROMPT, expansionUserPrompt } from "./embed-bench-prompts";
export { DECISION_BENCH_PROMPTS } from "./decision-bench-prompts";

// -- Chat pipeline: Smart Router stages over the DARS seams ----------------
// (Filter vocabulary (Madzhab/Grade/TextLayer/KajianQFilters) stays exported
// from the top of this barrel — chat stages import it via ./filters.)
//
// Smart Router stages 1–2 split across four modules for the agentic
// caps: this barrel is still the one public surface. `taxonomy` owns the
// classification vocabularies, `chat-router-output` the reply reader,
// `chat-subquery-admission` the one admission a text passes to become a
// sub-query (asked of the caller's question and of every text that reaches the
// fan-out), and `chat-router-decompose` the deterministic sub-query repair.
export {
  createKajianQRouter,
  extractJsonObject,
  ROUTER_SYSTEM_PROMPT,
  type RouterProvider,
} from "./chat-router";
export {
  readRouterReply,
  readRouterText,
  RouterReplySchema,
  type RouterReading,
  type RouterReply,
} from "./chat-router-output";
export {
  decomposeQuery,
  MAX_SUB_QUERIES,
  MIN_SUB_QUERIES,
  type DecompositionInput,
  type ModelSubQuery,
} from "./chat-router-decompose";
export {
  DAIF_TRAP_LABEL,
  GOLDEN_SET_LABELS,
  GOLDEN_SET_TAG_VOCABULARY,
  INTENTS,
  isIntent,
  isPrincipleTag,
  isSubjectArea,
  PRINCIPLE_TAGS,
  SMOKE_COVERAGE_TAGS,
  SMOKE_HELD_OUT_IDS,
  SUB_QUERY_ORIGINS,
  SUB_QUERY_ROLES,
  SUBJECT_AREAS,
  type GoldenSetLabel,
  type Intent,
  type PrincipleTag,
  type SubjectArea,
  type SubQueryOrigin,
  type SubQueryRole,
} from "./taxonomy";
export {
  createKajianQRetriever,
  type KajianQRetrieverDeps,
  type RetrieverEmbedder,
  type RetrieverStore,
  type StoreBridge,
} from "./chat-retriever";
// The fusion arithmetic and the two deterministic expansions live in their own
// modules (the 300-line and 5-import agentic caps); the barrel keeps one public
// surface, so consumers import from `@app/kajianq-domain`.
export { hierarchyBonus, rrfFuse, RRF_K, HIERARCHY_BONUS } from "./chat-fusion";
// The store-facing half of stage 3: the exhaustive dimension map, the loud
// unexpressible-dimension failure, and the per-dimension relaxation order.
export { FILTER_DIMENSIONS, ROUTABLE_SOURCES, type RoutableSource } from "./filters";
export {
  FilterNotExpressibleError,
  RELAXATION_ORDER,
  filterEntries,
  metadataFilters,
  nextRelaxation,
} from "./chat-filter-policy";
export {
  SourceRoleNotExpressibleError,
  roleSources,
  routeFilters,
  sourceRoutingDetail,
  sourceTypesOf,
} from "./chat-source-routing";
export {
  DEFAULT_NEIGHBOUR_CAP,
  DEFAULT_NEIGHBOUR_RADIUS,
  NEIGHBOUR_EXPANSION_ORIGIN,
  expandVerseNeighbours,
} from "./chat-retriever-parts";
export {
  createKajianQAssembler,
  MACHINE_TRANSLATION_LABEL,
  renderEvidenceChunk,
} from "./chat-assembler";
export { chatSystemPrompt, chatUserPrompt, type ChatLanguage } from "./chat-prompts";
export {
  validateCitations,
  citationLabelsOf,
  citationCandidatesIn,
  normalizeCitationLabel,
  // The per-address rule's two public halves: `groundingLabelsFor` is what the
  // gate and the citations frame both read to decide what is grounded, and
  // `addressesNamedBy` is the declaration the eval's injected grammar seam
  // consumes, so the engine never re-derives what a Quran range names. Its
  // three states are the contract — `[]`, the declared addresses, and `null`
  // for a declared list that cannot be enumerated, which every consumer must
  // refuse.
  groundingLabelsFor,
  addressesNamedBy,
} from "./chat-citation-validator";
export {
  createKajianQGenerator,
  type GeneratorProvider,
  type StreamHandleLike,
} from "./chat-generator";
export {
  createKajianQReviewer,
  refusalTextFor,
  DEFAULT_REFUSALS,
  buildReviewMessages,
  REVIEWER_SYSTEM_PROMPT,
  parseReviewerVerdict,
  type ReviewerProvider,
  // The `refusal` event's trigger vocabulary, one home for the stage, the
  // route's `traceRefused` and the eval harness.
  type RefusalTrigger,
} from "./chat-reviewer";
export {
  applyProductRules,
  dhaifWarning,
  ulamaDisclaimer,
  hasWeakGradeChunk,
  hasWeakWarning,
  type ProductRulesResult,
} from "./chat-postprocess";
export {
  buildChatStages,
  runChatPipeline,
  runChatPipelinePromise,
  runStoreEffect,
  type ChatPipelineDeps,
} from "./chat-pipeline";

// -- Surah-reference scoped expansion (ADR-0045) ---------------------------
export {
  SURAH_AYAH_COUNTS,
  SURAH_DESCRIPTION_ALIASES,
  SURAH_NAMES,
  normalizeSurahText,
  leadingArticle,
  withoutArticle,
  type SurahDescriptionAlias,
  type SurahName,
} from "./surah-names";
export { detectSurahReference, type SurahReference } from "./surah-reference";
export {
  DEFAULT_SCOPE_EXPANSION_CAP,
  SCOPE_EXPANSION_ORIGIN,
  SCOPE_KEY_SURAH,
  expandSurahScope,
  type ScopeBridge,
  type ScopeChildRow,
  type ScopeExpansion,
  type ScopeStore,
} from "./chat-scope-expansion";
