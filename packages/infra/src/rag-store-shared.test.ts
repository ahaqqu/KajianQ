import { describe, expect, it } from "vitest";
import {
  assertEmbedding,
  fromVectorLiteral,
  hashToken,
  randomToken,
  rowToChild,
  toEpochMs,
  toVectorLiteral,
  toVectorLiteralChecked,
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

  it("fromVectorLiteral rejects unrecognised shapes and non-finite components", () => {
    expect(() => fromVectorLiteral(42)).toThrow(/unexpected vector/);
    expect(() => fromVectorLiteral({})).toThrow(/unexpected vector/);
    expect(() => fromVectorLiteral(["NaN"])).toThrow(/unexpected vector component/);
    expect(() => fromVectorLiteral("[1,abc]")).toThrow(/unexpected vector component/);
  });
});

describe("rag-store-shared: embedding validation", () => {
  it("assertEmbedding passes a well-formed vector of the right dim", () => {
    expect(() => assertEmbedding([0.5, -0.5, 0], 3)).not.toThrow();
  });

  it("assertEmbedding accepts null/undefined (nullable embedding columns)", () => {
    expect(() => assertEmbedding(null, 3)).not.toThrow();
    expect(() => assertEmbedding(undefined, 3)).not.toThrow();
  });

  it("assertEmbedding rejects wrong dimension", () => {
    expect(() => assertEmbedding([1, 2], 3)).toThrow(/dimension mismatch/);
  });

  it("assertEmbedding rejects non-finite components", () => {
    expect(() => assertEmbedding([1, Number.NaN, 3], 3)).toThrow(/finite number/);
    expect(() => assertEmbedding([1, Number.POSITIVE_INFINITY, 3], 3)).toThrow(/finite number/);
  });

  it("toVectorLiteralChecked validates then serializes, null passes through", () => {
    expect(toVectorLiteralChecked([1, 2, 3], 3)).toBe("[1,2,3]");
    expect(toVectorLiteralChecked(null, 3)).toBeNull();
    expect(() => toVectorLiteralChecked([1, 2], 3)).toThrow(/dimension mismatch/);
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
