/**
 * CSV, Python-list and provenance helpers for the Sanadset reconciliation study.
 *
 * The study reads a 1.4 GB archive, so the parser is a streaming RFC 4180 state
 * machine rather than a split on newlines: quoted fields may carry commas, escaped
 * quotes and embedded newlines, and a chunk boundary may fall anywhere inside them.
 * A parse fault fails the run — silently dropping a record would change every rate
 * the study reports.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";

export class CsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvParseError";
  }
}

export type CsvParser = {
  /** Consume one decoded chunk and return the rows it completed. */
  push(chunk: string): string[][];
  /** Flush the last row; throws when the stream ends inside a quoted field. */
  end(): string[][];
};

/**
 * A streaming RFC 4180 parser. Quote handling survives chunk boundaries: a quote
 * that might be the first half of an escaped `""` is held until the next character.
 */
export function createCsvParser(): CsvParser {
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let quotePending = false;

  const endField = (): void => {
    row.push(field);
    field = "";
  };
  const endRow = (rows: string[][]): void => {
    endField();
    // A blank line is a single empty field; every real record carries more.
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };

  return {
    push(chunk: string): string[][] {
      const rows: string[][] = [];
      for (let i = 0; i < chunk.length; i += 1) {
        const ch = chunk[i]!;
        if (quotePending) {
          quotePending = false;
          if (ch === '"') {
            field += '"';
            continue;
          }
          inQuotes = false;
        }
        if (inQuotes) {
          if (ch === '"') quotePending = true;
          else field += ch;
          continue;
        }
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ",") {
          endField();
        } else if (ch === "\n") {
          endRow(rows);
        } else if (ch !== "\r") {
          field += ch;
        }
      }
      return rows;
    },

    end(): string[][] {
      const rows: string[][] = [];
      if (quotePending) {
        // The final quote is a closing quote, not the start of an escape.
        quotePending = false;
        inQuotes = false;
      }
      if (inQuotes) throw new CsvParseError("unterminated quoted field at end of input");
      if (row.length > 0 || field.length > 0) endRow(rows);
      return rows;
    },
  };
}

/**
 * Parse the `Sanad` column, a Python list literal such as `['name', 'name']`.
 * Returns null on any shape the literal parser does not recognise; the caller
 * quarantines that row rather than guessing a chain.
 */
export function parseSanadList(raw: string): string[] | null {
  const text = raw.trim();
  if (text.length < 2 || text[0] !== "[" || text[text.length - 1] !== "]") return null;
  const last = text.length - 1;
  const out: string[] = [];
  let i = 1;
  while (i < last) {
    while (
      i < last &&
      (text[i] === " " ||
        text[i] === "\t" ||
        text[i] === "\n" ||
        text[i] === "\r" ||
        text[i] === ",")
    ) {
      i += 1;
    }
    if (i >= last) break;
    const quote = text[i];
    if (quote !== "'" && quote !== '"') return null;
    i += 1;
    let value = "";
    let closed = false;
    while (i < last) {
      const ch = text[i]!;
      if (ch === "\\") {
        const escape = text[i + 1];
        if (escape === undefined) return null;
        if (escape === "u") {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
          value += String.fromCharCode(Number.parseInt(hex, 16));
          i += 6;
          continue;
        }
        if (escape === "x") {
          const hex = text.slice(i + 2, i + 4);
          if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
          value += String.fromCharCode(Number.parseInt(hex, 16));
          i += 4;
          continue;
        }
        const simple: Record<string, string> = {
          n: "\n",
          t: "\t",
          r: "\r",
          "\\": "\\",
          "'": "'",
          '"': '"',
          "0": "\0",
        };
        value += simple[escape] ?? escape;
        i += 2;
        continue;
      }
      if (ch === quote) {
        closed = true;
        i += 1;
        break;
      }
      value += ch;
      i += 1;
    }
    if (!closed) return null;
    out.push(value);
    while (
      i < last &&
      (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")
    )
      i += 1;
    if (i < last && text[i] !== ",") return null;
  }
  return out;
}

/** SHA-256 and byte count of a file, streamed; the study refuses bytes that do not match this. */
export async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    hash.update(buffer);
  }
  return { sha256: hash.digest("hex"), bytes };
}

/** Stream CSV records from a file, decoded correctly across multi-byte boundaries. */
export async function* readCsvFile(path: string): AsyncGenerator<string[], void, void> {
  const parser = createCsvParser();
  const decoder = new StringDecoder("utf8");
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) {
    for (const row of parser.push(decoder.write(chunk))) yield row;
  }
  for (const row of parser.push(decoder.end())) yield row;
  for (const row of parser.end()) yield row;
}

/**
 * RFC 4180 writer: a value carrying a quote, comma or newline is quoted and its quotes
 * doubled, so the labels sheets survive an Arabic matn that contains either.
 */
export function toCsv(rows: readonly (readonly string[])[]): string {
  const escape = (value: string): string =>
    /[",\r\n]/u.test(value) ? `"${value.split('"').join('""')}"` : value;
  return `${rows.map((row) => row.map(escape).join(",")).join("\r\n")}\r\n`;
}
