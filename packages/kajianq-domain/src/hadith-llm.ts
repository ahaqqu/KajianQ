import type { Provider, PromptSpec } from "@app/rag-core";
import type { CostRecord } from "@app/contracts";
import type { RagStore } from "@app/infra";
import { isHadithCollection } from "./hadith-source";
import { Effect } from "effect";

/**
 * Section summaries and the aligned-pair sink — the LLM-facing half of the
 * hadith ingestion wiring (#7). Kept apart from the pure parsing/model
 * module so the LLM seams stay individually testable and the import surface
 * of each file stays small. Archive fingerprinting is reused from the Quran
 * module (`archiveFingerprint`) — the fingerprint algorithm is domain-agnostic.
 */

/** Cheap-tier provider role used for section summaries (config-resolved). */
export type HadithSummarizerProvider = Provider;

/**
 * The LLM-backed parent summarizer: summarizes a (collection, book/section)
 * parent's hadiths (Arabic primary + Indonesian secondary shown to the
 * model) into the summary the parent's embedding is computed from (issue #7
 * AC: parent embeddings from summaries, not full text). Returns the call's
 * CostRecord alongside the summary so the pipeline's collector records it
 * (kajianq-traceability rule 2; review A6 — the cost is part of the report's
 * sum of calls, never dropped).
 */
export function hadithSectionSummarizer(provider: HadithSummarizerProvider): (input: {
  sourceKey: string;
  title: string | null;
  childTexts: readonly string[];
}) => Promise<{ summary: string; cost: CostRecord }> {
  return async (input) => {
    const result = await Effect.runPromise(provider.generate(hadithSectionSummaryPrompt(input)));
    const summary = result.text.trim();
    if (summary.length === 0) {
      throw new Error(`hadith ingestion: empty summary for ${input.sourceKey}`);
    }
    return { summary, cost: result.cost };
  };
}

/** Build the summarizer prompt spec (exported for tests to key their stubs on). */
export function hadithSectionSummaryPrompt(input: {
  sourceKey: string;
  title: string | null;
  childTexts: readonly string[];
}): PromptSpec {
  const sample = input.childTexts.slice(0, 12).join("\n\n---\n\n");
  return {
    turns: [
      {
        role: "system",
        content:
          "You summarize a chapter (book/section) of a canonical hadith collection in Indonesian. " +
          "Write 1-3 sentences describing the chapter's theme. Output only the summary.",
      },
      {
        role: "user",
        content: `Section: ${input.title ?? input.sourceKey}\nSource: ${input.sourceKey}\n\nExcerpt (${input.childTexts.length} hadith total, first 12 shown):\n${sample}`,
      },
    ],
  };
}

/**
 * The pair sink for `runIngestion`: writes each aligned (Arabic, Indonesian)
 * hadith pair through the RagStore's aligned-pair seam (ADR-0014: #24's
 * concept-graph build consumes these rows alongside the Quran pairs).
 * Morphology is empty for hadith in v1 — CAMeL Tools lemmatization is the
 * pre-#24 enrichment step (ADR-0025). The default CLI wiring passes
 * `pairKeyFor` = `hadithPairId(citation.collection, citation.hadithNo)` so
 * persisted rows use the domain's stable `hadith-pair:{collection}:{no}`
 * address (the format #24's build and the citation validator resolve
 * against) rather than the runner's source-derived child key.
 */
export function hadithPairSink(
  store: Pick<RagStore, "upsertAlignedPair">,
  pairKeyFor?: (input: { citation: Record<string, unknown> }) => string,
): (input: {
  pairKey: string;
  citation: Record<string, unknown>;
  textPrimary: string;
  textSecondary: string;
  morphology: readonly Record<string, unknown>[];
}) => Promise<void> {
  return async (input) => {
    await store.upsertAlignedPair({
      pairKey: pairKeyFor?.(input) ?? input.pairKey,
      citation: input.citation,
      textPrimary: input.textPrimary,
      textSecondary: input.textSecondary,
      morphology: input.morphology,
    });
  };
}

/** Default pair-key resolver over a hadith citation (stable domain address). */
export function hadithPairKeyFor(input: { citation: Record<string, unknown> }): string {
  const c = input.citation as { collection?: unknown; hadithNo?: unknown };
  // Validate against the collection registry itself, not the display-name
  // map (review B3): an unregistered code degrades explicitly to "unknown".
  const collection = isHadithCollection(c.collection) ? c.collection : "unknown";
  return `hadith-pair:${collection}:${c.hadithNo ?? "?"}`;
}