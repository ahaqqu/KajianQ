import { describe, expect, it } from "vitest";
import {
  buildSimilarityQuery,
  fromVectorLiteral,
  hashToken,
  randomToken,
  rowToChild,
  toEpochMs,
  toVectorLiteral,
} from "./rag-store-shared";

describe("rag-store-shared: vector helpers", () => {
  it("toVectorLiteral round-trips with fromVectorLiteral", () => {
    const vec = [0.1, -0.25, 3.5, 0];
    expect(fromVectorLiteral(toVectorLiteral(vec))).toEqual(vec);
  });

  it("fromVectorLiteral parses pg's bracketed string form", () => {
    expect(fromVectorLiteral("[0.5,0.25,-1]")).toEqual([0.5, 0.25, -1]);
    expect(fromVectorLiteral("[0.1, 0.2]")).toEqual([0.1, 0.2]);
    expect(fromVectorLiteral("[]")).toEqual([]);
  });

  it("fromVectorLiteral passes arrays through as numbers", () => {
    expect(fromVectorLiteral([1, 2, 3])).toEqual([1, 2, 3]);
    expect(fromVectorLiteral(null)).toBeNull();
    expect(fromVectorLiteral(undefined)).toBeNull();
  });

  it("fromVectorLiteral rejects unrecognised shapes", () => {
    expect(() => fromVectorLiteral(42)).toThrow(/unexpected vector/);
    expect(() => fromVectorLiteral({})).toThrow(/unexpected vector/);
  });
});

describe("rag-store-shared: row mapping", () => {
  it("toEpochMs accepts Date and timestamp strings", () => {
    expect(toEpochMs(new Date(1_700_000_000_000))).toBe(1_700_000_000_000);
    expect(toEpochMs("2023-11-14T22:13:20.000Z")).toBe(1_700_000_000_000);
  });

  it("toEpochMs rejects invalid timestamps", () => {
    expect(() => toEpochMs("not-a-date")).toThrow(/bad timestamp/);
  });

  it("rowToChild maps snake_case rows to the typed DocChild shape", () => {
    const child = rowToChild({
      id: "c1",
      parent_id: "p1",
      text_raw: "raw",
      text_ar: "tet-a",
      text_id: "text-i",
      citation: { s: 2, a: 255 },
      embedding_ar: "[0.1,0.2]",
      embedding_id: null,
      ordinal: 7,
      metadata: null,
      created_at: "2023-11-14T22:13:20.000Z",
    });
    expect(child).toEqual({
      id: "c1",
      parentId: "p1",
      textRaw: "raw",
      textAr: "tet-a",
      textId: "text-i",
      citation: { s: 2, a: 255 },
      embeddingAr: [0.1, 0.2],
      embeddingId: null,
      ordinal: 7,
      metadata: {},
      createdAt: 1_700_000_000_000,
    });
  });
});

describe("rag-store-shared: tokens", () => {
  it("randomToken yields base64url, no padding, URL-safe", () => {
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBeGreaterThanOrEqual(40); // 32 bytes ≈ 43 chars
    // Two tokens are independent draws.
    expect(randomToken()).not.toEqual(t);
  });

  it("hashToken is a stable 64-char hex sha-256", async () => {
    const h1 = await hashToken("hello");
    const h2 = await hashToken("hello");
    const h3 = await hashToken("world");
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });
});

describe("rag-store-shared: similarity query builder", () => {
  it("targets the ar track by default and the id track on request", () => {
    const ar = buildSimilarityQuery("ar", 0);
    const id = buildSimilarityQuery("id", 0);
    expect(ar).toContain("embedding_ar <=> $1::vector");
    expect(ar).not.toContain("embedding_id <=> $1::vector");
    expect(id).toContain("embedding_id <=> $1::vector");
    expect(id).not.toContain("embedding_ar <=> $1::vector");
  });

  it("does not interpolate filter keys; filters are bound parameters", () => {
    const q = buildSimilarityQuery("ar", 2);
    // Parameters start at $3 because $1 is the embedding, $2 the limit.
    expect(q).toContain("metadata->>$3 = ANY($4::text[])");
    expect(q).toContain("metadata->>$5 = ANY($6::text[])");
    // No filter key text ever appears in the SQL string.
    expect(q).not.toContain("pfx");
  });

  it("omits the AND block entirely when there are no filters", () => {
    expect(buildSimilarityQuery("ar", 0)).not.toContain("AND metadata");
  });
});
