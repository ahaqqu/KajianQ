import type { DocChild, RetrievalTrack } from "./rag-store";

/**
 * Pure, database-free helpers shared by the RagStore adapter and its unit
 * tests. Everything here is deterministic and side-effect-free; the Neon
 * adapter composes these with its I/O.
 *
 * pg returns `vector` columns as their wire form `'[0.1,0.2]'`; embeddings go
 * in as bracketed strings and come out parsed to `number[]`, so callers never
 * see the wire representation.
 */

export function toVectorLiteral(vec: readonly number[]): string {
  return `[${vec.join(",")}]`;
}

export function fromVectorLiteral(value: unknown): number[] | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((x) => Number(x));
  if (typeof value === "string") {
    const inner = value.trim().replace(/^\[/, "").replace(/\]$/, "");
    if (inner === "") return [];
    return inner.split(",").map((x) => Number(x));
  }
  throw new Error(`unexpected vector value: ${String(value)}`);
}

export type ChildRow = Record<string, unknown> & {
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
};

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

/**
 * Per-track SELECT template for similarity search. Each track gets its own
 * fixed query string so no column identifier is ever constructed from input;
 * the only thing chosen at runtime is which of the two strings is produced,
 * and metadata filters are appended as bound parameters.
 */
const SIMILARITY_SELECT = `
  SELECT id, parent_id, text_raw, text_ar, text_id, citation,
         embedding_ar::text AS embedding_ar,
         embedding_id::text AS embedding_id,
         ordinal, metadata, created_at,
         (%COL% <=> $1::vector) AS distance,
         ROW_NUMBER() OVER (ORDER BY %COL% <=> $1::vector) AS rank_dense
  FROM doc_children
  WHERE %COL% IS NOT NULL
`;

export function buildSimilarityQuery(
  track: RetrievalTrack,
  filterCount: number,
): string {
  const column = track === "ar" ? "embedding_ar" : "embedding_id";
  const filters =
    filterCount > 0
      ? "        AND " +
        Array.from({ length: filterCount }, (_, i) => {
          const kIdx = 3 + i * 2;
          const vIdx = kIdx + 1;
          return `metadata->>$${kIdx} = ANY($${vIdx}::text[])`;
        }).join("\n        AND ") +
        "\n"
      : "";
  return (
    SIMILARITY_SELECT.split("%COL%").join(column) +
    filters +
    `  ORDER BY ${column} <=> $1::vector\n  LIMIT $2\n`
  );
}
