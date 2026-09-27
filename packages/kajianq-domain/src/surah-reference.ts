import { TOTAL_SURAHS } from "./quran-source";
import {
  leadingArticle,
  normalizeSurahText,
  SURAH_NAMES,
  withoutArticle,
  type SurahName,
} from "./surah-names";

/**
 * Surah/verse-reference detection (KajianQ domain pack, ADR-0045).
 *
 * The product defect this closes: a whole-surah question ("What does Surah
 * Al-Fatihah mean and why is it recited in every prayer?" — Golden Set
 * `gs-v0-015`) retrieved no part of that surah at all, because a short
 * formulaic verse (`QS. 1:1`) is a poor semantic neighbour of a meta-question
 * about the surah and sits far outside an HNSW scan. The fix retrieves the
 * named surah's children deterministically, so the question must first be
 * *recognised* as naming a surah — which is Islamic-domain logic and lives
 * here, never in the engine (dars-pluggability rule 1).
 *
 * Detection is pure string work on the **verbatim question**, never on the
 * router's model-generated sub-queries: the flake this closes (#241) was a
 * paraphrase of a sub-query moving the verses across the retrieval boundary,
 * so keying on a paraphrase would reproduce the nondeterminism.
 *
 * Recognition rules (deliberately conservative — a wrong expansion spends
 * context, so only a clear reference matches):
 *
 * 1. An explicit address: `QS. 2:255`, `Q.S. 2`, `QS 2`, `surah 2`,
 *    `surat ke-2` (all spellings survive normalization).
 * 2. A surah name in its definite-article form (`Al-Baqarah`, `An-Nas`,
 *    `Ash-Shu'ara`), which is distinctive enough on its own.
 * 3. Any surah name immediately preceded by `surah`/`surat` (optionally
 *    `ke`): `surah Muhammad`, `surat Ya-Sin`, `surah Ikhlas`.
 *
 * Anything else does not match, on purpose. Article-less names are common
 * personal and place words (`Muhammad`, `Yunus`, `Maryam`, `Nuh`, `Sad`), and
 * article-stripped short forms are ordinary Indonesian words (`ikhlas`,
 * `qadr`, `asr`, `nas`, `tin`), so a bare occurrence is only ever read as a
 * reference when the user wrote the marker that makes it one. Arabic-script
 * names (`سورة الفاتحة`) are not recognised — the table is Latin
 * transliteration only; that is a stated limitation, not a silent gap.
 */

/** A surah reference detected in a question: the surah, and the verse if named. */
export type SurahReference = {
  /** Tanzil surah number (1–114) — the address the corpus keys on. */
  surah: number;
  /** Tanzil ayah number when the question named a specific verse. */
  ayah?: number;
};

/**
 * Explicit-address grammars over the *normalized* text (punctuation already
 * collapsed to spaces): `qs 2 255`, `q s 2`, `qs 2`. Literal patterns, never
 * compiled from a variable — the ReDoS shape the security scan blocks.
 */
const QS_VERSE = /\bq\s?s\s+(\d{1,3})\s+(\d{1,3})\b/;
const QS_SURAH = /\bq\s?s\s+(\d{1,3})\b/;
/** `surah 2`, `surat 2`, `surah ke 2`, `surat ke-2` (hyphen → space). */
const MARKER_NUMBER = /\b(?:surah|surat)\s+(?:ke\s+)?(\d{1,3})\b/;

/** True when a number is a real Tanzil surah address. */
function isSurahNumber(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= TOTAL_SURAHS;
}

/** The earliest explicit numeric address in the normalized question, if any. */
function firstNumericReference(q: string): { index: number; ref: SurahReference } | null {
  const verse = QS_VERSE.exec(q);
  if (verse) {
    const surah = Number(verse[1]);
    const ayah = Number(verse[2]);
    if (isSurahNumber(surah) && Number.isInteger(ayah) && ayah >= 1) {
      return { index: verse.index, ref: { surah, ayah } };
    }
  }
  for (const pattern of [QS_SURAH, MARKER_NUMBER]) {
    const match = pattern.exec(q);
    if (match) {
      const surah = Number(match[1]);
      if (isSurahNumber(surah)) return { index: match.index, ref: { surah } };
    }
  }
  return null;
}

/** The words immediately before `index` are `surah`/`surat` (maybe + `ke`). */
function hasSurahMarkerBefore(padded: string, index: number): boolean {
  const words = padded
    .slice(0, index)
    .trim()
    .split(" ")
    .filter((w) => w !== "");
  const n = words.length;
  if (n === 0) return false;
  if (words[n - 1] === "surah" || words[n - 1] === "surat") return true;
  return words[n - 1] === "ke" && n >= 2 && (words[n - 2] === "surah" || words[n - 2] === "surat");
}

/**
 * The earliest surah name in the normalized question that satisfies the
 * marker rules. Scans the name table directly (word-boundary phrase lookup
 * with padded spaces) rather than compiling a pattern per name.
 */
function firstNamedReference(
  q: string,
  names: readonly SurahName[],
): { index: number; ref: SurahReference } | null {
  const padded = ` ${q} `;
  let best: { index: number; ref: SurahReference } | null = null;
  const consider = (index: number, surah: number) => {
    if (best === null || index < best.index) best = { index, ref: { surah } };
  };
  for (const entry of names) {
    const canonical = normalizeSurahText(entry.name);
    if (canonical === "") continue;
    // The canonical name may match on its own only when it carries the
    // transliterated definite article; the article-stripped (or article-less)
    // form needs the explicit `surah`/`surat` marker.
    const forms: { form: string; allowedAlone: boolean }[] = [
      { form: canonical, allowedAlone: leadingArticle(canonical) !== null },
    ];
    const bare = withoutArticle(canonical);
    if (bare !== canonical && bare !== "") forms.push({ form: bare, allowedAlone: false });
    for (const { form, allowedAlone } of forms) {
      let from = 0;
      for (;;) {
        const index = padded.indexOf(` ${form} `, from);
        if (index < 0) break;
        if (allowedAlone || hasSurahMarkerBefore(padded, index)) {
          consider(index, entry.number);
          break;
        }
        from = index + 1;
      }
    }
  }
  return best;
}

/**
 * Detect the surah (and verse, when named) a question references, or null
 * when it names none. The earliest reference in the question wins, so a
 * comparison naming two surahs expands the first — the expansion is bounded
 * to one scope by design (ADR-0045).
 */
export function detectSurahReference(
  text: string,
  names: readonly SurahName[] = SURAH_NAMES,
): SurahReference | null {
  const q = normalizeSurahText(text ?? "");
  if (q === "") return null;
  const candidates: { index: number; ref: SurahReference }[] = [];
  const numeric = firstNumericReference(q);
  if (numeric !== null) candidates.push(numeric);
  const named = firstNamedReference(q, names);
  if (named !== null) candidates.push(named);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.index - b.index);
  return candidates[0]?.ref ?? null;
}
