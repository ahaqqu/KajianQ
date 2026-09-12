import {
  ChatCitationsFrameSchema,
  type ChatCitation,
  type ChatCitationsFrame,
  type Trace,
} from "@app/contracts";
import type { DocChildById, RagStore } from "@app/infra";
import {
  citationCandidatesIn,
  citationLabelsOf,
  dhaifWarning as dhaifWarningLine,
  normalizeCitationLabel,
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
export type CitationChunkSource = (
  ids: readonly string[],
) => Promise<readonly DocChildById[]>;

/** Bind a {@link CitationChunkSource} to a wired store + its Effect bridge. */
export function chunkFetcher(
  store: Pick<RagStore, "getDocChildrenByIds">,
  runStore: (effect: unknown) => Promise<unknown>,
): CitationChunkSource {
  return async (ids) =>
    (await runStore(store.getDocChildrenByIds(ids))) as readonly DocChildById[];
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
    // The assembler labels every chunk rendered with both layers, so the
    // translation the answer quoted from is machine-made exactly when a
    // translation layer exists at all (ADR-0006 as implemented).
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
  warn: (msg: string, fields?: Record<string, string | number | boolean | null>) => void;
}): Promise<ChatCitationsFrame> {
  const { trace, messageId, answerText, fetchChunks, warn } = input;
  if (trace.events.some((event) => event.kind === "refusal")) {
    return { messageId, citations: [], refusal: true, dhaifWarning: false };
  }
  let chunks: readonly DocChildById[] = [];
  try {
    chunks = await fetchChunks(traceChunkIds(trace));
  } catch (err) {
    // Degrade honestly: no chips, not wrong chips. Ops sees why.
    warn("chat.citations.chunk_lookup_failed", {
      messageId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const byId = new Map<string, DocChildById>(chunks.map((c) => [c.id, c]));
  return v.parse(
    ChatCitationsFrameSchema,
    deriveCitationsFrame({ trace, messageId, answerText, chunksById: byId }),
  );
}
