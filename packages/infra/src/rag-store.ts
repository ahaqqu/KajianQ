import type { Effect } from "effect";
import type {
  RagStoreAdmin,
  RagStoreCorpus,
  RagStoreEvalLedger,
  RagStoreEvalRunWrite,
  RagStoreFeedback,
  RagStoreModelConfig,
  RagStoreNarrators,
  RagStoreTrace,
  StoreError,
} from "./rag-store-seams";

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

/**
 * The canonical text form of an answer's message id — what `chat_messages.id`
 * (a `uuid` column) stores and returns for any admitted spelling.
 *
 * `answer_traces.message_id` is TEXT and keeps the spelling it is given, so a
 * caller-supplied id reaches the two columns differently unless the seam
 * normalises it: the uuid column would store lowercase while the trace keeps a
 * re-cased spelling, and the transcript's `id` would no longer equal the id the
 * stream and the trace carry. Both inserts canonicalise through this one
 * function, so the caller's spelling cannot re-split the answer's identity.
 *
 * Only case needs normalising: `crypto.randomUUID()` already mints this form,
 * and every request-side message id passes `v.uuid()`, whose grammar is the
 * canonical hyphenated shape in either case — the uuid cast's wider forms
 * (braces, a hyphen-less 32-hex string) never reach the seam.
 */
export function canonicalMessageId(id: string): string {
  return id.toLowerCase();
}

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

/**
 * One metadata filter dimension's match. `values` is the exact-equality set
 * (`metadata->>key = ANY(values)`); `whenAbsent` adds the one derived case the
 * seam can express — a row that carries **no** value for the dimension's key
 * still matches when a second metadata key holds one of the given values.
 *
 * The caller supplies it as data, so the store binds every key and value as a
 * parameter and never learns what any of them means; a dimension without a
 * `whenAbsent` keeps exact-equality semantics.
 *
 * **The alternative is part of the dimension's clause, not of `values`**: it
 * admits the absent-key row whatever the set holds. A caller attaching it is
 * asserting that a row with no value *is* one of the values it asked for, so it
 * attaches the alternative only to a set that carries that value — otherwise the
 * alternative would widen a filter to evidence it never requested.
 */
export type MetadataFilterMatch = {
  values: readonly string[];
  whenAbsent?: { key: string; values: readonly string[] };
};

/**
 * One filter matched against the **transmission rows attached to a child** rather
 * than the child's own metadata: the ordered narrator sequence a passage was
 * transmitted through, which carries its own classification and attribution.
 *
 * The relation and its columns are a **closed allowlist**, never built from input:
 * the adapter emits a fixed clause per value, so no caller-supplied identifier
 * reaches the SQL. `grade` matches a row classified by one of the values;
 * `narratorIds` matches a row whose ordered sequence contains one of the ids.
 *
 * **A match selects the child, never one of its rows**: a child whose rows carry
 * a sound and a weak row matches a `grade: sound` filter as a whole, so every
 * consumer receives both rows — a filter may select evidence, never drop half.
 */
export type RelationFilterMatch = {
  readonly relation: "chains";
  readonly on: "grade" | "narratorIds";
  readonly values: readonly string[];
};

/** One filter dimension's value: a value, a set, a derived case, or a relation clause. */
export type MetadataFilterValue =
  | string
  | readonly string[]
  | MetadataFilterMatch
  | RelationFilterMatch;

/** Whether a filter value is a relation clause, which binds its own columns. */
export function isRelationFilter(value: MetadataFilterValue): value is RelationFilterMatch {
  return typeof value === "object" && value !== null && "relation" in value;
}

/**
 * Read one filter value into its metadata match shape: a single value becomes a
 * one-element set, a set is copied, and a match passes through unchanged. The
 * seam's one reader for the metadata spellings, so the adapter, the in-memory
 * double and the retriever's tests cannot disagree about how a value arrives.
 *
 * A relation clause is refused: it binds different columns and a different
 * clause, so reading it as a metadata match would ask the child row for a key it
 * never carries — a filter that matches nothing instead of the rows it named.
 */
export function filterMatchOf(value: MetadataFilterValue): MetadataFilterMatch {
  if (typeof value === "string") return { values: [value] };
  // `Array.isArray` does not narrow a `readonly string[]` in the false branch, so
  // the non-array branch restates the seam's own type rather than guessing one.
  if (Array.isArray(value)) return { values: [...(value as string[])] };
  if (isRelationFilter(value)) {
    throw new TypeError(
      `relation filter ${JSON.stringify(value.relation)} is not a metadata match`,
    );
  }
  return value as MetadataFilterMatch;
}

export interface RagStore
  extends
    RagStoreCorpus,
    RagStoreTrace,
    RagStoreEvalRunWrite,
    RagStoreEvalLedger,
    RagStoreFeedback,
    RagStoreAdmin,
    RagStoreModelConfig,
    RagStoreNarrators {
  // -- Chat (v1 conversational surface) ------------------------------------

  createChatSession(input: {
    userId: string;
    metadata?: Record<string, unknown>;
  }): Effect.Effect<string, StoreError>;

  /** Resolve a chat session's owning user id; null when the session does not
   * exist — the chat route checks a client-supplied `sessionId` against it. */
  getChatSessionUser(sessionId: string): Effect.Effect<string | null, StoreError>;

  /**
   * Write one chat message and return its row id (`chat_messages.id`). That
   * id is the message's identity across the API: the transcript returns it,
   * the live answer's `meta` frame carries it, and feedback addresses the
   * message by it. `id` lets a caller that also persists a row referencing
   * the message — the answer trace's `message_id` — mint the id once and
   * write it into both, instead of learning it only after this insert;
   * absent, the store mints one. The store returns the id's canonical text
   * form (`canonicalMessageId`), which is what the row stores: a caller that
   * supplies a re-cased uuid must use the returned value for the trace
   * reference and the stream, or the two would disagree on spelling.
   */
  insertChatMessage(input: {
    /** The row id to write; absent lets the store mint one. */
    id?: string;
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
export type { RagStoreAdmin } from "./rag-store-admin-seam";
export type { RagStoreEvalLedger, RagStoreEvalRunWrite } from "./rag-store-eval-seam";
export type { AnswerFeedbackTarget, FeedbackInsert } from "./rag-store-feedback-seam";
