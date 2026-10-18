import type { Effect } from "effect";
import type { RagStoreCorpus, StoreError } from "./rag-store-corpus-seam";
import type { RagStoreEvalLedger, RagStoreEvalRunWrite } from "./rag-store-eval-seam";
import type { RagStoreFeedback } from "./rag-store-feedback-seam";
import type { RagStoreTrace } from "./rag-store-trace-seam";

/**
 * RagStore — the single persistence seam: every method returns
 * `Effect<A, StoreError>` and no error kind travels via `throw` across it;
 * engine packages and apps never hold a database client or SQL, so the adapter
 * behind the seam stays swappable without touching consumers.
 *
 * `filters` and `metadata` are opaque pass-throughs: domain vocabulary arrives
 * only as *values* inside them. The method groups live in split seam modules
 * that `RagStore` extends, so consumers see one unchanged seam.
 */
export type { StoreError };

/** The failure type of every RagStore method — see `@app/rag-core`'s closed taxonomy. */
export type StoreFailure = StoreError;

/** The row type with the given keys optional; the `*Insert` shapes below must not drift from it. */
type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

/** A persisted conversational turn, as the history reader returns it. */
export type ChatMessage = {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  answerTraceId: string | null;
  createdAt: number;
};

/** A parent document — a coarse retrieval unit containing child chunks. */
export type DocParent = {
  id: string;
  /** Caller-supplied provenance key; the store upserts on it and never interprets it. */
  sourceKey: string;
  title: string | null;
  metadata: Record<string, unknown>;
  createdAt: number;
};

export type DocParentInsert = PartialBy<DocParent, "id" | "createdAt">;

/** A child chunk — the fine-grained retrieved unit. Carries the dual embedding
 * tracks (canonical primary plus fallback/fusion) and the immutable raw source
 * text; the embedding columns are nullable until the retrieval posture is
 * fixed, and both exist from the start so that choice needs no re-ingestion. */
export type DocChild = {
  id: string;
  parentId: string;
  /** Original text exactly as ingested; never rewritten in place. */
  textRaw: string;
  /** Primary-track text (the canonical evidence layer). */
  textAr: string;
  /** Secondary-track text (the fallback/fusion layer), if any. */
  textId: string | null;
  /** Opaque JSONB citation identity, stored and returned verbatim. */
  citation: Record<string, unknown>;
  /** 1536-dim embedding of the primary-track text; null until embedded. */
  embeddingPrimary: readonly number[] | null;
  /** 1536-dim embedding of the secondary-track text; null until embedded. */
  embeddingFallback: readonly number[] | null;
  /** Position within the parent, stable across re-ingestion. */
  ordinal: number;
  metadata: Record<string, unknown>;
  createdAt: number;
};

/** Insert shape: `id`/`createdAt` are store-generated, `citation` defaults to `{}`. */
export type DocChildInsert = PartialBy<DocChild, "id" | "createdAt" | "citation">;

export type DocChildById = DocChild & { parentTitle: string | null };

/** An aligned source/target text pair with its per-token morphology — the seed
 * unit a downstream terminology build consumes. `citation` is the pair's opaque
 * address and `morphology` the verbatim per-token annotation. */
export type AlignedPairInsert = {
  /** Caller-supplied provenance key — the store upserts on it. */
  pairKey: string;
  citation: Record<string, unknown>;
  textPrimary: string;
  textSecondary: string;
  morphology: readonly Record<string, unknown>[];
};

/** Which embedding track a similarity search runs against, named by role, not
 * by language: a domain pack maps `primary`/`fallback` onto its own language
 * tracks, so the engine stays language-agnostic. */
export type RetrievalTrack = "primary" | "fallback";

export type SimilarChild = {
  child: DocChild;
  /** Cosine distance from pgvector (lower is closer); fusion is the caller's job. */
  distance: number;
  /** 1-based rank within this query's result set. */
  rankDense: number;
};

export interface RagStore
  extends
    RagStoreCorpus,
    RagStoreTrace,
    RagStoreEvalRunWrite,
    RagStoreEvalLedger,
    RagStoreFeedback {
  // -- Chat (v1 conversational surface) ------------------------------------

  createChatSession(input: {
    userId: string;
    metadata?: Record<string, unknown>;
  }): Effect.Effect<string, StoreError>;

  /** Resolve a chat session's owning user id; null when the session does not
   * exist — the chat route checks a client-supplied `sessionId` against it. */
  getChatSessionUser(sessionId: string): Effect.Effect<string | null, StoreError>;

  insertChatMessage(input: {
    sessionId: string;
    role: string;
    content: string;
    /** Link to the persisted Trace, when this message produced one. */
    answerTraceId?: string | null;
    metadata?: Record<string, unknown>;
  }): Effect.Effect<string, StoreError>;

  /** Read a chat session's prior messages, oldest first. `limit` caps the
   * returned tail: the most recent `limit` messages, in chronological order. */
  getChatMessages(
    sessionId: string,
    opts?: { limit?: number },
  ): Effect.Effect<readonly ChatMessage[], StoreError>;

  // -- Anonymous sessions (ADR-0017) ----------------------------------------

  /** Mint an anonymous session: creates the user row and a 30-day Bearer
   * session in one step, returning the raw token for the client. The token is
   * stored hashed; plaintext leaves the store exactly once. */
  createSession(): Effect.Effect<
    {
      userId: string;
      sessionId: string;
      token: string;
      expiresAt: number;
    },
    StoreError
  >;

  /** Resolve a Bearer token to its owning user id; null for unknown or expired
   * sessions, which the caller maps to a 401. */
  resolveUserId(token: string): Effect.Effect<string | null, StoreError>;

  /** Erase a user and their whole subtree — sessions, chat sessions and their
   * messages, feedback, and the user's answer traces — in ONE transaction whose
   * postcondition is checked inside it: every table of the subtree is counted
   * after its sweep, and a surviving row aborts the transaction. The call
   * therefore resolves only for an empty subtree, and a failure is a
   * `StoreError` with the rows untouched — the caller answers with an error,
   * never with a success response. A call on an already-erased user is a no-op
   * success, so the operation is idempotent. A row whose owner column is NULL
   * cannot be attributed to any user: it survives the call silently, and the
   * postcondition is not a detector for it — only a `NOT NULL` migration (the
   * owner's decision) or an out-of-band audit of NULL-owned rows can find it. */
  deleteUserCascade(userId: string): Effect.Effect<void, StoreError>;

  /** Reclaim expired anonymous sessions: delete session rows whose TTL has
   * passed AND the anonymous users left with no session — the FK cascades
   * user → session, never the reverse, so those users and their chat/trace
   * subtrees would otherwise accumulate forever. Returns the count of
   * reclaimed users. Wire this to a periodic job: `resolveUserId` already
   * rejects expired rows on read, so this is storage reclamation, not a
   * correctness concern. */
  cleanupExpiredSessions(before?: Date): Effect.Effect<number, StoreError>;
}
export type { RagStoreEvalLedger, RagStoreEvalRunWrite } from "./rag-store-eval-seam";
export type { AnswerFeedbackTarget, FeedbackInsert } from "./rag-store-feedback-seam";
