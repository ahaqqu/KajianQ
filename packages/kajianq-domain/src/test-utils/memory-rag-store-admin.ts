import type { Trace } from "@app/contracts";
import { traceProviderCalls, traceTotals } from "@app/contracts";
import { Effect } from "effect";
import {
  ADMIN_ACCESS_LOG_RETENTION_DAYS,
  type AdminAccessSummary,
  type AdminTraceFilter,
  type AdminTraceRow,
  type RagStore,
} from "@app/infra";

/**
 * Admin Trace browser methods of the in-memory RagStore — the test seam's mirror
 * of the Postgres adapter's semantics (ADR-0064).
 *
 * Two deliberate stand-ins, both matching the production shape rather than
 * inventing a second one: a message's `createdAt` is its insertion order (the
 * memory store has no clock, exactly as `getChatMessages` already reads it), and a
 * trace row's timestamp is the persisted `Trace.createdAt`. The row id is the
 * trace's own id here, where production mints a separate uuid — both are opaque
 * ids to every method on the seam.
 */
export type MemoryAdminState = {
  chatMessages: Map<
    string,
    { sessionId: string; role: string; content: string; answerTraceId: string | null }
  >;
  /** Trace row id → persisted trace. */
  traceRows: Map<string, unknown>;
  /** Trace row id → the answer's canonical message id. */
  traceRowMessageIds: Map<string, string>;
};

/** One access record as the double keeps it, in append order. */
export type MemoryAdminAccessRecord = {
  accessedAt: number;
  actor: string;
  route: string;
  summary: AdminAccessSummary;
};

type MessageRow = {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  index: number;
};

function messageRows(state: MemoryAdminState): MessageRow[] {
  return [...state.chatMessages.entries()].map(([id, m], index) => ({
    id,
    sessionId: m.sessionId,
    role: m.role,
    content: m.content,
    index,
  }));
}

function rowOf(state: MemoryAdminState, traceId: string): AdminTraceRow | null {
  const raw = state.traceRows.get(traceId);
  if (raw === undefined) return null;
  const trace = raw as Trace;
  const answerId = state.traceRowMessageIds.get(traceId);
  const messages = messageRows(state);
  const answer = answerId === undefined ? undefined : messages.find((m) => m.id === answerId);
  if (answer === undefined) return null;
  const question = messages
    .filter((m) => m.sessionId === answer.sessionId && m.role === "user" && m.index <= answer.index)
    .at(-1);
  const intentEvent = trace.events.find((event) => event.kind === "intent");
  const models: string[] = [];
  for (const call of traceProviderCalls(trace)) {
    if (!models.includes(call.modelId)) models.push(call.modelId);
  }
  const intent =
    intentEvent !== undefined && typeof intentEvent.detail.intent === "string"
      ? intentEvent.detail.intent
      : null;
  return {
    traceId,
    messageId: answer.id,
    createdAt: trace.createdAt,
    question: question?.content ?? "",
    answer: answer.content,
    intent,
    models,
    refused: trace.events.some((event) => event.kind === "refusal"),
    filterRelaxed: trace.events.some(
      (event) =>
        event.kind === "filter_relaxed" &&
        (event.detail as { adopted?: boolean }).adopted !== false,
    ),
    totals: traceTotals(trace),
  };
}

function matches(row: AdminTraceRow, filter: AdminTraceFilter): boolean {
  if (filter.text !== undefined) {
    const needle = filter.text.toLowerCase();
    if (
      !row.question.toLowerCase().includes(needle) &&
      !row.answer.toLowerCase().includes(needle)
    ) {
      return false;
    }
  }
  if (filter.from !== undefined && row.createdAt < filter.from) return false;
  if (filter.to !== undefined && row.createdAt > filter.to) return false;
  if (filter.intent !== undefined && row.intent !== filter.intent) return false;
  if (filter.model !== undefined && !row.models.includes(filter.model)) return false;
  if (filter.refused !== undefined && row.refused !== filter.refused) return false;
  if (filter.filterRelaxed !== undefined && row.filterRelaxed !== filter.filterRelaxed)
    return false;
  if (filter.minLatencyMs !== undefined && row.totals.latencyMs < filter.minLatencyMs) return false;
  if (filter.minCostMicroUsd !== undefined && row.totals.costMicroUsd < filter.minCostMicroUsd) {
    return false;
  }
  return true;
}

export function memoryAdminMethods(
  state: MemoryAdminState,
): Pick<
  RagStore,
  | "recordAdminAccess"
  | "listAdminTraces"
  | "getAdminTrace"
  | "getAdminTraceRaw"
  | "purgeAdminAccessLog"
  | "revokeAdminSession"
  | "isAdminSessionRevoked"
  | "purgeAdminSessionRevocations"
> & { allAdminAccess: () => readonly MemoryAdminAccessRecord[] } {
  const log: MemoryAdminAccessRecord[] = [];
  // The denylist's whole state: random session id → the revoked token's expiry. The
  // double keeps it in-process exactly as the adapter keeps it in one table; no test
  // reaches into it, because the seam's calls are the behaviour under test.
  const revocations = new Map<string, number>();
  return {
    allAdminAccess: () => log,
    recordAdminAccess(entry) {
      return Effect.sync(() => {
        log.push({ accessedAt: Date.now(), ...entry });
      });
    },
    listAdminTraces(filter, page) {
      return Effect.sync(() => {
        const all = [...state.traceRows.keys()]
          .map((id) => rowOf(state, id))
          .filter((row): row is AdminTraceRow => row !== null)
          .filter((row) => matches(row, filter))
          .sort((a, b) => b.createdAt - a.createdAt || (a.traceId < b.traceId ? 1 : -1));
        return {
          rows: all.slice(page.offset, page.offset + page.limit),
          total: all.length,
        };
      });
    },
    getAdminTrace(traceId) {
      return Effect.sync(() => {
        const raw = state.traceRows.get(traceId);
        const row = rowOf(state, traceId);
        if (raw === undefined || row === null) return null;
        return { trace: raw as Trace, row };
      });
    },
    getAdminTraceRaw(traceId) {
      // The double's rows are already `unknown`-typed: the raw read hands the stored
      // value back exactly as the Postgres adapter does, with no contract parse.
      return Effect.sync(() => {
        const raw = state.traceRows.get(traceId);
        const row = rowOf(state, traceId);
        if (raw === undefined || row === null) return null;
        return { trace: raw, row };
      });
    },
    purgeAdminAccessLog() {
      return Effect.sync(() => {
        const cutoff = Date.now() - ADMIN_ACCESS_LOG_RETENTION_DAYS * 86_400_000;
        const kept = log.filter((entry) => entry.accessedAt >= cutoff);
        const removed = log.length - kept.length;
        log.length = 0;
        log.push(...kept);
        return removed;
      });
    },
    revokeAdminSession({ jti, expiresAt }) {
      return Effect.sync(() => {
        revocations.set(jti, expiresAt);
      });
    },
    isAdminSessionRevoked(jti) {
      return Effect.sync(() => revocations.has(jti));
    },
    purgeAdminSessionRevocations() {
      return Effect.sync(() => {
        const now = Date.now();
        let removed = 0;
        for (const [jti, expiresAt] of revocations) {
          if (expiresAt < now) {
            revocations.delete(jti);
            removed += 1;
          }
        }
        return removed;
      });
    },
  };
}
