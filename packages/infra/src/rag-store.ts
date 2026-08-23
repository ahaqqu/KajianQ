import type { Trace } from "@app/contracts";

/**
 * RagStore — the single persistence seam (ADR-0008).
 *
 * Every structured-data access in the system goes through this interface;
 * engine packages and apps never hold a database client or SQL. The Neon
 * Postgres + pgvector implementation in this package is one adapter — the
 * interface keeps it swappable (a second Postgres, SQLite, an in-memory
 * fake for tests) without touching consumers.
 *
 * The interface is domain-agnostic by design (AGENTS.md §1.1, dars-pluggability):
 * filters and metadata are opaque pass-throughs. Domain vocabulary lives in
 * the domain pack and arrives here only as *values* inside `metadata` or
 * `filters`, never as names in this file.
 */

/** A parent document — a coarse retrieval unit (a container of child chunks). */
export type DocParent = {
  id: string;
  /** Caller-supplied provenance key, e.g. a source-collection identifier. */
  sourceKey: string;
  title: string | null;
  /** Opaque payload; the caller decides what goes here. */
  metadata: Record<string, unknown>;
  createdAt: number;
};

export type DocParentInsert = Omit<DocParent, "id" | "createdAt"> & {
  id?: string;
};

/**
 * A child chunk — the fine-grained retrieved unit. Carries the dual embedding
 * tracks mandated by ADR-0013 (a canonical primary track plus a
 * fallback/fusion track) plus the immutable raw source text (AGENTS.md §2:
 * `text_raw` is never overwritten). Embedding columns are nullable until the
 * retrieval posture is fixed by a downstream gate; both columns exist from
 * the start so that choice stays switchable without re-ingestion.
 */
export type DocChild = {
  id: string;
  parentId: string;
  /** Original text exactly as ingested; never rewritten in place. */
  textRaw: string;
  /** Primary-track text (the canonical evidence layer per ADR-0013). */
  textAr: string;
  /** Secondary-track text (the fallback/fusion layer per ADR-0013), if any. */
  textId: string | null;
  /**
   * Structured identity of the chunk for the deterministic citation
   * validator ("every citation must exist in retrieved chunks"). Opaque
   * JSONB — the caller decides the shape; the engine stores and returns it
   * verbatim.
   */
  citation: Record<string, unknown>;
  /** 1536-dim embedding of the primary-track text; null until embedded. */
  embeddingAr: readonly number[] | null;
  /** 1536-dim embedding of the secondary-track text; null until embedded. */
  embeddingId: readonly number[] | null;
  /** Position within the parent, stable across re-ingestion. */
  ordinal: number;
  metadata: Record<string, unknown>;
  createdAt: number;
};

export type DocChildInsert = Omit<DocChild, "id" | "createdAt" | "citation"> & {
  id?: string;
  /** Defaults to `{}`. See {@link DocChild.citation} for the contract. */
  citation?: Record<string, unknown>;
};

/**
 * Which embedding track a similarity search runs against. A downstream
 * benchmark gate picks the production posture; this knob keeps both tracks
 * readable so the choice is a RagStore query-layer decision, not a schema
 * change (ADR-0013).
 */
export type RetrievalTrack = "ar" | "id";

/** A scored retrieval hit with its dense rank, for later fusion. */
export type SimilarChild = {
  child: DocChild;
  /** Cosine distance from pgvector (lower is closer); fusion is the caller's job. */
  distance: number;
  /** 1-based rank within this query's result set. */
  rankDense: number;
};

export interface RagStore {
  // -- Corpus ------------------------------------------------------------

  /** Insert a parent document, returning its persisted id. */
  insertDocParent(input: DocParentInsert): Promise<string>;

  /** Insert a child chunk tied to a parent, returning its persisted id. */
  insertDocChild(input: DocChildInsert): Promise<string>;

  /**
   * Nearest-neighbour similarity search over one embedding track. `filters`
   * are exact-match against `metadata` JSONB keys, passed through untouched —
   * the store does not interpret their names.
   */
  similaritySearch(
    track: RetrievalTrack,
    embedding: readonly number[],
    opts: {
      limit: number;
      filters?: Record<string, string | readonly string[]>;
    },
  ): Promise<readonly SimilarChild[]>;

  // -- Traces (ADR-0007) ---------------------------------------------------

  /**
   * Persist the Trace for one answer. The store writes the @app/contracts
   * `Trace` shape verbatim — it never re-serializes or invents a parallel
   * trace schema (ADR-0007 amendment).
   */
  insertAnswerTrace(input: {
    messageId: string;
    trace: Trace;
  }): Promise<string>;

  /** Fetch a persisted Trace by answer message id. */
  getAnswerTraceByMessage(messageId: string): Promise<Trace | null>;

  // -- Chat (v1 conversational surface) ------------------------------------

  createChatSession(input: {
    userId: string;
    metadata?: Record<string, unknown>;
  }): Promise<string>;

  insertChatMessage(input: {
    sessionId: string;
    role: string;
    content: string;
    /** Link to the persisted Trace, when this message produced one. */
    answerTraceId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<string>;

  // -- Anonymous sessions (ADR-0017) ----------------------------------------

  /**
   * Mint an anonymous session: creates the user row and a 30-day Bearer
   * session in one step, returning the raw token to hand to the client.
   * The token is stored hashed; plaintext leaves the store exactly once.
   */
  createSession(): Promise<{
    userId: string;
    sessionId: string;
    token: string;
    expiresAt: number;
  }>;

  /**
   * Resolve a Bearer token to its owning user id. Returns null for unknown
   * or expired sessions so the caller can map it to a 401.
   */
  resolveUserId(token: string): Promise<string | null>;

  /**
   * Delete a user and everything they own (sessions, chat sessions and their
   * messages, feedback) via cascade. Anonymous self-deletion endpoint in #10.
   */
  deleteUserCascade(userId: string): Promise<void>;
}
