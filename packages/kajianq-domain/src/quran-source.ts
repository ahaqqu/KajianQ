import type { AlignedPair, MorphToken } from "@app/contracts";

/**
 * KajianQ Quran ingestion — domain pack source model (#6).
 *
 * This module owns the Quran-specific shapes: the Tanzil-numbered Surah/Ayah
 * address, the `QS. Surah:Ayah` citation format (CONTEXT.md), and the
 * aligned (Arabic, Indonesian) ayah pair with its per-token morphology from
 * the Quranic Arabic Corpus (ADR-0014). The engine packages never name any
 * of this vocabulary (dars-pluggability rule 1); it arrives here as typed
 * values and is handed to `@app/rag-ingest` through its generic seams.
 */

/** Tanzil numbering: 114 surahs, 6,236 ayahs total. */
export const TOTAL_SURAHS = 114;
export const TOTAL_AYAHS = 6_236;

/** The source-type discriminator written into every chunk's metadata. */
export type SourceType = "quran";

/**
 * A parsed ayah record from the combined (Arabic + Indonesian) source. One
 * row per (surah, ayah) per Tanzil numbering — the alignment key between the
 * Uthmani text, the Indonesian translation, and the Quranic Arabic Corpus
 * morphology (all three are keyed to the same Tanzil numbering, which is why
 * the number pair — not fuzzy text matching — is the authoritative join).
 */
export type QuranAyah = {
  surah: number;
  ayah: number;
  /** Uthmani Arabic, verbatim from the source (immutable `text_raw`). */
  textAr: string;
  /** Indonesian translation (Kemenag), the secondary display track. */
  textId: string;
};

/** Surah-level metadata carried by the parent document. */
export type QuranSurahMeta = {
  number: number;
  name: string;
  /** Indonesian translated name of the surah. */
  nameId: string | null;
  /** Number of ayahs in this surah, per Tanzil numbering. */
  ayahCount: number;
};

/** The domain citation shape stored in `doc_children.citation`. */
export type QuranCitation = {
  sourceType: SourceType;
  surah: number;
  ayah: number;
};

/** Format the user-facing citation label: `QS. Surah:Ayah` (CONTEXT.md). */
export function formatQuranCitation(c: QuranCitation): string {
  return `QS. ${c.surah}:${c.ayah}`;
}

/** Parse a `QS. Surah:Ayah` label back into its citation object. */
export function parseQuranCitation(label: string): QuranCitation | null {
  const match = /^QS\.\s*(\d+):(\d+)$/.exec(label.trim());
  if (!match) return null;
  const surah = Number(match[1]);
  const ayah = Number(match[2]);
  if (!Number.isInteger(surah) || !Number.isInteger(ayah)) return null;
  return { sourceType: "quran", surah, ayah };
}

/** A per-ayah aligned pair with morphology, ready for #24's concept graph. */
export type QuranAlignedPair = AlignedPair & {
  /** Verbatim `MorphToken` list from the Quranic Arabic Corpus. */
  morphology: readonly MorphToken[];
};

/** Stable provenance keys — the store upserts on them (idempotent ingestion). */
export function surahSourceKey(surah: number): string {
  return `quran/tanzil-uthmani/surah/${surah}`;
}

export function ayahPairId(surah: number, ayah: number): string {
  return `quran-pair:${surah}:${ayah}`;
}

/** Metadata written on every ayah child chunk (retrieval filters). */
export function ayahMetadata(ayah: QuranAyah): Record<string, unknown> {
  return {
    sourceType: "quran" satisfies SourceType,
    surah: ayah.surah,
    ayah: ayah.ayah,
    citation: formatQuranCitation({ sourceType: "quran", surah: ayah.surah, ayah: ayah.ayah }),
  };
}