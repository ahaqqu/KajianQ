import type { Provider, PromptSpec } from "@app/rag-core";
import type { RagStore } from "@app/infra";
import { createHash } from "node:crypto";
import type { QuranSurahMeta } from "./quran-source";

/**
 * Surah summaries, the aligned-pair sink, and archive fingerprinting — the
 * LLM-facing half of the Quran ingestion wiring (#6). Kept apart from the
 * pure parsing/model module so the LLM seams stay individually testable and
 * the import surface of each file stays small.
 */

/** Cheap-tier provider role used for surah summaries (config-resolved). */
export type SummarizerProvider = Provider;

/**
 * The LLM-backed parent summarizer: summarizes the surah's ayahs (Arabic
 * primary + Indonesian secondary shown to the model) into the summary that
 * the parent's embedding is computed from (issue #6 AC: parent embeddings
 * from summaries, not full text). The call's CostRecord is returned inside
 * the Provider result and recorded by the pipeline's collector
 * (kajianq-traceability rule 2: every LLM call leaves model/tokens/cost).
 */
export function surahSummarizer(
  provider: SummarizerProvider,
): (input: { sourceKey: string; title: string | null; childTexts: readonly string[] }) => Promise<string> {
  return async (input) => {
    const result = await provider.generate(surahSummaryPrompt(input));
    const summary = result.text.trim();
    if (summary.length === 0) {
      throw new Error(`quran ingestion: empty summary for ${input.sourceKey}`);
    }
    return summary;
  };
}

/** Build the summarizer prompt spec (exported for tests to key their stubs on). */
export function surahSummaryPrompt(input: {
  sourceKey: string;
  title: string | null;
  childTexts: readonly string[];
}): PromptSpec {
  const sample = input.childTexts.slice(0, 12).join("\n");
  return {
    turns: [
      {
        role: "system",
        content:
          "You summarize a chapter of a religious text in Indonesian. " +
          "Write 1-3 sentences describing the chapter's theme. Output only the summary.",
      },
      {
        role: "user",
        content: `Chapter: ${input.title ?? input.sourceKey}\nSource: ${input.sourceKey}\n\nExcerpt (${input.childTexts.length} verses total, first 12 shown):\n${sample}`,
      },
    ],
  };
}

/** Deterministic fallback summary when no LLM is wired (integrity over prose). */
export function fallbackSurahSummary(surah: QuranSurahMeta): string {
  return `Surah ${surah.name} (${surah.number}) — ${surah.ayahCount} ayat${surah.nameId ? `, ${surah.nameId}` : ""}.`;
}

/**
 * The pair sink for `runIngestion`: writes each aligned (Arabic, Indonesian)
 * ayah pair with its morphology through the RagStore's aligned-pair seam
 * (ADR-0014: #24's concept-graph build consumes these rows). The pair key is
 * the domain's `quran-pair:surah:ayah`, so re-running ingestion upserts in
 * place instead of duplicating pairs.
 */
export function quranPairSink(
  store: Pick<RagStore, "upsertAlignedPair">,
): (input: {
  pairKey: string;
  citation: Record<string, unknown>;
  textPrimary: string;
  textSecondary: string;
  morphology: readonly Record<string, unknown>[];
}) => Promise<void> {
  return async (input) => {
    await store.upsertAlignedPair({
      pairKey: `quran-pair:${String(input.citation.surah)}:${String(input.citation.ayah)}`,
      citation: input.citation,
      textPrimary: input.textPrimary,
      textSecondary: input.textSecondary,
      morphology: input.morphology,
    });
  };
}

/** SHA-256 of the raw bytes — the archive identity + idempotency fingerprint. */
export function archiveFingerprint(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}