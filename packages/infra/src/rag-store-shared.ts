import type { DocChild } from "./rag-store";

/**
 * Pure, database-free helpers shared by the RagStore adapter and its unit
 * tests. Everything here is deterministic and side-effect-free; the Neon
 * adapter composes these with its I/O. Crucially, NO SQL lives here — the
 * similarity-search query builder is co-located with the Neon adapter
 * (`rag-store-neon.ts`), the only place executable SQL should appear.
 *
 * pg returns `vector` columns as their wire form `'[0.1,0.2]'`; embeddings go
 * in as bracketed strings and come out parsed to `number[]`, so callers never
 * see the wire representation.
 */

/** Dimension of the corpus chunk embeddings (ADR-0013 dual-track). */
export const CORPUS_EMBEDDING_DIM = 1536;

/**
 * Serialize a vector to pgvector's bracketed literal form. Callers must have
 * already validated dimension/finite-ness (see {@link assertEmbedding}); this
 * helper stays a pure formatter so it is trivially unit-testable.
 */
export function toVectorLiteral(vec: readonly number[]): string {
  return `[${vec.join(",")}]`;
}

/**
 * Assert an embedding is the expected dimension and every component is a
 * finite number. Throws a descriptive `RangeError` *before* the value reaches
 * Postgres, so a misconfigured provider or ingestion bug fails loudly at the
 * seam instead of as an opaque pgvector dimension error.
 */
export function assertEmbedding(
  vec: readonly number[] | null | undefined,
  dim: number,
): asserts vec is readonly number[] | null {
  if (vec === null || vec === undefined) return;
  if (vec.length !== dim) {
    throw new RangeError(
      `embedding dimension mismatch: expected ${dim}, got ${vec.length}`,
    );
  }
  for (let i = 0; i < vec.length; i += 1) {
    const x = vec[i];
    if (typeof x !== "number" || !Number.isFinite(x)) {
      throw new RangeError(
        `embedding component ${i} is not a finite number: ${String(x)}`,
      );
    }
  }
}

/** Validate then serialize in one step for the adapter's insert path. */
export function toVectorLiteralChecked(
  vec: readonly number[] | null | undefined,
  dim: number,
): string | null {
  assertEmbedding(vec, dim);
  return vec === null || vec === undefined ? null : toVectorLiteral(vec);
}

/**
 * Parse pgvector's wire form back to a `number[]`. Every component must be a
 * finite number; a corrupt value throws instead of silently producing `NaN`s
 * that would propagate into retrieval.
 */
export function fromVectorLiteral(value: unknown): number[] | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((x, i) => {
      const n = Number(x);
      if (!Number.isFinite(n)) {
        throw new Error(`unexpected vector component ${i}: ${String(x)}`);
      }
      return n;
    });
  }
  if (typeof value === "string") {
    const inner = value.trim().replace(/^\[/, "").replace(/\]$/, "");
    if (inner === "") return [];
    return inner.split(",").map((x, i) => {
      const n = Number(x);
      if (!Number.isFinite(n)) {
        throw new Error(`unexpected vector component ${i}: '${x}'`);
      }
      return n;
    });
  }
  throw new Error(`unexpected vector value: ${String(value)}`);
}

/** Snake_case row shape produced by the adapter's similarity SELECT. */
export interface ChildRow {
  id: string;
  parent_id: string;
  text_raw: string;
  text_ar: string;
  text_id: string | null;
  citation: Record<string, unknown> | null;
  embedding_ar: unknown;
  embedding_id: unknown;
  ordinal: number;
  metadata: Record<string, unknown> | null;
  created_at: unknown;
}

export function toEpochMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  const ms = new Date(String(value)).getTime();
  if (Number.isNaN(ms)) throw new Error(`bad timestamp: ${String(value)}`);
  return ms;
}

export function rowToChild(row: ChildRow): DocChild {
  return {
    id: row.id,
    parentId: row.parent_id,
    textRaw: row.text_raw,
    textAr: row.text_ar,
    textId: row.text_id,
    citation: row.citation ?? {},
    embeddingAr: fromVectorLiteral(row.embedding_ar),
    embeddingId: fromVectorLiteral(row.embedding_id),
    ordinal: row.ordinal,
    metadata: row.metadata ?? {},
    createdAt: toEpochMs(row.created_at),
  };
}

/**
 * Token helpers use Web Crypto (`crypto.getRandomValues` / `crypto.subtle`),
 * not `node:crypto`, so the adapter runs unchanged on the Workers runtime
 * where #10 mounts it. The Bearer token is stored as its SHA-256 hash only.
 */
export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // base64url without padding; URL-safe so it travels in auth headers.
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}