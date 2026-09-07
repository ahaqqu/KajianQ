import * as v from "valibot";
import { Effect } from "effect";
import { StoreError } from "@app/rag-core";
import { TraceSchema, type Trace } from "@app/contracts";
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
 *
 * Validation failures here are `constraint`-class `StoreError`s
 * (ADR-0027 decision 7): bad vectors/timestamps are input defects —
 * deterministic, never retried — and travel in the `E` channel, never via
 * `throw`.
 */

/** Dimension of the corpus chunk embeddings (ADR-0013 dual-track). */
export const CORPUS_EMBEDDING_DIM = 1536;

/** The taxonomy's `constraint` kind over a validation failure cause. */
export const constraintError = (cause: unknown): StoreError =>
  new StoreError({ kind: "constraint", cause });

/**
 * Validate an untrusted value against the shared Trace contract (ADR-0007).
 * The store writes/parses the @app/contracts `Trace` shape verbatim — it
 * never invents a parallel trace schema. Used on both the write path
 * (reject malformed traces before persisting) and the read path (tolerant
 * reader: the contract only ever adds optional fields).
 */
export function parseTrace(value: unknown): Trace {
  return v.parse(TraceSchema, value);
}

/**
 * Serialize a vector to pgvector's bracketed literal form. Callers must have
 * already validated dimension/finite-ness (see {@link checkEmbedding}); this
 * helper stays a pure formatter so it is trivially unit-testable.
 */
export function toVectorLiteral(vec: readonly number[]): string {
  return `[${vec.join(",")}]`;
}

/** Classify one vector component; null = finite number accepted. */
function badComponent(i: number, x: unknown): StoreError | null {
  if (typeof x !== "number" || !Number.isFinite(x)) {
    return constraintError(
      new RangeError(`embedding component ${i} is not a finite number: ${String(x)}`),
    );
  }
  return null;
}

/**
 * Check an embedding is the expected dimension and every component is a
 * finite number — BEFORE the value reaches Postgres, so a misconfigured
 * provider or ingestion bug fails loudly at the seam instead of as an
 * opaque pgvector dimension error. Effect-shaped (ADR-0027): the failure
 * travels in the `E` channel as a `constraint` StoreError, never via
 * `throw`. Null/undefined pass (the embedding columns are nullable).
 */
export function checkEmbedding(
  vec: readonly number[] | null | undefined,
  dim: number,
): Effect.Effect<readonly number[] | null, StoreError> {
  return Effect.suspend(() => {
    if (vec === null || vec === undefined) return Effect.succeed(null);
    if (vec.length !== dim) {
      return Effect.fail(
        constraintError(
          new RangeError(`embedding dimension mismatch: expected ${dim}, got ${vec.length}`),
        ),
      );
    }
    for (let i = 0; i < vec.length; i += 1) {
      const bad = badComponent(i, vec[i]);
      if (bad !== null) return Effect.fail(bad);
    }
    return Effect.succeed(vec);
  });
}

/** Validate then serialize in one step for the batch builder's insert path. */
export function toVectorLiteralChecked(
  vec: readonly number[] | null | undefined,
  dim: number,
): Effect.Effect<string | null, StoreError> {
  return Effect.map(checkEmbedding(vec, dim), (v) => (v === null ? null : toVectorLiteral(v)));
}

/** Parse one row's vector column (pg wire string or array form). */
export function parseVectorLiteral(
  value: unknown,
): Effect.Effect<number[] | null, StoreError> {
  return Effect.suspend(() => {
    if (value === null || value === undefined) return Effect.succeed<number[] | null>(null);
    if (Array.isArray(value)) {
      const out: number[] = [];
      for (let i = 0; i < value.length; i += 1) {
        const bad = badComponent(i, value[i]);
        if (bad !== null) return Effect.fail(bad);
        out.push(value[i] as number);
      }
      return Effect.succeed<number[] | null>(out);
    }
    if (typeof value === "string") {
      const inner = value.trim().replace(/^\[/, "").replace(/\]$/, "");
      if (inner === "") return Effect.succeed<number[] | null>([]);
      const parts = inner.split(",");
      const out: number[] = [];
      for (let i = 0; i < parts.length; i += 1) {
        const n = Number(parts[i]);
        if (!Number.isFinite(n)) {
          return Effect.fail(
            constraintError(new Error(`unexpected vector component ${i}: '${parts[i]}'`)),
          );
        }
        out.push(n);
      }
      return Effect.succeed<number[] | null>(out);
    }
    return Effect.fail(constraintError(new Error(`unexpected vector value: ${String(value)}`)));
  });
}

/** Snake_case row shape produced by the adapter's similarity SELECT. */
export interface ChildRow {
  id: string;
  parent_id: string;
  text_raw: string;
  text_ar: string;
  text_id: string | null;
  citation: Record<string, unknown> | null;
  embedding_primary: unknown;
  embedding_fallback: unknown;
  ordinal: number;
  metadata: Record<string, unknown> | null;
  created_at: unknown;
}

/** Parse a row timestamp to epoch ms; a corrupt value is constraint-class. */
export function parseEpochMs(value: unknown): Effect.Effect<number, StoreError> {
  return Effect.suspend(() => {
    if (value instanceof Date) return Effect.succeed(value.getTime());
    const ms = new Date(String(value)).getTime();
    if (Number.isNaN(ms)) {
      return Effect.fail(constraintError(new Error(`bad timestamp: ${String(value)}`)));
    }
    return Effect.succeed(ms);
  });
}

/** Map a similarity-select row to a `DocChild`, failing constraint-class on corrupt values. */
export function rowToChildEffect(row: ChildRow): Effect.Effect<DocChild, StoreError> {
  return Effect.gen(function* () {
    const embeddingPrimary = yield* parseVectorLiteral(row.embedding_primary);
    const embeddingFallback = yield* parseVectorLiteral(row.embedding_fallback);
    const createdAt = yield* parseEpochMs(row.created_at);
    return {
      id: row.id,
      parentId: row.parent_id,
      textRaw: row.text_raw,
      textAr: row.text_ar,
      textId: row.text_id,
      citation: row.citation ?? {},
      embeddingPrimary,
      embeddingFallback,
      ordinal: row.ordinal,
      metadata: row.metadata ?? {},
      createdAt,
    };
  });
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
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}