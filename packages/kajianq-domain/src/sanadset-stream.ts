/**
 * The streaming slice read: one pass over the archive, one retained row at a time.
 *
 * The source is 1.4 GB, so nothing here materialises it. A record whose column count
 * does not match the header fails the run — a silently dropped record would change
 * every rate the study publishes — and `No SANAD` rows are counted as skipped, not
 * quarantined, because the archive declares them rather than rejecting them.
 */

import { readCsvFile } from "./sanadset-csv";
import {
  createPrepareAccumulator,
  type PreparedRow,
  type PrepareStats,
  type QuarantinedRow,
} from "./sanadset-prepare";

export const SANADSET_COLUMNS = [
  "Hadith",
  "Book",
  "Num_hadith",
  "Matn",
  "Sanad",
  "Sanad_Length",
] as const;

export type ColumnIndex = Readonly<Record<(typeof SANADSET_COLUMNS)[number], number>>;

export type SliceStream = {
  readonly prepared: readonly PreparedRow[];
  readonly quarantined: readonly QuarantinedRow[];
  readonly stats: PrepareStats;
  /** Data records read from the file (the header excluded). */
  readonly recordsRead: number;
};

/** A non-negative integer or null; `""`, `"3.0"` and `"x"` are not lengths. */
export function parseSanadLength(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+$/u.test(text)) return null;
  const value = Number.parseInt(text, 10);
  return Number.isSafeInteger(value) ? value : null;
}

/** Map the header to column positions, so a reordered export fails loudly instead of silently. */
export function resolveColumns(header: readonly string[]): ColumnIndex {
  const index: Partial<Record<(typeof SANADSET_COLUMNS)[number], number>> = {};
  for (const name of SANADSET_COLUMNS) {
    const position = header.findIndex((column) => column.replace(/^\uFEFF/u, "").trim() === name);
    if (position < 0) throw new Error(`sanadset csv: header is missing the ${name} column`);
    index[name] = position;
  }
  return index as ColumnIndex;
}

/** Read the archive once and prepare the slice; `limit` bounds the data records read. */
export async function streamSlice(
  csvPath: string,
  options: { readonly limit?: number } = {},
): Promise<SliceStream> {
  const accumulator = createPrepareAccumulator();
  let columns: ColumnIndex | null = null;
  let recordsRead = 0;
  for await (const record of readCsvFile(csvPath)) {
    if (columns === null) {
      columns = resolveColumns(record);
      continue;
    }
    if (record.length !== SANADSET_COLUMNS.length) {
      throw new Error(
        `sanadset csv: record ${recordsRead + 1} has ${record.length} fields, expected ${SANADSET_COLUMNS.length}`,
      );
    }
    recordsRead += 1;
    accumulator.push({
      rowIndex: recordsRead - 1,
      book: record[columns.Book] ?? "",
      hadithNumber: record[columns.Num_hadith] ?? "",
      hadith: record[columns.Hadith] ?? "",
      matn: record[columns.Matn] ?? "",
      sanad: record[columns.Sanad] ?? "",
      sanadLength: parseSanadLength(record[columns.Sanad_Length] ?? ""),
    });
    if (options.limit !== undefined && recordsRead >= options.limit) break;
  }
  if (columns === null) throw new Error("sanadset csv: the file is empty (no header record)");
  const result = accumulator.finish();
  return {
    prepared: result.prepared,
    quarantined: result.quarantined,
    stats: result.stats,
    recordsRead,
  };
}
