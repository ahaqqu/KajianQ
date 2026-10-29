import { describe, expect, it } from "vite-plus/test";
import {
  createPrepareAccumulator,
  isSliceBook,
  prepareSanadsetRows,
  SLICE_BOOKS,
  type SanadsetSourceRow,
} from "./sanadset-prepare";

/**
 * Test intent, named before the assertions:
 * - trap: `Book` is matched by exact value. A substring filter pulls in al-Mustakhraj and
 *   stray titles (a known 3,400-row overcount), so a book whose title *contains* a slice
 *   title is asserted to be excluded;
 * - trap: `No SANAD` rows are declared by the archive and must be skipped, not
 *   quarantined — conflating them inflates the quarantine rate the gate reads;
 * - trap: a chain whose names fold to nothing must be quarantined rather than silently
 *   shortened, or a chain would look resolved when it lost narrators.
 */

const BUKHARI = SLICE_BOOKS[0];
const MUSLIM = SLICE_BOOKS[1];
const CHAIN = "['مالك بن أنس', 'نافع', 'عبد الله بن عمر']";

function row(overrides: Partial<SanadsetSourceRow> = {}): SanadsetSourceRow {
  return {
    rowIndex: 0,
    book: BUKHARI,
    hadithNumber: "1",
    hadith: "<SANAD>…</SANAD> <MATN> إنما الأعمال بالنيات </MATN>",
    matn: "إنما الأعمال بالنيات",
    sanad: CHAIN,
    sanadLength: 3,
    ...overrides,
  };
}

describe("the slice filter", () => {
  it("accepts only the two exact book titles", () => {
    expect(isSliceBook(BUKHARI)).toBe(true);
    expect(isSliceBook(MUSLIM)).toBe(true);
    expect(isSliceBook(`${BUKHARI} بن حبيب`)).toBe(false);
    expect(isSliceBook(`المستخرج على ${BUKHARI}`)).toBe(false);
    expect(isSliceBook("مسند الربيع بن حبيب")).toBe(false);
  });

  it("never prepares a non-slice row even when its title mentions a slice book", () => {
    const result = prepareSanadsetRows([row({ book: `المستخرج على ${BUKHARI}` })]);
    expect(result.prepared).toHaveLength(0);
    expect(result.quarantined).toHaveLength(0);
    expect(result.stats.rows).toBe(0);
  });
});

describe("the quarantine rules", () => {
  it("skips No SANAD rows without quarantining them", () => {
    const result = prepareSanadsetRows([row({ sanad: "No SANAD", sanadLength: 0 })]);
    expect(result.prepared).toHaveLength(0);
    expect(result.quarantined).toHaveLength(0);
    expect(result.stats.noSanad).toBe(1);
  });

  it("quarantines an implausible declared length", () => {
    const result = prepareSanadsetRows([row({ sanadLength: 31 })]);
    expect(result.quarantined[0]?.rule).toBe("implausible_chain_length");
  });

  it("quarantines a length that is not a non-negative integer", () => {
    expect(prepareSanadsetRows([row({ sanadLength: null })]).quarantined[0]?.rule).toBe(
      "invalid_sanad_length",
    );
    expect(prepareSanadsetRows([row({ sanadLength: -1 })]).quarantined[0]?.rule).toBe(
      "invalid_sanad_length",
    );
  });

  it("quarantines an unparseable Sanad column", () => {
    expect(prepareSanadsetRows([row({ sanad: "مالك، نافع" })]).quarantined[0]?.rule).toBe(
      "sanad_parse_failure",
    );
  });

  it("quarantines a chain shorter than its declared length", () => {
    const result = prepareSanadsetRows([row({ sanad: "['مالك']", sanadLength: 3 })]);
    expect(result.quarantined[0]?.rule).toBe("chain_shorter_than_expected");
  });

  it("quarantines a chain whose names all fold to nothing", () => {
    const result = prepareSanadsetRows([row({ sanad: "['ﷺ', 'رضي الله عنه']", sanadLength: 2 })]);
    expect(result.quarantined[0]?.rule).toBe("empty_narrator_name");
    expect(result.stats.emptyNarratorNameMentions).toBe(2);
  });

  it("quarantines a nested SANAD inside a MATN span", () => {
    const hadith = "<SANAD>a</SANAD> <MATN>first <SANAD>b</SANAD></MATN>";
    expect(prepareSanadsetRows([row({ hadith })]).quarantined[0]?.rule).toBe(
      "nested_sanad_in_matn",
    );
  });

  it("quarantines an empty matn and a reference-only matn", () => {
    expect(prepareSanadsetRows([row({ matn: "" })]).quarantined[0]?.rule).toBe("empty_matn");
    expect(prepareSanadsetRows([row({ matn: "مثله" })]).quarantined[0]?.rule).toBe(
      "reference_only_matn",
    );
  });
});

describe("a prepared row", () => {
  it("carries the folded chain, the raw surfaces, trigrams and band keys", () => {
    const prepared = prepareSanadsetRows([row()]).prepared[0];
    expect(prepared?.chain).toEqual(["مالك بن انس", "نافع", "عبد الله بن عمر"]);
    expect(prepared?.rawChain).toEqual(["مالك بن أنس", "نافع", "عبد الله بن عمر"]);
    expect(prepared?.normalizedMatn).toBe("انما الاعمال بالنيات");
    expect(prepared?.trigrams.length).toBeGreaterThan(0);
    expect(prepared?.bandKeys).toHaveLength(24);
    expect(prepared?.book).toBe(BUKHARI);
  });

  it("keeps raw surfaces aligned when one name folds to nothing", () => {
    const prepared = prepareSanadsetRows([row({ sanad: "['مالك', 'ﷺ', 'نافع']", sanadLength: 3 })])
      .prepared[0];
    expect(prepared?.chain).toEqual(["مالك", "نافع"]);
    expect(prepared?.rawChain).toEqual(["مالك", "نافع"]);
  });

  it("counts a chain that repeats a folded name instead of quarantining it", () => {
    const repeated = "['شعبة', 'محمد بن جعفر', 'شعبة', 'منصور']";
    const result = prepareSanadsetRows([row({ sanad: repeated, sanadLength: 4 })]);
    expect(result.prepared).toHaveLength(1);
    expect(result.stats.repeatedNameChains).toBe(1);
    expect(result.quarantined).toHaveLength(0);
  });
});

describe("the streaming accumulator", () => {
  it("classifies rows one at a time and reports the same result as the batch form", () => {
    const rows = [
      row({ rowIndex: 0 }),
      row({ rowIndex: 1, book: MUSLIM }),
      row({ rowIndex: 2, sanadLength: 99 }),
    ];
    const accumulator = createPrepareAccumulator();
    for (const entry of rows) accumulator.push(entry);
    const streamed = accumulator.finish();
    const batch = prepareSanadsetRows(rows);
    expect(streamed.prepared.map((entry) => entry.rowIndex)).toEqual(
      batch.prepared.map((entry) => entry.rowIndex),
    );
    expect(streamed.stats).toEqual(batch.stats);
    expect(streamed.quarantined.map((entry) => entry.rule)).toEqual(
      batch.quarantined.map((entry) => entry.rule),
    );
  });

  it("refuses a push after it has been finished", () => {
    const accumulator = createPrepareAccumulator();
    accumulator.push(row());
    accumulator.finish();
    expect(() => accumulator.push(row({ rowIndex: 1 }))).toThrow(/push after finish/u);
  });

  it("counts a row per book", () => {
    const result = prepareSanadsetRows([row(), row({ rowIndex: 1, book: MUSLIM })]);
    expect(result.stats.byBook[BUKHARI].rows).toBe(1);
    expect(result.stats.byBook[MUSLIM].rows).toBe(1);
    expect(result.stats.rows).toBe(2);
  });
});
