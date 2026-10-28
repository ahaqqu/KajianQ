import type { Trace, TraceTotals } from "@app/contracts";
import type { StoreError } from "@app/rag-core";
import type { Effect } from "effect";

/**
 * Admin half of the `RagStore` seam: the append-only access log, the read-only
 * trace browser's two reads, and the session revocation denylist (ADR-0064).
 *
 * The invariant this seam is cut around: **a trace-browser read is auditable
 * before it is served, and the audit record never carries content.** Two
 * consequences are visible in the types rather than trusted to the caller:
 *
 *  - `recordAdminAccess` takes an `AdminAccessSummary`, which has no free-text
 *    field. An operator's search string is content-shaped — it is typed against
 *    question and answer text — so the summary records *that* a text filter ran
 *    (`textSearch`) and never what it was. There is no field a question could be
 *    passed through, which is why the log cannot silently accumulate chat content.
 *  - `listAdminTraces` reads content only from the transcript (`chat_messages`),
 *    joined by the trace's message reference. A trace is never parsed to
 *    reconstruct the question or the answer.
 *
 * The revocation denylist is the session model's one server-side state: a token
 * stays verifiable on its own signature, but a jti on this list ends it. The list
 * holds no credential and no user — only the token's random id and its own expiry —
 * so it cannot become a second identity store, and it is reclaimed by its own
 * expiry rather than kept for an investigator.
 */
export type AdminAccessRoute = "traces.list" | "traces.detail" | "traces.raw";

/**
 * How long an access record is kept. The value is the published retention window
 * (RoPA §6): an access record is accountability evidence for the controller, and
 * it holds no content, so it outlives the per-subject records it names. The
 * adapter deletes by this window through `purgeAdminAccessLog`, and the table's
 * own rule refuses to delete a row younger than it — the real-Postgres contract
 * suite pins the two together, so neither can drift silently.
 */
export const ADMIN_ACCESS_LOG_RETENTION_DAYS = 90;

/**
 * What the access log keeps about a read: the filter dimensions (closed
 * vocabularies, dates, bounds) and the page — never the text searched for. A
 * detail or raw read names the trace it read, which is the "what" for those
 * routes; the trace id is an opaque identifier, never content.
 *
 * The free-text filters are recorded as presence booleans, never values: `q` is
 * typed against chat content, and `intent`/`model` are bounded strings, not closed
 * vocabularies, so an operator could paste a question there. Every field is a
 * boolean, a bounded number, or an opaque id.
 */
export type AdminAccessSummary = {
  /** True when a free-text filter was applied. The text itself is never recorded. */
  textSearch: boolean;
  from?: number;
  to?: number;
  /** True when an intent filter was applied. The operator's string is not recorded. */
  intentFiltered?: boolean;
  /** True when a model filter was applied. The operator's string is not recorded. */
  modelFiltered?: boolean;
  refused?: boolean;
  filterRelaxed?: boolean;
  minLatencyMs?: number;
  minCostMicroUsd?: number;
  page?: number;
  pageSize?: number;
  /** The trace a detail/raw read named — the row read, not its content. */
  traceId?: string;
};

export type AdminAccessEntry = {
  /** A stable, keyed pseudonym of the credential that performed the read. */
  actor: string;
  route: AdminAccessRoute;
  summary: AdminAccessSummary;
};

/**
 * One revoked admin session: the signed token's random id (`jti`) and the expiry the
 * token itself carries. The expiry is stored with the row so the denylist can be
 * pruned on the token's own schedule — after it, the signature's expiry check already
 * refuses the token, so the row has nothing left to prove.
 */
export type AdminSessionRevocation = {
  jti: string;
  /** The revoked token's `exp`, in epoch milliseconds. */
  expiresAt: number;
};

/**
 * The list's filter, as the store expresses it. `text` is matched against the
 * transcript's own text (question and answer); the trace-shaped dimensions are
 * read from the persisted trace's recorded events; the two bounds compare the
 * per-message totals the detail view shows, so a filtered list never hides a row
 * whose displayed total crosses the bound.
 */
export type AdminTraceFilter = {
  text?: string;
  from?: number;
  to?: number;
  intent?: string;
  model?: string;
  refused?: boolean;
  filterRelaxed?: boolean;
  minLatencyMs?: number;
  minCostMicroUsd?: number;
};

/** One row of the list — the message's own fields plus its trace-derived facts. */
export type AdminTraceRow = {
  /** The trace row's id: the stable deep link. */
  traceId: string;
  messageId: string;
  createdAt: number;
  question: string;
  answer: string;
  /** The trace's routed intent, or null when it recorded none. */
  intent: string | null;
  /** Distinct model identities, in first-call order. */
  models: readonly string[];
  refused: boolean;
  filterRelaxed: boolean;
  totals: TraceTotals;
};

export type AdminTracePage = {
  rows: readonly AdminTraceRow[];
  /** Every row matching the filter, not only this page. */
  total: number;
};

/** One trace in full: the persisted trace and its message join. */
export type AdminTraceRecord = {
  trace: Trace;
  row: AdminTraceRow;
};

/** The stored trace verbatim, before any contract parse: the raw download reads
 * this shape so a row the current contract cannot parse is still downloadable. */
export type AdminTraceRawRecord = {
  trace: unknown;
  row: AdminTraceRow;
};

export interface RagStoreAdmin {
  /**
   * Append one access record. The store offers no update or delete path: the
   * table's own rule refuses an UPDATE and refuses a DELETE of a row younger than
   * the retention window, so a written record is immutable. The caller writes the
   * record before it serves anything, and a failed write is a failed read.
   */
  recordAdminAccess(entry: AdminAccessEntry): Effect.Effect<void, StoreError>;

  /**
   * One page of the trace browser's list, newest first. Pagination is the store's
   * (`limit`/`offset`, both bound parameters) and the total is the count of every
   * matching row, so the client never pages a filtered array it holds itself.
   */
  listAdminTraces(
    filter: AdminTraceFilter,
    page: { limit: number; offset: number },
  ): Effect.Effect<AdminTracePage, StoreError>;

  /** One trace by its row id, with the transcript's question and answer. A stored
   * trace the current contract cannot parse is a `constraint` StoreError. */
  getAdminTrace(traceId: string): Effect.Effect<AdminTraceRecord | null, StoreError>;

  /** The same row with the trace unparsed. The raw download exists to inspect a
   * persisted shape the current contract rejects, so it must never parse it. */
  getAdminTraceRaw(traceId: string): Effect.Effect<AdminTraceRawRecord | null, StoreError>;

  /**
   * Delete access records past the retention window and return the count removed.
   * The window lives in the table's own rule; this call is the only deletion path,
   * and it is what makes the published retention value true rather than aspirational.
   */
  purgeAdminAccessLog(): Effect.Effect<number, StoreError>;

  /**
   * End one admin session by its token's `jti`. Re-revoking the same id is a no-op,
   * so a retried logout cannot fail on its own first success. This is the only write
   * on the surface that outlives its request, and it is what makes a sign-out end the
   * token instead of only the browser's copy of it.
   */
  revokeAdminSession(revocation: AdminSessionRevocation): Effect.Effect<void, StoreError>;

  /** Does the denylist hold this session id? A row is the whole answer: the id is
   * random, so a token whose id is present was revoked, never reissued. */
  isAdminSessionRevoked(jti: string): Effect.Effect<boolean, StoreError>;

  /**
   * Delete revocation rows whose token expired before `cutoffMs` and return the count.
   * The cutoff is the CALLER's clock — the one the token check compares `exp` against —
   * so a row is never reclaimed while the token it names still verifies on that clock;
   * the store does not measure the app-written `expires_at` against the database's own
   * `now()`. The signature's expiry check refuses an expired token with or without the
   * row, so this is storage reclamation on the token's schedule, and the reason the
   * denylist cannot grow without bound.
   */
  purgeAdminSessionRevocations(cutoffMs: number): Effect.Effect<number, StoreError>;
}
