/**
 * The Quran's surah-name vocabulary (KajianQ domain pack, ADR-0045).
 *
 * `detectSurahReference` needs to recognise a surah a question names, and the
 * corpus's own surah metadata (`doc_parents.metadata.surahName`) is not
 * readable before retrieval — so the domain pack carries the name list it
 * matches against. This is a fixed list of 114 proper nouns in their standard
 * Latin transliteration, hand-maintained here; it is *not* corpus data
 * (nothing in `NOTICES/DATASETS.md` describes it) and deliberately excludes the
 * Kemenag Indonesian translated names, whose redistribution is still gated by
 * human prerequisite #2.
 *
 * The table is the authoritative name source for reference detection. It is
 * keyed by Tanzil number, the same key the ingestion writes onto every surah
 * parent (`surahSourceKey`) and every ayah child (`citation.surah`), so a
 * detected reference and the corpus agree by number, never by string.
 *
 * It also carries the per-surah ayah counts (`SURAH_AYAH_COUNTS`) the detector
 * validates an explicit address against, so a question can never put an
 * impossible verse (`QS. 1:999`) on the trace. The counts are static Tanzil
 * domain data, cross-checked in test against the committed surah-list fixture
 * (`src/fixtures/surah_list.json`) and the corpus total (`TOTAL_AYAHS`).
 */

/** One surah's canonical Latin name, keyed by Tanzil number (1–114). */
export type SurahName = {
  number: number;
  name: string;
  /**
   * Additional marker-gated spellings no general rule reaches — the
   * well-attested one-word Latin variants of a two-word canonical name
   * (`Thaha` for Ta-Ha). Only ever matched after `surah`/`surat`, like every
   * name form; kept explicit rather than inferred, so an alias is a reviewed
   * table edit with a test, never a fuzzy rule.
   */
  aliases?: readonly string[];
};

/**
 * The 114 surah names, Tanzil order. `number` is the address the corpus uses;
 * `name` is the canonical transliteration the detector normalizes.
 */
export const SURAH_NAMES: readonly SurahName[] = [
  { number: 1, name: "Al-Fatihah" },
  { number: 2, name: "Al-Baqarah" },
  { number: 3, name: "Ali 'Imran" },
  { number: 4, name: "An-Nisa" },
  { number: 5, name: "Al-Ma'idah" },
  { number: 6, name: "Al-An'am" },
  { number: 7, name: "Al-A'raf" },
  { number: 8, name: "Al-Anfal" },
  { number: 9, name: "At-Taubah" },
  { number: 10, name: "Yunus" },
  { number: 11, name: "Hud" },
  { number: 12, name: "Yusuf" },
  { number: 13, name: "Ar-Ra'd" },
  { number: 14, name: "Ibrahim" },
  { number: 15, name: "Al-Hijr" },
  { number: 16, name: "An-Nahl" },
  { number: 17, name: "Al-Isra" },
  { number: 18, name: "Al-Kahf" },
  { number: 19, name: "Maryam" },
  { number: 20, name: "Ta-Ha", aliases: ["Taha", "Thaha"] },
  { number: 21, name: "Al-Anbiya" },
  { number: 22, name: "Al-Hajj" },
  { number: 23, name: "Al-Mu'minun" },
  { number: 24, name: "An-Nur" },
  { number: 25, name: "Al-Furqan" },
  { number: 26, name: "Ash-Shu'ara" },
  { number: 27, name: "An-Naml" },
  { number: 28, name: "Al-Qasas" },
  { number: 29, name: "Al-'Ankabut" },
  { number: 30, name: "Ar-Rum" },
  { number: 31, name: "Luqman" },
  { number: 32, name: "As-Sajdah" },
  { number: 33, name: "Al-Ahzab" },
  { number: 34, name: "Saba" },
  { number: 35, name: "Fatir" },
  { number: 36, name: "Ya-Sin" },
  { number: 37, name: "As-Saffat" },
  { number: 38, name: "Sad" },
  { number: 39, name: "Az-Zumar" },
  { number: 40, name: "Ghafir" },
  { number: 41, name: "Fussilat" },
  { number: 42, name: "Ash-Shura" },
  { number: 43, name: "Az-Zukhruf" },
  { number: 44, name: "Ad-Dukhan" },
  { number: 45, name: "Al-Jathiyah" },
  { number: 46, name: "Al-Ahqaf" },
  { number: 47, name: "Muhammad" },
  { number: 48, name: "Al-Fath" },
  { number: 49, name: "Al-Hujurat" },
  { number: 50, name: "Qaf" },
  { number: 51, name: "Adh-Dhariyat" },
  { number: 52, name: "At-Tur" },
  { number: 53, name: "An-Najm" },
  { number: 54, name: "Al-Qamar" },
  { number: 55, name: "Ar-Rahman" },
  { number: 56, name: "Al-Waqi'ah" },
  { number: 57, name: "Al-Hadid" },
  { number: 58, name: "Al-Mujadilah" },
  { number: 59, name: "Al-Hashr" },
  { number: 60, name: "Al-Mumtahanah" },
  { number: 61, name: "As-Saff" },
  { number: 62, name: "Al-Jumu'ah" },
  { number: 63, name: "Al-Munafiqun" },
  { number: 64, name: "At-Taghabun" },
  { number: 65, name: "At-Talaq" },
  { number: 66, name: "At-Tahrim" },
  { number: 67, name: "Al-Mulk" },
  { number: 68, name: "Al-Qalam" },
  { number: 69, name: "Al-Haqqah" },
  { number: 70, name: "Al-Ma'arij" },
  { number: 71, name: "Nuh" },
  { number: 72, name: "Al-Jinn" },
  { number: 73, name: "Al-Muzzammil" },
  { number: 74, name: "Al-Muddaththir" },
  { number: 75, name: "Al-Qiyamah" },
  { number: 76, name: "Al-Insan" },
  { number: 77, name: "Al-Mursalat" },
  { number: 78, name: "An-Naba" },
  { number: 79, name: "An-Nazi'at" },
  { number: 80, name: "'Abasa" },
  { number: 81, name: "At-Takwir" },
  { number: 82, name: "Al-Infitar" },
  { number: 83, name: "Al-Mutaffifin" },
  { number: 84, name: "Al-Inshiqaq" },
  { number: 85, name: "Al-Buruj" },
  { number: 86, name: "At-Tariq" },
  { number: 87, name: "Al-A'la" },
  { number: 88, name: "Al-Ghashiyah" },
  { number: 89, name: "Al-Fajr" },
  { number: 90, name: "Al-Balad" },
  { number: 91, name: "Ash-Shams" },
  { number: 92, name: "Al-Lail" },
  { number: 93, name: "Ad-Duha" },
  { number: 94, name: "Ash-Sharh" },
  { number: 95, name: "At-Tin" },
  { number: 96, name: "Al-'Alaq" },
  { number: 97, name: "Al-Qadr" },
  { number: 98, name: "Al-Bayyinah" },
  { number: 99, name: "Az-Zalzalah" },
  { number: 100, name: "Al-'Adiyat" },
  { number: 101, name: "Al-Qari'ah" },
  { number: 102, name: "At-Takathur" },
  { number: 103, name: "Al-'Asr" },
  { number: 104, name: "Al-Humazah" },
  { number: 105, name: "Al-Fil" },
  { number: 106, name: "Quraish" },
  { number: 107, name: "Al-Ma'un" },
  { number: 108, name: "Al-Kautsar" },
  { number: 109, name: "Al-Kafirun" },
  { number: 110, name: "An-Nasr" },
  { number: 111, name: "Al-Masad" },
  { number: 112, name: "Al-Ikhlas" },
  { number: 113, name: "Al-Falaq" },
  { number: 114, name: "An-Nas" },
];

/**
 * The ayah count of each surah, Tanzil order (index 0 = surah 1). The
 * detector uses them to bound an explicit verse address: a count that does not
 * exist must never reach the trace as if it did (`QS. 1:999` names surah 1,
 * not a verse). Static domain data, not corpus rows — the corpus's own
 * `count_ayat` arrives with the ingest source, and this table exists so
 * detection needs no store read. Pinned in `surah-reference.test.ts` against
 * the committed Tanzil surah-list fixture (surahs 1/112/113/114) and against
 * `TOTAL_AYAHS` (Σ = 6,236 — a typo anywhere breaks the sum).
 */
export const SURAH_AYAH_COUNTS: readonly number[] = [
  7, 286, 200, 176, 120, 165, 206, 75, 129, 109, 123, 111, 43, 52, 99, 128, 111, 110, 98, 135, 112,
  78, 118, 64, 77, 227, 93, 88, 69, 60, 34, 30, 73, 54, 45, 83, 182, 88, 75, 85, 54, 53, 89, 59, 37,
  35, 38, 29, 18, 45, 60, 49, 62, 55, 78, 96, 29, 22, 24, 13, 14, 11, 11, 18, 12, 12, 30, 52, 52,
  44, 28, 28, 20, 56, 40, 31, 50, 40, 46, 42, 29, 19, 36, 25, 22, 17, 19, 26, 30, 20, 15, 21, 11, 8,
  8, 19, 5, 8, 8, 11, 11, 8, 3, 9, 5, 4, 7, 3, 6, 3, 5, 4, 5, 6,
];

/**
 * The transliterated Arabic definite article as a leading word, longest first
 * so `ash` is matched before `as`. Used only by the detector's "does this name
 * carry an article" test; the article itself is dropped by normalization.
 */
export const NAME_PREFIX_ARTICLES: readonly string[] = [
  "adh",
  "ash",
  "ath",
  "asy",
  "al",
  "an",
  "ar",
  "as",
  "at",
  "az",
  "ad",
];

/**
 * Normalize a name or a question into the single comparison form: lowercase,
 * combining diacritics stripped, apostrophes dropped (so `Ma'idah` and
 * `Maidah` agree), repeated vowels collapsed to one (so the transliteration
 * elongation `yaa siin` reads as `ya sin` — ADR-0045's marker-gated spelling
 * rules), every other non-alphanumeric run collapsed to one space.
 */
export function normalizeSurahText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc\u02bb'`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/([aeiou])\1+/g, "$1")
    .trim();
}

/** The leading definite article of a normalized name, or null when it has none. */
export function leadingArticle(normalizedName: string): string | null {
  for (const article of NAME_PREFIX_ARTICLES) {
    if (normalizedName === article || normalizedName.startsWith(`${article} `)) {
      return article;
    }
  }
  return null;
}

/** The normalized name with its leading definite article removed. */
export function withoutArticle(normalizedName: string): string {
  const article = leadingArticle(normalizedName);
  return article === null ? normalizedName : normalizedName.slice(article.length).trim();
}
