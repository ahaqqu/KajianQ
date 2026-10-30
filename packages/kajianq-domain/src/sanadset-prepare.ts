/**
 * Row preparation for the Sanadset study: slice selection, the pre-registered
 * quarantine rules, chain parsing, and the folded matn/trigrams/signature every
 * later stage consumes. A row that cannot be parsed is quarantined with its rule
 * and row identity; it is never dropped and never force-merged.
 *
 * The accumulator shape exists because the source file is read as a stream: one
 * row is classified at a time and only slice rows are retained.
 */

import { lshBandKeys, minhashSignature } from "./sanadset-blocking";
import { parseSanadList } from "./sanadset-csv";
import { matnKeyOf } from "./sanadset-ingest-content";
import { hasNestedSanad, hasUnbalancedTags, isNoSanad } from "./sanadset-tags";
import {
  foldNarratorName,
  isReferenceOnlyMatn,
  matnTrigrams,
  normalizeMatnText,
} from "./sanadset-text";

/** The two exact `Book` values of the Sahihayn slice; substring matching pulls in other works. */
export const SLICE_BOOKS = [
  "\u0635\u062d\u064a\u062d \u0627\u0644\u0628\u062e\u0627\u0631\u064a",
  "\u0635\u062d\u064a\u062d \u0645\u0633\u0644\u0645",
] as const;
export type SliceBook = (typeof SLICE_BOOKS)[number];
const SLICE_BOOK_SET = new Set<string>(SLICE_BOOKS);

export function isSliceBook(book: string): book is SliceBook {
  return SLICE_BOOK_SET.has(book);
}

export type SanadsetSourceRow = {
  /** Zero-based record index in the CSV, header excluded (independent of quoted newlines). */
  readonly rowIndex: number;
  readonly book: string;
  readonly hadithNumber: string;
  readonly hadith: string;
  readonly matn: string;
  readonly sanad: string;
  readonly sanadLength: number | null;
};

export type QuarantineRule =
  | "nested_sanad_in_matn"
  | "invalid_sanad_length"
  | "implausible_chain_length"
  | "sanad_parse_failure"
  | "chain_shorter_than_expected"
  | "empty_narrator_name"
  | "empty_matn"
  | "reference_only_matn"
  | "ambiguous_best_match"
  | "truncated_candidate_search"
  | "fragmentary_containment"
  | "model_uncertain";

export type QuarantinedRow = {
  readonly rowIndex: number;
  readonly book: string;
  readonly hadithNumber: string;
  readonly rule: QuarantineRule;
  readonly detail: string;
  readonly sanadLength: number | null;
};

export type PreparedRow = {
  readonly rowIndex: number;
  readonly book: SliceBook;
  readonly hadithNumber: string;
  readonly rawMatn: string;
  /** Content identity of {@link rawMatn}: the child write key across runs. */
  readonly matnKey: string;
  readonly normalizedMatn: string;
  readonly trigrams: readonly string[];
  readonly signature: readonly number[];
  readonly bandKeys: readonly string[];
  /** Folded narrator names in chain order; empty folds are counted, not kept. */
  readonly chain: readonly string[];
  /** The raw surface of each folded name, in the same order (model prompts need it). */
  readonly rawChain: readonly string[];
};

export type BookStats = { rows: number; noSanad: number; quarantined: number; processed: number };
export type PrepareStats = {
  rows: number;
  noSanad: number;
  quarantined: number;
  processed: number;
  emptyNarratorNameMentions: number;
  /** Chains whose folded names repeat; the archive concatenates parallel isnads into one list. */
  repeatedNameChains: number;
  /** Rows whose `<MATN>` / `<SANAD>` open and close counts disagree: the tags do not describe them. */
  unbalancedTagRows: number;
  byBook: Record<SliceBook, BookStats>;
};
export type PrepareResult = {
  prepared: PreparedRow[];
  quarantined: QuarantinedRow[];
  stats: PrepareStats;
};

export type PrepareAccumulator = {
  /** Classify one source row; non-slice rows are ignored without being counted. */
  push(row: SanadsetSourceRow): void;
  /** The completed pass. Calling it twice returns the same result. */
  finish(): PrepareResult;
  readonly stats: PrepareStats;
};

const DETAIL_LIMIT = 160;

function truncateDetail(text: string): string {
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT - 3)}...` : text;
}

function emptyBookStats(): BookStats {
  return { rows: 0, noSanad: 0, quarantined: 0, processed: 0 };
}

export function createPrepareAccumulator(): PrepareAccumulator {
  const prepared: PreparedRow[] = [];
  const quarantined: QuarantinedRow[] = [];
  const byBook: Record<SliceBook, BookStats> = {
    [SLICE_BOOKS[0]]: emptyBookStats(),
    [SLICE_BOOKS[1]]: emptyBookStats(),
  };
  const stats: PrepareStats = {
    rows: 0,
    noSanad: 0,
    quarantined: 0,
    processed: 0,
    emptyNarratorNameMentions: 0,
    repeatedNameChains: 0,
    unbalancedTagRows: 0,
    byBook,
  };
  let finished: PrepareResult | null = null;

  const quarantine = (
    row: SanadsetSourceRow,
    book: SliceBook,
    rule: QuarantineRule,
    notes: string,
  ): void => {
    quarantined.push({
      rowIndex: row.rowIndex,
      book: row.book,
      hadithNumber: row.hadithNumber,
      rule,
      detail: truncateDetail(notes),
      sanadLength: row.sanadLength,
    });
    stats.quarantined += 1;
    byBook[book].quarantined += 1;
  };

  const classify = (row: SanadsetSourceRow, book: SliceBook): void => {
    if (isNoSanad(row.sanad)) {
      stats.noSanad += 1;
      byBook[book].noSanad += 1;
      return;
    }
    if (hasUnbalancedTags(row.hadith)) stats.unbalancedTagRows += 1;
    if (hasNestedSanad(row.hadith)) {
      quarantine(
        row,
        book,
        "nested_sanad_in_matn",
        "an opening <SANAD> appears inside a <MATN> span",
      );
      return;
    }
    const declared = row.sanadLength;
    if (declared === null || !Number.isInteger(declared) || declared < 0) {
      quarantine(
        row,
        book,
        "invalid_sanad_length",
        `Sanad_Length is not a non-negative integer: ${String(declared)}`,
      );
      return;
    }
    if (declared > 30) {
      quarantine(row, book, "implausible_chain_length", `Sanad_Length ${declared} exceeds 30`);
      return;
    }
    const names = parseSanadList(row.sanad);
    if (names === null) {
      quarantine(
        row,
        book,
        "sanad_parse_failure",
        "the Sanad column is not a Python list of strings",
      );
      return;
    }
    if (declared > 0 && names.length < 2) {
      quarantine(
        row,
        book,
        "chain_shorter_than_expected",
        `parsed ${names.length} name(s) for declared length ${declared}`,
      );
      return;
    }
    const chain: string[] = [];
    const rawChain: string[] = [];
    const seen = new Set<string>();
    let repeated = false;
    for (const name of names) {
      const folded = foldNarratorName(name);
      if (folded.length === 0) {
        stats.emptyNarratorNameMentions += 1;
        continue;
      }
      if (seen.has(folded)) repeated = true;
      seen.add(folded);
      chain.push(folded);
      rawChain.push(name.trim());
    }
    if (chain.length === 0) {
      quarantine(row, book, "empty_narrator_name", "no parsed name survived Arabic folding");
      return;
    }
    if (repeated) stats.repeatedNameChains += 1;
    const normalizedMatn = normalizeMatnText(row.matn);
    if (normalizedMatn.length === 0) {
      quarantine(row, book, "empty_matn", "the matn is empty after folding");
      return;
    }
    if (isReferenceOnlyMatn(normalizedMatn)) {
      quarantine(
        row,
        book,
        "reference_only_matn",
        "the matn is a cross-reference, not a text of its own",
      );
      return;
    }
    const trigrams = matnTrigrams(normalizedMatn);
    const signature = minhashSignature(trigrams);
    prepared.push({
      rowIndex: row.rowIndex,
      book,
      hadithNumber: row.hadithNumber,
      rawMatn: row.matn,
      matnKey: matnKeyOf(row.matn),
      normalizedMatn,
      trigrams,
      signature,
      bandKeys: lshBandKeys(signature),
      chain,
      rawChain,
    });
    stats.processed += 1;
    byBook[book].processed += 1;
  };

  return {
    stats,
    push(row: SanadsetSourceRow): void {
      if (!isSliceBook(row.book)) return;
      if (finished !== null) throw new Error("prepare: push after finish");
      stats.rows += 1;
      byBook[row.book].rows += 1;
      classify(row, row.book);
    },
    finish(): PrepareResult {
      finished ??= { prepared, quarantined, stats };
      return finished;
    },
  };
}
