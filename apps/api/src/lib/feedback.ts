import { type ChatCitationsFrame, type FeedbackAnchor, type Trace } from "@app/contracts";
import { deriveCitationsFrame } from "./chat-citations";
import {
  chunksByIdOrEmpty,
  chunkFetcher,
  traceChunkIds,
  type CitationChunkSource,
  type Warn,
} from "./chat-trace";

// The route needs the same fetcher the derivation binds; re-exported here so
// the route imports one lib module (same pattern as the chat-wiring hub).
export { chunkFetcher };
// The OpenAPI description and body parse live in their own module so this one
// keeps the anchor invariant under the agentic import cap; re-exported here so
// the route imports one lib module too.
export { FEEDBACK_OPENAPI, parseFeedbackRequest } from "./feedback-openapi";

/**
 * The feedback route's anchor validation, split from the route file so the
 * handler stays under the agentic caps. The OpenAPI description and body parse
 * live in `feedback-openapi.ts` and are re-exported here.
 *
 * The invariant this module owns: **a flag may only anchor an element the
 * persisted trace actually grounds.** Chunk anchors must be trace chunk refs
 * (the Trace panel's rows); citation/translation/grade anchors must be labels
 * the server-side citations derivation emits for that answer (the chips and
 * their passage sheet). A flag for an element the trace does not ground is
 * malformed — the same "never without provenance" posture the citations frame
 * itself takes (ADR-0040) — so a report is always actionable.
 */
/**
 * The citations-frame derivation a flag's label must appear in: a frame, or
 * the reason the derivation DEGRADED — the answer text was reclaimed, or the
 * chunk lookup failed. A degraded derivation is a server side problem (nothing
 * honest to validate against), never a malformed anchor, and the route answers
 * it differently.
 */
export type FeedbackCitationsDerivation =
  | { degraded: false; citations: ChatCitationsFrame }
  | { degraded: true; reason: "answer_text_missing" | "chunk_lookup_failed" };

/**
 * Derive the citations frame a flag's label must appear in — the exact
 * derivation the live `citations` frame uses, so the server validates the
 * anchor against the elements the client actually saw. Degraded when the
 * answer text is gone (the message row was reclaimed) or the chunk lookup
 * failed: the degraded-derive posture (no fabricated data) means there is
 * nothing honest to validate against, which is a 503-class condition, not a
 * user error.
 */
export async function deriveFeedbackCitations(input: {
  messageId: string;
  trace: Trace;
  answerText: string | null;
  fetchChunks: CitationChunkSource;
  warn: Warn;
}): Promise<FeedbackCitationsDerivation> {
  if (input.answerText === null) return { degraded: true, reason: "answer_text_missing" };
  // The degrade-and-derive fetch reports its own failure through `warn`;
  // intercept that key so degradation is distinguishable from a derivation
  // that honestly produced a frame without the flagged label.
  let chunkLookupFailed = false;
  const warn: Warn = (msg, fields) => {
    if (msg === "feedback.anchor.chunk_lookup_failed") chunkLookupFailed = true;
    input.warn(msg, fields);
  };
  const ids = traceChunkIds(input.trace);
  const chunksById = await chunksByIdOrEmpty({
    ids,
    fetchChunks: input.fetchChunks,
    warn,
    warnKey: "feedback.anchor.chunk_lookup_failed",
    warnFields: { messageId: input.messageId },
  });
  if (chunkLookupFailed) return { degraded: true, reason: "chunk_lookup_failed" };
  return {
    degraded: false,
    citations: deriveCitationsFrame({
      trace: input.trace,
      messageId: input.messageId,
      answerText: input.answerText,
      chunksById,
    }),
  };
}

/**
 * Is the anchor grounded? A chunk id must be a trace retrieval ref; a
 * citation/translation/grade label must be a label of the derived citations
 * frame — and translation/grade additionally require the cited sheet to
 * actually carry that layer (flagging a translation that does not exist is
 * itself malformed). A grade anchor is valid only for a citation that renders
 * the flattened grade (no per-chain rows, not unread); a chain anchor must name
 * a row the citation actually rendered, at that position and with that row's
 * own grade and grader.
 */
export function validateFeedbackAnchor(input: {
  anchor: FeedbackAnchor;
  trace: Trace;
  citations: ChatCitationsFrame | null;
}): boolean {
  const { anchor, trace, citations } = input;
  if (anchor.type === "chunk") return traceChunkIds(trace).includes(anchor.id);
  if (citations === null) return false;
  const citation = citations.citations.find((c) => c.label === anchor.id);
  if (citation === undefined) return false;
  if (anchor.type === "translation") return citation.translation !== undefined;
  if (anchor.type === "chain") {
    const chain = citation.chains?.[anchor.chainIndex];
    return chain !== undefined && chain.grade === anchor.grade && chain.grader === anchor.grader;
  }
  if (anchor.type === "grade") {
    return (
      citation.grade !== undefined &&
      citation.chainsUnread !== true &&
      (citation.chains === undefined || citation.chains.length === 0)
    );
  }
  return true; // "citation"
}

/**
 * The id a flag persists under. A chain flag names its row in that id because the
 * feedback table's natural key is (anchor_type, anchor_id, category): without the
 * position, complaints about two rows of one citation would update one record and
 * the review queue could not tell them apart.
 */
export function feedbackAnchorRowId(anchor: FeedbackAnchor): string {
  return anchor.type === "chain" ? `${anchor.id}#chain:${anchor.chainIndex}` : anchor.id;
}
