import { TOTAL_SURAHS } from "./quran-source";
import {
  normalizeSurahText,
  SURAH_AYAH_COUNTS,
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
 *    `surat ke-2` (all spellings survive normalization). The verse is kept
 *    only when the surah actually has it (the per-surah Tanzil counts): a
 *    question asking about `QS. 1:999` references surah 1, and the trace never
 *    names a verse that does not exist.
 * 2. A surah name immediately preceded by `surah`/`surat` (optionally `ke`),
 *    in any of its marker-gated spellings: canonical (`surah Al-Fatihah`),
 *    article-stripped (`surat Fatihah`), space-insensitive compact
 *    (`surat Yasin`, `surat Annas`), elongation-collapsed (`surat Yaa Siin`)
 *    or an explicit table alias (`surat Thaha`).
 *
 * A bare name is **not** a reference, even in its definite-article form.
 * Almost every surah name is also an ordinary Arabic word or a divine name,
 * and the Golden Set proves it: `gs-v0-012` ("Apa makna asmaul husna
 * Ar-Rahman dan Ar-Rahim?") asks about the *name of Allah*, not Surah
 * Ar-Rahman, so an article-form match would have expanded an unrelated surah
 * into a question that named none. Article-less names (`Muhammad`, `Yunus`,
 * `Maryam`, `Nuh`, `Sad`) and article-stripped short forms (`ikhlas`, `qadr`,
 * `asr`, `nas`, `tin`) are worse still. The marker is what makes a name a
 * reference — and it is also what makes every spelling variant above safe:
 * `surat Thaha` is unambiguous in a way bare `Thaha` never is. Bare-name
 * recognition is a recorded trade-off with a revisit trigger (ADR-0045), not
 * an oversight. Arabic-script names (`سورة الفاتحة`) are not recognised — the
 * table is Latin transliteration only — and a Latin variant no table rule
 * reaches (`Yaseen`, `Fatehah`) is a recorded revisit trigger, never a fuzzy
 * match.
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

/**
 * True when the surah actually has this ayah. The counts are the domain
 * pack's own static Tanzil data (`SURAH_AYAH_COUNTS`), so detection needs no
 * store read — and an address the surah cannot have degrades to the surah,
 * never to a phantom verse on the trace.
 */
function isAyahInSurah(surah: number, ayah: number): boolean {
  const count = SURAH_AYAH_COUNTS[surah - 1];
  return Number.isInteger(ayah) && ayah >= 1 && count !== undefined && ayah <= count;
}

/** The earliest explicit numeric address in the normalized question, if any. */
function firstNumericReference(q: string): { index: number; ref: SurahReference } | null {
  const verse = QS_VERSE.exec(q);
  if (verse) {
    const surah = Number(verse[1]);
    const ayah = Number(verse[2]);
    if (isSurahNumber(surah)) {
      // The expansion reads the surah either way, so an impossible verse is
      // not a failed reference: it is a surah reference whose verse the trace
      // must not claim (`QS. 1:999` records surah 1, not verse 999).
      return {
        index: verse.index,
        ref: isAyahInSurah(surah, ayah) ? { surah, ayah } : { surah },
      };
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
 * Every marker-gated comparison form of one name: its canonical normalized
 * words, the article-stripped words, the space-insensitive compact of either
 * (`ya sin` → `yasin`, `an nas` → `annas` — the common one-word
 * transliteration of a two-word name), and the table's explicit aliases
 * (`Thaha`). Every form is still only matched after a `surah`/`surat` marker
 * (see the module comment), which is exactly what keeps the widening safe:
 * `surat Thaha` is unambiguous, bare `Thaha` would not be.
 */
function nameForms(canonical: string, aliases: readonly string[]): string[] {
  const forms = new Set<string>();
  const bare = withoutArticle(canonical);
  for (const form of [canonical, bare]) {
    if (form === "") continue;
    forms.add(form);
    // Only a multi-word name has a compact variant — the space is the thing
    // the one-word spelling drops.
    if (form.includes(" ")) forms.add(form.replace(/ /g, ""));
  }
  for (const alias of aliases) {
    const normalized = normalizeSurahText(alias);
    if (normalized === "") continue;
    forms.add(normalized);
    const aliasBare = withoutArticle(normalized);
    if (aliasBare !== "") forms.add(aliasBare);
  }
  return [...forms];
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
    for (const form of nameForms(canonical, entry.aliases ?? [])) {
      let from = 0;
      for (;;) {
        const index = padded.indexOf(` ${form} `, from);
        if (index < 0) break;
        if (hasSurahMarkerBefore(padded, index)) {
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
