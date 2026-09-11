import { HADITH_COLLECTIONS, type HadithRecord, type HadithCollection } from "./hadith-source";
import type { HadithCorpus } from "./hadith-ingest";
import { parseHadithEdition } from "./hadith-parse";
import type { QuranAyah } from "./quran-source";

/**
 * Embedding-benchmark corpus assembly (#9, ADR-0013 gate): turn the real
 * parsed Quran + hadith sources into the engine's `BenchDoc` shape and the
 * versioned probe set it gates on. This is the same parsing/integrity path
 * the ingester consumes (`quran-ingest`/`hadith-ingest`), so the benchmark
 * measures the corpus the product actually retrieves over — not a synthetic
 * slice.
 *
 * Probe authoring is deterministic: each probe's relevant id is the doc's
 * stable `sourceKey`-shaped id (quran-pair / hadith-pair, the same ids
 * ingestion persists to `aligned_pairs`), so probes stay valid across re-runs
 * and re-embeddings.
 */

/** One benchmark doc: stable id + both track texts (verbatim from sources). */
export type DomainBenchDoc = {
  id: string;
  textAr: string;
  textId: string | null;
  /** Provenance label: `quran` or `hadith` (the domain's SourceType). */
  sourceType: "quran" | "hadith";
};

/** Stable benchmark doc id — mirrors `ayahPairId`/`hadithPairId` formats. */
export function benchDocIdQuran(surah: number, ayah: number): string {
  return `quran-pair:${surah}:${ayah}`;
}

export function benchDocIdHadith(collection: string, hadithNo: string): string {
  return `hadith-pair:${collection}:${hadithNo}`;
}

/** Cap on how big one benchmark doc's text may be (embedding input sanity). */
const MAX_TEXT_CHARS = 4_000;

/** Quran docs: one per ayah, from the parsed corpus (verbatim texts). */
export function quranBenchDocs(ayahs: readonly QuranAyah[]): DomainBenchDoc[] {
  return ayahs.map((a) => ({
    id: benchDocIdQuran(a.surah, a.ayah),
    textAr: a.textAr.slice(0, MAX_TEXT_CHARS),
    textId: a.textId.slice(0, MAX_TEXT_CHARS),
    sourceType: "quran",
  }));
}

/** Hadith docs: one per aligned record with non-empty Arabic + Indonesian. */
export function hadithBenchDocs(records: readonly HadithRecord[]): DomainBenchDoc[] {
  const out: DomainBenchDoc[] = [];
  for (const r of records) {
    if (r.textAr.trim().length === 0 || r.textId === null || r.textId.trim().length === 0) {
      continue;
    }
    out.push({
      id: benchDocIdHadith(r.collection, r.hadithNo),
      textAr: r.textAr.slice(0, MAX_TEXT_CHARS),
      textId: r.textId.slice(0, MAX_TEXT_CHARS),
      sourceType: "hadith",
    });
  }
  return out;
}

/** Deterministic sha-like corpus fingerprint (FNV-1a 64 over doc ids+texts). */
export function corpusFingerprint(docs: readonly DomainBenchDoc[]): string {
  let h = 0xcbf29ce484222325n;
  const unit = 0x100000001b3n;
  const mix = (s: string) => {
    for (let i = 0; i < s.length; i += 1) {
      h ^= BigInt(s.charCodeAt(i));
      h = (h * unit) & 0xffffffffffffffffn;
    }
  };
  for (const d of docs) {
    mix(d.id);
    mix("\u0000");
    mix(d.textAr);
    mix("\u0000");
    mix(d.textId ?? "");
    mix("\u0001");
  }
  return `fnv1a64:${h.toString(16).padStart(16, "0")}:${docs.length}`;
}

/**
 * Deterministic stride sample: evenly-spaced items across the array (thermo
 * B4 — the old `seed` parameter was declared but never used, implying a
 * seeded randomness the function does not have; removed).
 */
export function strideSample<T>(items: readonly T[], count: number): T[] {
  if (count >= items.length) return [...items];
  if (count <= 0) return [];
  const stride = items.length / count;
  const out: T[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(items[Math.floor(i * stride) % items.length]!);
  }
  return out;
}

/**
 * The gate's free-tier budget: each embedded item counts against the vendor's
 * per-minute embed-content cap, so the gate runs over a deterministic
 * stratified subset of the real corpus rather than all ~660k rows. The split
 * preserves each group's share of the full corpus; a group smaller than its
 * share contributes all its rows and the other group takes the excess.
 */
export function stratifiedSubset(
  quranDocs: readonly DomainBenchDoc[],
  hadithDocs: readonly DomainBenchDoc[],
  targets: { total: number },
): DomainBenchDoc[] {
  const total = quranDocs.length + hadithDocs.length;
  if (targets.total <= 0 || total === 0) return [];
  const share = quranDocs.length / total;
  let quranTarget = Math.min(quranDocs.length, Math.round(targets.total * share));
  let hadithTarget = Math.min(hadithDocs.length, targets.total - quranTarget);
  // One group short of its share? Hand the unused budget to the other.
  quranTarget = Math.min(quranDocs.length, targets.total - hadithTarget);
  hadithTarget = Math.min(hadithDocs.length, targets.total - quranTarget);
  return [...strideSample(quranDocs, quranTarget), ...strideSample(hadithDocs, hadithTarget)];
}

/**
 * Author the probe set from the corpus docs (deterministic): each probe is a
 * self-retrieval probe — the query text IS a doc's own track text and the
 * relevant id is that doc. The runner reuses the doc's already-computed track
 * vector as the query vector (no second embedding pass): this measures the
 * pure cross-lingual/monolingual alignment of the embedding space, which is
 * exactly what the ADR-0013 gate asks. Deterministic sampling keeps re-runs
 * comparable; `fingerprint` binds the probes to the corpus they were
 * authored against.
 */
export function authorProbes(
  docs: readonly DomainBenchDoc[],
  counts: { crossLingual: number; monolingual: number; idTrack: number },
  fingerprint: string,
): {
  crossLingual: { id: string; text: string; relevantIds: string[] }[];
  monolingual: { id: string; text: string; relevantIds: string[] }[];
  idFallback: { id: string; text: string; relevantIds: string[] }[];
} {
  const withId = docs.filter((d) => d.textId !== null && d.textId.length > 0);
  const cross = strideSample(withId, counts.crossLingual).map((d) => ({
    id: `xl-${d.id}`,
    text: d.textId ?? "",
    relevantIds: [d.id],
  }));
  const mono = strideSample(withId, counts.monolingual).map((d) => ({
    id: `mono-${d.id}`,
    text: d.textAr,
    relevantIds: [d.id],
  }));
  const idfb = strideSample(withId, counts.idTrack).map((d) => ({
    id: `idfb-${d.id}`,
    text: d.textId ?? "",
    relevantIds: [d.id],
  }));
  void fingerprint;
  return { crossLingual: cross, monolingual: mono, idFallback: idfb };
}

/** Parse raw edition JSON texts into the collection-keyed map build expects. */
export function parseEditions(
  editions: readonly { collection: HadithCollection; arabicText: string; indonesianText: string }[],
): { arabic: Record<string, unknown>; indonesian: Record<string, unknown> } {
  const arabic: Record<string, unknown> = {};
  const indonesian: Record<string, unknown> = {};
  for (const e of editions) {
    arabic[e.collection] = parseHadithEdition(e.collection, "arabic", JSON.parse(e.arabicText));
    indonesian[e.collection] = parseHadithEdition(
      e.collection,
      "indonesian",
      JSON.parse(e.indonesianText),
    );
  }
  return { arabic, indonesian };
}

export { HADITH_COLLECTIONS, type HadithCorpus };
