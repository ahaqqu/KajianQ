import type { MorphToken } from "@app/contracts";
import { TOTAL_SURAHS, TOTAL_AYAHS, type QuranAyah, type QuranSurahMeta } from "./quran-source";

/**
 * Parsers for the Quran corpus sources (#6).
 *
 * Two upstream formats, both keyed to Tanzil numbering (the alignment key):
 *
 *  - **Surah JSON** (per-surah array files): Uthmani Arabic `teks_ayat` plus
 *    the verified Indonesian translation `teks_terjemah`, with surah-level
 *    metadata in a `surah_list.json` companion. HTML tags/footnote markers in
 *    the translation are stripped into a *new* cleaned field — the raw text
 *    is preserved verbatim upstream as `text_raw` (AGENTS.md rule 11).
 *  - **Quranic Arabic Corpus morphology** (tab-separated, Buckwalter-ish
 *    transliteration): per-token lemma+root keyed `(surah:ayah:word:segment)`
 *    (ADR-0014 — GPL, build dependency, stored alongside the Arabic text).
 *
 * Kemenag licensing (human prerequisite #2) gates *redistribution* of the raw
 * translation, not ingestion: the raw archive lives in R2 at runtime, never
 * committed to the repo.
 */

/** One ayah row of a per-surah JSON file. */
export type SurahFileAyah = {
  id_ayat: number;
  no_surah: number;
  no_ayat: number;
  teks_ayat: string;
  teks_terjemah: string;
};

/** Strip HTML tags and footnote references from a translation string. */
export function cleanTranslation(raw: string): string {
  return raw
    .replace(/<sup>\d+\)?<\/sup>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse one per-surah JSON file into ayah rows (throws on shape drift). */
export function parseSurahFile(json: unknown): QuranAyah[] {
  if (!Array.isArray(json)) {
    throw new Error("quran source: surah file is not a JSON array");
  }
  return json.map((row) => {
    if (typeof row !== "object" || row === null) {
      throw new Error("quran source: surah file row is not an object");
    }
    const r = row as Partial<SurahFileAyah>;
    if (
      typeof r.no_surah !== "number" ||
      typeof r.no_ayat !== "number" ||
      typeof r.teks_ayat !== "string" ||
      typeof r.teks_terjemah !== "string"
    ) {
      throw new Error("quran source: surah file row missing required fields");
    }
    return {
      surah: r.no_surah,
      ayah: r.no_ayat,
      textAr: r.teks_ayat,
      textId: cleanTranslation(r.teks_terjemah),
    } satisfies QuranAyah;
  });
}

/** Surah-list entry shape from `surah_list.json`. */
export type SurahListEntry = {
  id?: number;
  surat_name?: string;
  surat_rename?: string;
  surat_terjemahan?: string;
  count_ayat?: number;
};

/**
 * Parse the surah-list companion file into surah metadata. No count gate
 * here: subset runs (tests, `--limit`) legitimately carry a partial list,
 * and `buildCorpus` owns the count/coverage assertions against the ayah
 * files actually being ingested.
 */
export function parseSurahList(json: unknown): QuranSurahMeta[] {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error("quran source: surah list is not a JSON object");
  }
  const record = json as Record<string, SurahListEntry>;
  return Object.values(record).map((entry) => ({
    number: entry.id ?? 0,
    name: entry.surat_rename ?? entry.surat_name ?? "",
    nameId: entry.surat_terjemahan ?? null,
    ayahCount: entry.count_ayat ?? 0,
  }));
}

/**
 * Integrity check 1 (issue #6 AC): all expected ayah present with Arabic
 * text, translation, and surah/ayah metadata. Throws on the first violation
 * — a truncated or shifted parse must fail loudly, never ingest silently.
 *
 * `expected` defaults to the full Tanzil corpus (114 surahs / 6,236 ayahs);
 * callers that intentionally ingest a subset (tests, `--limit` runs) pass
 * their own totals so the check stays exact for what is being ingested —
 * a genuinely truncated corpus still fails the `ayahs` count.
 */
export function assertAyahIntegrity(
  ayahs: readonly QuranAyah[],
  surahs: readonly QuranSurahMeta[],
  expected: { surahs?: number; ayahs?: number } = {},
): void {
  const expectedSurahs = expected.surahs ?? TOTAL_SURAHS;
  const expectedAyahs = expected.ayahs ?? TOTAL_AYAHS;
  if (surahs.length !== expectedSurahs) {
    throw new Error(`quran integrity: expected ${expectedSurahs} surahs, got ${surahs.length}`);
  }
  if (ayahs.length !== expectedAyahs) {
    throw new Error(`quran integrity: expected ${expectedAyahs} ayahs, got ${ayahs.length}`);
  }
  const seen = new Set<string>();
  for (const surah of surahs) {
    if (surah.number < 1 || surah.number > TOTAL_SURAHS) {
      throw new Error(`quran integrity: surah number out of range: ${surah.number}`);
    }
  }
  for (const ayah of ayahs) {
    if (ayah.surah < 1 || ayah.surah > TOTAL_SURAHS) {
      throw new Error(`quran integrity: ayah surah out of range: ${ayah.surah}`);
    }
    if (ayah.ayah < 1) {
      throw new Error(`quran integrity: ayah number out of range: ${ayah.ayah}`);
    }
    if (ayah.textAr.trim().length === 0) {
      throw new Error(`quran integrity: ${ayah.surah}:${ayah.ayah} has no Arabic text`);
    }
    if (ayah.textId.trim().length === 0) {
      throw new Error(`quran integrity: ${ayah.surah}:${ayah.ayah} has no translation`);
    }
    const key = `${ayah.surah}:${ayah.ayah}`;
    if (seen.has(key)) {
      throw new Error(`quran integrity: duplicate ayah ${key}`);
    }
    seen.add(key);
  }
}

/**
 * Parse the Quranic Arabic Corpus morphology TSV. Lines starting with `#`
 * are the GPL copyright header (preserved in the archive; not parsed as
 * data). Each data line is `LOCATION\tFORM\tTAG\tFEATURES` where LOCATION is
 * `(surah:ayah:word:segment)`. Lemma/root come from the FEATURES column's
 * `LEM:`/`ROOT:` slots (affixes carry none).
 */
export function parseMorphology(text: string): Map<string, MorphToken[]> {
  const byAyah = new Map<string, MorphToken[]>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.length === 0 || line.startsWith("#")) continue;
    // The file's column-header row (LOCATION\tFORM\tTAG\tFEATURES) is not data.
    if (line.startsWith("LOCATION\t")) continue;
    const parts = line.split("\t");
    if (parts.length < 4) {
      throw new Error(`quran morphology: malformed line: ${line.slice(0, 60)}`);
    }
    const [loc, form, tag, features] = parts as [string, string, string, string];
    const locMatch = /^\((\d+):(\d+):(\d+):(\d+)\)$/.exec(loc ?? "");
    if (!locMatch) {
      throw new Error(`quran morphology: malformed location: ${loc}`);
    }
    const [, surahS, ayahS, wordS, segmentS] = locMatch;
    const lemma = /(?:^|\|)LEM:([^|]+)/.exec(features ?? "")?.[1];
    const root = /(?:^|\|)ROOT:([^|]+)/.exec(features ?? "")?.[1];
    const type = /^STEM/.test(features ?? "") ? "STEM" : /^SUFFIX/.test(features ?? "") ? "SUFFIX" : "PREFIX";
    const key = `${Number(surahS)}:${Number(ayahS)}`;
    const list = byAyah.get(key) ?? [];
    list.push({
      word: Number(wordS),
      segment: Number(segmentS),
      form: form ?? "",
      type,
      ...(lemma !== undefined ? { lemma } : {}),
      ...(root !== undefined ? { root } : {}),
      pos: tag ?? "",
    });
    byAyah.set(key, list);
  }
  return byAyah;
}

/**
 * Integrity check 2 (issue #6 AC): the morphology covers every ayah — the
 * corpus is keyed to the same diacritized Uthmani text, so a missing ayah in
 * the morphology means the join would silently drop lemma/root evidence.
 * Returns the list of missing ayah keys (empty when coverage is complete).
 */
export function missingMorphologyCoverage(
  ayahs: readonly QuranAyah[],
  morphology: Map<string, readonly MorphToken[]>,
): string[] {
  const missing: string[] = [];
  for (const ayah of ayahs) {
    const tokens = morphology.get(`${ayah.surah}:${ayah.ayah}`);
    if (tokens === undefined || tokens.length === 0) {
      missing.push(`${ayah.surah}:${ayah.ayah}`);
    }
  }
  return missing;
}

/**
 * Word-count consistency between the Uthmani text's whitespace tokens (minus
 * standalone waqf/annotation marks) and the morphology's word count. The two
 * sources use different segmentation conventions in ~1% of ayahs (e.g.
 * Tanzil splits a clitic the corpus joins), so this returns *diffs* for the
 * report rather than throwing — the (surah, ayah) number key remains the
 * authoritative join, and diffs are surfaced, never force-merged (AGENTS.md
 * rule: disputed alignment is labeled, never merged).
 */
export function morphologyWordCountDiffs(
  ayahs: readonly QuranAyah[],
  morphology: Map<string, readonly MorphToken[]>,
): { key: string; textTokens: number; corpusWords: number }[] {
  const diffs: { key: string; textTokens: number; corpusWords: number }[] = [];
  for (const ayah of ayahs) {
    const tokens = morphology.get(`${ayah.surah}:${ayah.ayah}`);
    if (tokens === undefined) continue;
    const corpusWords = new Set(tokens.map((t) => t.word)).size;
    const textTokens = ayah.textAr.split(/\s+/).filter((t) => !isWaqfOnlyToken(t)).length;
    if (textTokens !== corpusWords) {
      diffs.push({ key: `${ayah.surah}:${ayah.ayah}`, textTokens, corpusWords });
    }
  }
  return diffs;
}

/** True when a whitespace token is only Quranic annotation marks, not a word. */
function isWaqfOnlyToken(token: string): boolean {
  for (const ch of token) {
    const o = ch.codePointAt(0) ?? 0;
    if (o === 0x0670) continue; // dagger alif alone is not a word
    // A real Arabic letter means the token is a word, not a mark.
    if ((o >= 0x0621 && o <= 0x064a) || o === 0x0671) return false;
    if (o >= 0x0651 && o <= 0x065f) continue; // shadda + harakat
    if (o === 0x0640) continue; // tatweel
    if (o >= 0x0610 && o <= 0x061a) continue; // arabic signs
    if (o >= 0x06d6 && o <= 0x06ed) continue; // waqf marks
    if (o >= 0x06df && o <= 0x06e8) continue; // small marks
    if (o >= 0x06ea && o <= 0x06ec) continue; // empty centre marks
    if (o >= 0x08d0 && o <= 0x08db) continue; // quranic annotation marks
    if (o === 0x08e2 || o === 0x06dd || o === 0x06d4 || o === 0x06d5) continue;
    if (o === 0x08f0 || o === 0x08f1 || o === 0x08f2) continue;
    return false;
  }
  return true;
}