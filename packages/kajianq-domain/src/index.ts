/**
 * kajianq-domain — the KajianQ domain pack on top of the DARS engine.
 *
 * All Islamic-domain logic lives here (and in `apps/`), never in the engine
 * packages. This pack supplies the domain inputs the engine treats as opaque:
 * retrieval metadata filters, prompt templates (parameterized by language),
 * and the domain vocabulary of CONTEXT.md.
 *
 * Foundation skeleton: defines the domain vocabulary types injected into the
 * engine. Source parsers, prompt templates, and the terminology-graph
 * consumption arrive with the corpus and Smart Router tickets.
 */

import type { Grade } from "./hadith-source";

/** One of the four Sunni legal schools (CONTEXT.md "Madzhab"). */
export const MADZHABS = ["hanafi", "maliki", "syafii", "hambali"] as const;
export type Madzhab = (typeof MADZHABS)[number];

/**
 * Hadith authenticity classification (CONTEXT.md "Grade"). Owned by
 * `hadith-source.ts` (review B1: no barrel self-imports); re-exported here.
 */
export { GRADES, type Grade } from "./hadith-source";

/** Body of a work vs. commentary on it (CONTEXT.md "Matn"/"Sharh"). */
export type TextLayer = "matn" | "sharh";

/**
 * Retrieval metadata filters supplied to the engine's Query.filters. The
 * engine threads them through untouched; only this pack names the dimensions.
 */
export type KajianQFilters = {
  madzhab?: Madzhab;
  grade?: Grade;
  textLayer?: TextLayer;
};

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

// -- Embedding benchmark gate (#9, ADR-0013/0014) --------------------------
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

// -- Chat pipeline (#8): Smart Router stages over the DARS seams -----------
// (Filter vocabulary (Madzhab/Grade/TextLayer/KajianQFilters) stays exported
// from the top of this barrel — chat stages import it via ./filters.)
export {
  createKajianQRouter,
  extractJsonObject,
  ROUTER_SYSTEM_PROMPT,
  type RouterProvider,
} from "./chat-router";
export {
  createKajianQRetriever,
  hierarchyBonus,
  metadataFilters,
  rrfFuse,
  RRF_K,
  HIERARCHY_BONUS,
  type KajianQRetrieverDeps,
  type RetrieverEmbedder,
  type RetrieverStore,
  type StoreBridge,
} from "./chat-retriever";
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
} from "./chat-reviewer";
export {
  applyProductRules,
  dhaifWarning,
  ulamaDisclaimer,
  hasWeakGradeChunk,
  type ProductRulesResult,
} from "./chat-postprocess";
export {
  buildChatStages,
  runChatPipeline,
  runChatPipelinePromise,
  runStoreEffect,
  type ChatPipelineDeps,
} from "./chat-pipeline";
