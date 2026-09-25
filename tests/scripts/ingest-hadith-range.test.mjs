import { describe, expect, it } from "vitest";
import {
  onlyMissingCollections,
  parseCollectionRange,
  selectCollections,
} from "../../packages/kajianq-domain/scripts/collection-range.mjs";

/**
 * Range parsing for the corpus ingest CLI (`ingest-hadith.mjs`).
 *
 * The rules exist because a quota-bound ingest has to be splittable into
 * resumable passes (one collection per invocation), and because the earlier
 * parser's failure modes were silent: `--limit 0` meant "full corpus" via
 * falsiness, and `--limit abc` produced `slice(0, NaN)` — an empty run that
 * reported success. The `onlyMissingCollections` guard (issue #213) narrows a
 * range to collections with zero landed children, so a range loop cannot
 * re-pay embeddings for collections already landed — upserts dedupe rows,
 * not spend (ADR-0037).
 */

const COLLECTIONS = ["bukhari", "muslim", "abudawud", "tirmidhi", "nasai", "ibnmajah", "malik"];

describe("parseCollectionRange", () => {
  it("defaults to offset 0 and no limit", () => {
    expect(parseCollectionRange([])).toEqual({ offset: 0, limit: null });
  });

  it("reads --offset and --limit", () => {
    expect(parseCollectionRange(["--offset", "3", "--limit", "1"])).toEqual({
      offset: 3,
      limit: 1,
    });
  });

  it("reads a single collection pass", () => {
    expect(parseCollectionRange(["--offset", "6", "--limit", "1"])).toEqual({
      offset: 6,
      limit: 1,
    });
  });

  it("reports a non-integer value as NaN rather than guessing", () => {
    const { limit, offset } = parseCollectionRange(["--offset", "abc", "--limit", "abc"]);
    expect(Number.isNaN(offset)).toBe(true);
    expect(Number.isNaN(limit)).toBe(true);
  });
});

describe("selectCollections", () => {
  it("selects the whole list with no limit", () => {
    expect(selectCollections(COLLECTIONS, { offset: 0, limit: null }).collections).toEqual(
      COLLECTIONS,
    );
  });

  it("selects a single collection by offset (the resumable pass)", () => {
    expect(selectCollections(COLLECTIONS, { offset: 2, limit: 1 }).collections).toEqual([
      "abudawud",
    ]);
    expect(selectCollections(COLLECTIONS, { offset: 6, limit: 1 }).collections).toEqual(["malik"]);
  });

  it("selects a slice from an offset", () => {
    expect(selectCollections(COLLECTIONS, { offset: 1, limit: 3 }).collections).toEqual([
      "muslim",
      "abudawud",
      "tirmidhi",
    ]);
  });

  it("clamps a limit past the end instead of failing", () => {
    expect(selectCollections(COLLECTIONS, { offset: 5, limit: 10 }).collections).toEqual([
      "ibnmajah",
      "malik",
    ]);
  });

  it("rejects a bad offset", () => {
    expect(selectCollections(COLLECTIONS, { offset: -1, limit: null }).error).toMatch(/--offset/);
    expect(selectCollections(COLLECTIONS, { offset: 1.5, limit: null }).error).toMatch(/--offset/);
    expect(selectCollections(COLLECTIONS, { offset: Number.NaN, limit: null }).error).toMatch(
      /--offset/,
    );
  });

  it("rejects an offset past the last collection (a silent empty run)", () => {
    expect(selectCollections(COLLECTIONS, { offset: 7, limit: 1 }).error).toMatch(
      /past the last collection \(index 6\)/,
    );
  });

  it("rejects a bad limit", () => {
    expect(selectCollections(COLLECTIONS, { offset: 0, limit: 0 }).error).toMatch(/--limit/);
    expect(selectCollections(COLLECTIONS, { offset: 0, limit: Number.NaN }).error).toMatch(
      /--limit/,
    );
  });
});

describe("onlyMissingCollections", () => {
  const landed = {
    bukhari: 7130,
    muslim: 0,
    abudawud: 0,
    tirmidhi: 0,
    nasai: 0,
    ibnmajah: 0,
    malik: 1829,
  };

  it("keeps only collections with zero landed children", () => {
    const r = onlyMissingCollections(COLLECTIONS, landed);
    expect(r.error).toBeUndefined();
    expect(r.collections).toEqual(["muslim", "abudawud", "tirmidhi", "nasai", "ibnmajah"]);
    expect(r.landed).toEqual(["bukhari", "malik"]);
  });

  it("reads a collection absent from the counts map as zero (kept)", () => {
    const r = onlyMissingCollections(["muslim"], {});
    expect(r.error).toBeUndefined();
    expect(r.collections).toEqual(["muslim"]);
  });

  it("refuses a no-op paid pass when everything selected already landed", () => {
    const r = onlyMissingCollections(["malik"], landed);
    expect(r.error).toMatch(/already has children landed.*malik=1829.*refusing/);
  });

  it("keeps everything when nothing landed", () => {
    const r = onlyMissingCollections(["bukhari", "muslim"], {});
    expect(r.collections).toEqual(["bukhari", "muslim"]);
    expect(r.landed).toEqual([]);
  });
});
