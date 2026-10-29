import { describe, expect, it } from "vite-plus/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CsvParseError,
  createCsvParser,
  hashFile,
  parseSanadList,
  readCsvFile,
  toCsv,
} from "./sanadset-csv";

/**
 * Test intent, named before the assertions:
 * - trap: the archive is 1.4 GB and quoted fields carry embedded newlines, so a chunk
 *   boundary can fall inside a quoted field or between the two halves of an escaped
 *   quote — a stateless split would silently shift every later column;
 * - trap: `Sanad` is a Python list literal, not JSON; a malformed one must return null
 *   so the caller quarantines the row instead of guessing a chain;
 * - trap: an unterminated quote at EOF must fail the run, because a dropped record
 *   changes every rate the study publishes.
 */

describe("createCsvParser", () => {
  it("parses quoted fields with commas, escaped quotes and embedded newlines", () => {
    const parser = createCsvParser();
    const rows = parser.push('a,"b,c","d""e","f\n g"\r\nh,i,j,k\n');
    expect(rows).toEqual([
      ["a", "b,c", 'd"e', "f\n g"],
      ["h", "i", "j", "k"],
    ]);
  });

  it("survives a chunk boundary inside a quoted field", () => {
    const parser = createCsvParser();
    expect(parser.push('x,"half')).toEqual([]);
    expect(parser.push(' a field"')).toEqual([]);
    expect(parser.push(",y\n")).toEqual([["x", "half a field", "y"]]);
  });

  it("survives a chunk boundary between the two halves of an escaped quote", () => {
    const parser = createCsvParser();
    expect(parser.push('x,"a""')).toEqual([]);
    expect(parser.push('b",y\n')).toEqual([["x", 'a"b', "y"]]);
  });

  it("drops blank lines instead of emitting empty records", () => {
    const parser = createCsvParser();
    expect(parser.push("a,b\n\n\nc,d\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("throws when the stream ends inside a quoted field", () => {
    const parser = createCsvParser();
    parser.push('a,"unterminated');
    expect(() => parser.end()).toThrow(CsvParseError);
  });

  it("flushes a final record that has no trailing newline", () => {
    const parser = createCsvParser();
    parser.push("a,b");
    expect(parser.end()).toEqual([["a", "b"]]);
  });
});

describe("parseSanadList", () => {
  it("parses a Python list of quoted names", () => {
    expect(parseSanadList("['مالك', \"أنس\"]")).toEqual(["مالك", "أنس"]);
  });

  it("decodes Python escapes", () => {
    expect(parseSanadList("['a\\u0645b', 'c\\nd']")).toEqual(["a\u0645b", "c\nd"]);
  });

  it("returns null on any shape it does not recognise", () => {
    expect(parseSanadList("No SANAD")).toBeNull();
    expect(parseSanadList("['unterminated]")).toBeNull();
    expect(parseSanadList("[1, 2]")).toBeNull();
    expect(parseSanadList("")).toBeNull();
  });

  it("returns an empty chain for an empty list", () => {
    expect(parseSanadList("[]")).toEqual([]);
  });
});

describe("toCsv and readCsvFile", () => {
  it("round-trips values carrying quotes, commas and newlines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sanadset-csv-"));
    const path = join(dir, "round-trip.csv");
    const rows = [
      ["pair_id", "a", "b"],
      ["P001", 'نص، فيه "اقتباس"', "سطر\nثانٍ"],
    ];
    writeFileSync(path, toCsv(rows), "utf8");
    const parsed: string[][] = [];
    for await (const record of readCsvFile(path)) parsed.push(record);
    expect(parsed).toEqual(rows);
  });

  it("decodes multi-byte characters split across chunk boundaries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sanadset-csv-"));
    const path = join(dir, "utf8.csv");
    // Longer than the reader's 1 MB chunk, so a multi-byte character straddles a boundary.
    const value = "مُحَمَّد ".repeat(200_000);
    writeFileSync(path, `a,b\n${value}x,y\n`, "utf8");
    const parsed: string[][] = [];
    for await (const record of readCsvFile(path)) parsed.push(record);
    expect(parsed[1]?.[0]).toBe(`${value}x`);
  });

  it("hashes and sizes a file in one streamed pass", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sanadset-csv-"));
    const path = join(dir, "hash.csv");
    writeFileSync(path, "abc", "utf8");
    const hashed = await hashFile(path);
    expect(hashed.bytes).toBe(3);
    expect(hashed.sha256).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
