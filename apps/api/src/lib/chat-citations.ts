import {
  ChatCitationsFrameSchema,
  ChatSessionMessagesSchema,
  ChatTraceFrameSchema,
  type ChatCitation,
  type ChatCitationsFrame,
  type ChatSessionMessage,
  type ChatSessionMessages,
  type ChatTraceFrame,
  type Trace,
} from "@app/contracts";
import type { ChatMessage, DocChildById } from "@app/infra";
import {
  citationCandidatesIn,
  citationLabelsOf,
  groundingLabelsFor,
  hasWeakWarning,
  normalizeCitationLabel,
} from "@app/kajianq-domain";
// The trace-frame module owns the shared chunk-ref + display-fetch plumbing.
import {
  chunksByIdOrEmpty,
  deriveTraceFrame,
  traceChunkIds,
  traceRefused,
  type CitationChunkSource,
  type Warn,
} from "./chat-trace";
import * as v from "valibot";

/**
 * The structured citation payload — the invariant this module owns: **a citation may
 * never reach the UI without a matching chunk in the persisted answer trace.** The
 * frame is derived server-side from the trace's `retrieval` chunk refs (joined to the
 * store's chunk rows for display data) and the answer's inline citation spans, using
 * the exact label grammar and normalization the deterministic citation gate
 * (`@app/kajianq-domain`) enforces on the answer itself.
 *
 * The derivation is a pure intersection: emitted citations = the answer's inline citation
 * spans that some trace-retrieved chunk grounds. **"Grounds" is the gate's own decision**,
 * decided by `groundingLabelsFor`: matching an exact label alone would drop every range.
 */

/** The chunk's citation labels, normalized exactly as the gate normalizes. */
function labelsOf(chunk: DocChildById): string[] {
  return citationLabelsOf({ id: chunk.id, text: chunk.textAr, metadata: chunk.metadata }).map(
    normalizeCitationLabel,
  );
}

function toCitation(label: string, chunk: DocChildById): ChatCitation {
  const meta = (chunk.metadata ?? {}) as Record<string, unknown>;
  const grade = meta["grade"];
  const translation = chunk.textId !== null && chunk.textId !== "" ? chunk.textId : undefined;
  return {
    label,
    arabic: chunk.textAr,
    ...(translation !== undefined ? { translation } : {}),
    ...(typeof grade === "string" && grade !== "" ? { grade } : {}),
    // Provenance honesty: this flag must agree with the prompt's label — the assembler
    // renders every chunk carrying both layers with `MACHINE_TRANSLATION_LABEL`, so a
    // translation exists exactly when a translation layer does. A human-checked layer
    // needs a per-chunk provenance field consumed here before this flag may change.
    machineTranslated: translation !== undefined,
    ...(chunk.parentTitle !== null && chunk.parentTitle !== ""
      ? { source: chunk.parentTitle }
      : {}),
  };
}

/**
 * Pure core: derive the citations frame from a persisted trace, the answer text, and
 * the trace chunks' display rows (text_ar is the canonical evidence layer — a chunk
 * without it backs no citation sheet). **The list is the pure intersection, with no
 * refusal case**: a `refusal` event sets the flag below and NOTHING else.
 */
export function deriveCitationsFrame(input: {
  trace: Trace;
  messageId: string;
  answerText: string;
  chunksById: ReadonlyMap<string, DocChildById>;
}): ChatCitationsFrame {
  const { trace, messageId, answerText, chunksById } = input;
  const grounded = new Map<string, DocChildById>();
  for (const id of traceChunkIds(trace)) {
    const chunk = chunksById.get(id);
    // A gone chunk row resolves to nothing: the invariant is enforced by omission.
    if (!chunk || chunk.textAr.trim() === "") continue;
    for (const label of labelsOf(chunk)) {
      if (label !== "" && !grounded.has(label)) grounded.set(label, chunk);
    }
  }
  const citations: ChatCitation[] = [];
  // The grounding decision is the gate's, so frame and gate cannot disagree.
  const known = new Set(grounded.keys());
  for (const span of citationCandidatesIn(answerText)) {
    const labels = groundingLabelsFor(span, known);
    if (labels === null) continue;
    // The citation keeps the span as the draft wrote it — the display form is the
    // range — backed by the first address that grounds it: for a range, its head verse.
    const chunk = labels
      .map((label) => grounded.get(label))
      .find((candidate): candidate is DocChildById => candidate !== undefined);
    if (chunk === undefined || citations.some((c) => c.label === span)) continue;
    citations.push(toCitation(span, chunk));
  }
  return {
    messageId,
    citations,
    // The refusal flag is the trace's own decision, projected verbatim: a hybrid
    // answer carries it AND its chips. `traceRefused` (chat-trace.ts) is its reader.
    refusal: traceRefused(trace),
    // The frame's flag and the postprocess's check are the SAME predicate, so "the
    // warning is on the answer" cannot mean two things on the two sides of the wire.
    dhaifWarning: hasWeakWarning(answerText),
  };
}

/**
 * The live route's entry for a just-answered question: derives BOTH wire frames from
 * the one persisted trace with ONE shared store read. A store-read failure degrades
 * both frames honestly (empty citations, id-only panel rows) with one warning, and each
 * frame is parsed against its contract before it touches the wire.
 */
export async function answerFramesFor(input: {
  trace: Trace;
  messageId: string;
  answerText: string;
  fetchChunks: CitationChunkSource;
  warn: Warn;
}): Promise<{ citations: ChatCitationsFrame; trace: ChatTraceFrame }> {
  const { trace, messageId, answerText, fetchChunks, warn } = input;
  // A pure refusal needs no store read: an empty id list would only round-trip the seam.
  const ids = traceChunkIds(trace);
  const chunksById =
    ids.length === 0
      ? new Map<string, DocChildById>()
      : await chunksByIdOrEmpty({
          ids,
          fetchChunks,
          warn,
          warnKey: "chat.answer.chunk_lookup_failed",
          warnFields: { messageId },
        });
  return {
    citations: v.parse(
      ChatCitationsFrameSchema,
      deriveCitationsFrame({ trace, messageId, answerText, chunksById }),
    ),
    trace: v.parse(ChatTraceFrameSchema, deriveTraceFrame({ trace, messageId, chunksById })),
  };
}

/**
 * Rehydrate a full transcript: map persisted chat rows onto the rehydration contract,
 * deriving each assistant message's citation frame from ITS persisted trace — the same
 * derivation the live `citations` frame uses. The same trace derives the Trace panel
 * frame, and display data is fetched in ONE store read; a missing trace degrades to a
 * plain-text message, and a contract-invalid frame degrades independently.
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
  // One store read for the whole transcript, via the same helper the live frame uses.
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
    // Both frames derive independently from the SAME trace and display rows, so a
    // degraded frame stays absent, never invented.
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
    }
    const traceParsed = v.safeParse(
      ChatTraceFrameSchema,
      deriveTraceFrame({ trace, messageId: row.id, chunksById }),
    );
    if (!traceParsed.success) {
      warn("chat.rehydration.invalid_trace_frame", { messageId: row.id });
    }
    return {
      ...base,
      ...(parsed.success ? { citations: parsed.output } : {}),
      ...(traceParsed.success ? { trace: traceParsed.output } : {}),
    };
  });
  return v.parse(ChatSessionMessagesSchema, { sessionId, messages, truncated });
}
