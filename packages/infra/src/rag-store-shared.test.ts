import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { runFail } from "@app/rag-core/testing";
import {
  checkEmbedding,
  hashToken,
  parseVectorLiteral,
  parseEpochMs,
  randomToken,
  rowToChildEffect,
  toVectorLiteral,
  toVectorLiteralChecked,
} from "./rag-store-shared";

describe("rag-store-shared: vector helpers", () => {
  it("toVectorLiteral round-trips with parseVectorLiteral", async () => {
    const vec = [0.1, -0.25, 3.5, 0];
    expect(await Effect.runPromise(parseVectorLiteral(toVectorLiteral(vec)))).toEqual(vec);
  });

  it("parseVectorLiteral parses pg's bracketed string form", async () => {
    expect(await Effect.runPromise(parseVectorLiteral("[0.5,0.25,-1]"))).toEqual([0.5, 0.25, -1]);
    expect(await Effect.runPromise(parseVectorLiteral("[0.1, 0.2]"))).toEqual([0.1, 0.2]);
    expect(await Effect.runPromise(parseVectorLiteral("[]"))).toEqual([]);
  });

  it("parseVectorLiteral passes arrays through as numbers", async () => {
    expect(await Effect.runPromise(parseVectorLiteral([1, 2, 3]))).toEqual([1, 2, 3]);
    expect(await Effect.runPromise(parseVectorLiteral(null))).toBeNull();
    expect(await Effect.runPromise(parseVectorLiteral(undefined))).toBeNull();
  });

  it("parseVectorLiteral rejects unrecognised shapes and non-finite components (constraint kind)", async () => {
    for (const value of [42, {}]) {
      const err = await runFail(parseVectorLiteral(value));
      expect(err.kind).toBe("constraint");
      expect((err.cause as Error).message).toMatch(/unexpected vector/);
    }
    for (const value of [["NaN"], "[1,abc]"]) {
      const err = await runFail(parseVectorLiteral(value));
      expect(err.kind).toBe("constraint");
      // Array form reports the non-finite component; wire form reports the
      // unparseable slot — both are constraint-class vector validation.
      expect((err.cause as Error).message).toMatch(
        /unexpected vector component|not a finite number/,
      );
    }
  });
});

describe("rag-store-shared: embedding validation", () => {
  it("checkEmbedding passes a well-formed vector of the right dim", async () => {
    expect(await Effect.runPromise(checkEmbedding([0.5, -0.5, 0], 3))).toEqual([0.5, -0.5, 0]);
  });

  it("checkEmbedding accepts null/undefined (nullable embedding columns)", async () => {
    expect(await Effect.runPromise(checkEmbedding(null, 3))).toBeNull();
    expect(await Effect.runPromise(checkEmbedding(undefined, 3))).toBeNull();
  });

  it("checkEmbedding rejects wrong dimension as constraint StoreError", async () => {
    const err = await runFail(checkEmbedding([1, 2], 3));
    expect(err.kind).toBe("constraint");
    expect((err.cause as Error).message).toMatch(/dimension mismatch/);
  });

  it("checkEmbedding rejects non-finite components as constraint StoreError", async () => {
    for (const bad of [
      [1, Number.NaN, 3],
      [1, Number.POSITIVE_INFINITY, 3],
    ]) {
      const err = await runFail(checkEmbedding(bad, 3));
      expect(err.kind).toBe("constraint");
      expect((err.cause as Error).message).toMatch(/finite number/);
    }
  });

  it("toVectorLiteralChecked validates then serializes, null passes through", async () => {
    expect(await Effect.runPromise(toVectorLiteralChecked([1, 2, 3], 3))).toBe("[1,2,3]");
    expect(await Effect.runPromise(toVectorLiteralChecked(null, 3))).toBeNull();
    const err = await runFail(toVectorLiteralChecked([1, 2], 3));
    expect(err.kind).toBe("constraint");
    expect((err.cause as Error).message).toMatch(/dimension mismatch/);
  });
});

describe("rag-store-shared: row mapping", () => {
  it("parseEpochMs accepts Date and timestamp strings", async () => {
    expect(await Effect.runPromise(parseEpochMs(new Date(1_700_000_000_000)))).toBe(
      1_700_000_000_000,
    );
    expect(await Effect.runPromise(parseEpochMs("2023-11-14T22:13:20.000Z"))).toBe(
      1_700_000_000_000,
    );
  });

  it("parseEpochMs rejects invalid timestamps as constraint StoreError", async () => {
    const err = await runFail(parseEpochMs("not-a-date"));
    expect(err.kind).toBe("constraint");
    expect((err.cause as Error).message).toMatch(/bad timestamp/);
  });

  it("rowToChildEffect maps snake_case rows to the typed DocChild shape", async () => {
    const child = await Effect.runPromise(
      rowToChildEffect({
        id: "c1",
        parent_id: "p1",
        text_raw: "raw",
        text_ar: "tet-a",
        text_id: "text-i",
        citation: { s: 2, a: 255 },
        embedding_primary: "[0.1,0.2]",
        embedding_fallback: null,
        ordinal: 7,
        metadata: null,
        created_at: "2023-11-14T22:13:20.000Z",
      }),
    );
    expect(child).toEqual({
      id: "c1",
      parentId: "p1",
      textRaw: "raw",
      textAr: "tet-a",
      textId: "text-i",
      citation: { s: 2, a: 255 },
      embeddingPrimary: [0.1, 0.2],
      embeddingFallback: null,
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
