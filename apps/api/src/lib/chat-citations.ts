import {
  ChatCitationsFrameSchema,
  ChatSessionMessagesSchema,
  type ChatCitation,
  type ChatCitationsFrame,
  type ChatSessionMessage,
  type ChatSessionMessages,
  type Trace,
} from "@app/contracts";
import type { ChatMessage, DocChildById, RagStore } from "@app/infra";
import {
  citationCandidatesIn,
  citationLabelsOf,
  dhaifWarning as dhaifWarningLine,
  normalizeCitationLabel,
  type StoreBridge,
} from "@app/kajianq-domain";
import * as v from "valibot";

/**
 * The structured citation payload (#11, ADR-0040) — the invariant this module
 * owns: **a citation may never reach the UI without a matching chunk in the
 * persisted answer trace.** The frame is derived server-side from the trace's
 * `retrieval` chunk refs (joined to the store's chunk rows for display data)
 * and the answer's inline citation spans, using the exact label grammar and
 * normalization the deterministic citation gate (`@app/kajianq-domain`
 * chat-citation-validator) enforces on the answer itself. The client never
 * re-implements the grammar: it renders the frame or plain text.
 *
 * The derivation is a pure intersection: emitted citations = the answer's
 * inline citation spans that some trace-retrieved chunk grounds. A
 * citation-shaped span with no matching chunk (fabricated or whose row
 * vanished) is absent from the payload — never a chip without provenance.
 */

/** The trace's retrieval chunk refs, in retrieval order, deduplicated. */
export function traceChunkIds(trace: Trace): string[] {
  const ids: string[] = [];
  for (const event of trace.events) {
    if (event.kind !== "retrieval") continue;
    for (const ref of event.detail.chunks) {
      if (!ids.includes(ref.id)) ids.push(ref.id);
    }
  }
  return ids;
}

/** Display-data fetcher over the store seam (the bridge stays at the edge). */
export type CitationChunkSource = (ids: readonly string[]) => Promise<readonly DocChildById[]>;

/** The structured-warning callback both derivation entries share. */
type Warn = (msg: string, fields?: Record<string, string | number | boolean | null>) => void;

/**
 * Bind a {@link CitationChunkSource} to a wired store + its Effect bridge.
 * The bridge is the domain's typed `StoreBridge` (thermo-review B2): a wrong
 * store call wired here fails to compile instead of degrading to an empty
 * citation list at runtime.
 */
export function chunkFetcher(
  store: Pick<RagStore, "getDocChildrenByIds">,
  runStore: StoreBridge,
): CitationChunkSource {
  return async (ids) => runStore(store.getDocChildrenByIds(ids));
}

/** The chunk's citation labels, normalized exactly as the gate normalizes. */
function labelsOf(chunk: DocChildById): string[] {
  return citationLabelsOf({ id: chunk.id, text: chunk.textAr, metadata: chunk.metadata }).map(
    normalizeCitationLabel,
  );
}

/** Map one grounded chunk to its display citation (ADR-0006 label semantics). */
function toCitation(label: string, chunk: DocChildById): ChatCitation {
  const meta = (chunk.metadata ?? {}) as Record<string, unknown>;
  const grade = meta["grade"];
  const translation = chunk.textId !== null && chunk.textId !== "" ? chunk.textId : undefined;
  return {
    label,
    arabic: chunk.textAr,
    ...(translation !== undefined ? { translation } : {}),
    ...(typeof grade === "string" && grade !== "" ? { grade } : {}),
    // Provenance honesty (thermo-review A3): this flag must agree with the
    // prompt's label. The assembler renders every chunk that carries both
    // layers with `MACHINE_TRANSLATION_LABEL` (ADR-0006), so the translation
    // the answer quoted from is machine-made exactly when a translation
    // layer exists — a coupling ENFORCED BY TEST (chat-citations.test.ts
    // pins the flag to the assembler's label for the same layer values).
    // A human-checked translation layer must not land by mutating corpus
    // data alone: it needs a per-chunk provenance field consumed here (and
    // an ADR) before this flag may say anything different.
    machineTranslated: translation !== undefined,
    ...(chunk.parentTitle !== null && chunk.parentTitle !== ""
      ? { source: chunk.parentTitle }
      : {}),
  };
}

/**
 * Pure core: derive the citations frame from a persisted trace, the answer
 * text, and the display rows of the trace's chunks. Refusals carry no
 * citations (the refusal text is not a cited answer); a chunk without an
 * Arabic original backs no citation sheet (text_ar is the canonical evidence
 * layer, ADR-0013 — without it there is nothing honest to show).
 */
export function deriveCitationsFrame(input: {
  trace: Trace;
  messageId: string;
  answerText: string;
  chunksById: ReadonlyMap<string, DocChildById>;
}): ChatCitationsFrame {
  const { trace, messageId, answerText, chunksById } = input;
  if (trace.events.some((event) => event.kind === "refusal")) {
    return { messageId, citations: [], refusal: true, dhaifWarning: false };
  }
  const grounded = new Map<string, DocChildById>();
  for (const id of traceChunkIds(trace)) {
    const chunk = chunksById.get(id);
    // A trace ref whose chunk row is gone resolves to nothing: the invariant
    // is enforced by omission, and the passage simply does not get a chip.
    if (!chunk || chunk.textAr.trim() === "") continue;
    for (const label of labelsOf(chunk)) {
      if (label !== "" && !grounded.has(label)) grounded.set(label, chunk);
    }
  }
  const citations: ChatCitation[] = [];
  for (const span of citationCandidatesIn(answerText)) {
    const chunk = grounded.get(span);
    if (!chunk || citations.some((c) => c.label === span)) continue;
    citations.push(toCitation(span, chunk));
  }
  return {
    messageId,
    citations,
    refusal: false,
    dhaifWarning:
      answerText.includes(dhaifWarningLine("id")) || answerText.includes(dhaifWarningLine("en")),
  };
}

/**
 * The refusal early-return both derivation paths share (thermo-review B1):
 * a refused answer carries no citations — the refusal text is not a cited
 * answer.
 */
function refusalFrame(messageId: string): ChatCitationsFrame {
  return { messageId, citations: [], refusal: true, dhaifWarning: false };
}

/**
 * The shared degrade-and-derive fetch (thermo-review B1): resolve display
 * rows for the given chunk ids, degrading to an EMPTY map on failure — never
 * a fabricated one — with the caller's structured warning. One owner for the
 * policy, so a change to it (e.g. a structured warning field on the frame)
 * cannot be made in one entry point and forgotten in the other.
 */
async function chunksByIdOrEmpty(input: {
  ids: readonly string[];
  fetchChunks: CitationChunkSource;
  warn: Warn;
  warnKey: string;
  warnFields: Record<string, string | number | boolean | null>;
}): Promise<ReadonlyMap<string, DocChildById>> {
  try {
    const chunks = await input.fetchChunks(input.ids);
    return new Map<string, DocChildById>(chunks.map((c) => [c.id, c]));
  } catch (err) {
    // Degrade honestly: no chips, not wrong chips. Ops sees why.
    input.warn(input.warnKey, {
      ...input.warnFields,
      error: err instanceof Error ? err.message : String(err),
    });
    return new Map<string, DocChildById>();
  }
}

/**
 * The route-level entry: derive the frame from the just-persisted trace,
 * resolving display data through the store seam. A store-read failure
 * degrades to an empty citation list (never a fabricated one) with a
 * structured warning; the answer text itself is unaffected. The result is
 * parsed against the contract before it touches the wire.
 */
export async function citationsFrameFor(input: {
  trace: Trace;
  messageId: string;
  answerText: string;
  fetchChunks: CitationChunkSource;
  warn: Warn;
}): Promise<ChatCitationsFrame> {
  const { trace, messageId, answerText, fetchChunks, warn } = input;
  if (trace.events.some((event) => event.kind === "refusal")) return refusalFrame(messageId);
  const chunksById = await chunksByIdOrEmpty({
    ids: traceChunkIds(trace),
    fetchChunks,
    warn,
    warnKey: "chat.citations.chunk_lookup_failed",
    warnFields: { messageId },
  });
  return v.parse(
    ChatCitationsFrameSchema,
    deriveCitationsFrame({ trace, messageId, answerText, chunksById }),
  );
}

/**
 * Rehydrate a full transcript (#11, ADR-0040): map persisted chat rows onto
 * the rehydration contract, deriving each assistant message's citation frame
 * from ITS persisted trace — the same derivation the live `citations` frame
 * uses, so a rehydrated answer can show exactly the citations it may show
 * live, and never one its trace does not ground. Display data is fetched in
 * ONE store read for the whole transcript (the union of every trace's chunk
 * refs). A trace that is missing, fails to load, or yields a contract-invalid
 * frame degrades to a plain-text message — never to invented citations.
 */
export async function rehydrateTranscript(input: {
  sessionId: string;
  rows: readonly ChatMessage[];
  /** True when the rows were capped (the tail beyond the limit is omitted). */
  truncated: boolean;
  /** Reads a trace by the message row's `answer_trace_id` (the FK value). */
  getTrace: (traceId: string) => Promise<Trace | null>;
  fetchChunks: CitationChunkSource;
  warn: Warn;
}): Promise<ChatSessionMessages> {
  const { sessionId, rows, truncated, getTrace, fetchChunks, warn } = input;
  const traces = new Map<string, Trace>();
  await Promise.all(
    rows.map(async (row) => {
      if (row.role !== "assistant" || row.answerTraceId === null) return;
      let trace: Trace | null = null;
      try {
        trace = await getTrace(row.answerTraceId);
      } catch (err) {
        warn("chat.rehydration.trace_lookup_failed", {
          messageId: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (trace !== null) traces.set(row.id, trace);
    }),
  );
  const ids = new Set<string>();
  for (const trace of traces.values()) {
    for (const id of traceChunkIds(trace)) ids.add(id);
  }
  // One store read for the whole transcript, degrading through the same
  // shared helper the live frame uses (thermo-review B1).
  const chunksById = await chunksByIdOrEmpty({
    ids: [...ids],
    fetchChunks,
    warn,
    warnKey: "chat.rehydration.chunk_lookup_failed",
    warnFields: { sessionId },
  });
  const messages: ChatSessionMessage[] = rows.map((row) => {
    // The route only ever writes the transcript's two roles.
    const base = {
      id: row.id,
      role: row.role as ChatSessionMessage["role"],
      content: row.content,
      createdAt: row.createdAt,
    };
    const trace = traces.get(row.id);
    if (trace === undefined) return base;
    const parsed = v.safeParse(
      ChatCitationsFrameSchema,
      deriveCitationsFrame({
        trace,
        messageId: row.id,
        answerText: row.content,
        chunksById,
      }),
    );
    if (!parsed.success) {
      warn("chat.rehydration.invalid_frame", { messageId: row.id });
      return base;
    }
    return { ...base, citations: parsed.output };
  });
  return v.parse(ChatSessionMessagesSchema, { sessionId, messages, truncated });
}
