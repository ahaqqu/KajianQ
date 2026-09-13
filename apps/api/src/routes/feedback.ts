import {
  FEEDBACK_INITIAL_STATUS,
  type FeedbackAnchor,
  type FeedbackResponse,
} from "@app/contracts";
import { createLogger } from "@app/infra";
import { newRouter } from "../lib/guard";
import { authGuard, buildStoreWiring, wiringOr503 } from "../lib/chat-wiring";
import {
  FEEDBACK_OPENAPI,
  chunkFetcher,
  deriveFeedbackCitations,
  parseFeedbackRequest,
  validateFeedbackAnchor,
} from "../lib/feedback";

/**
 * POST /v1/feedback (#13, ADR-0007): anonymous thumbs up/down per answer, plus
 * trace-anchored flags — the user reports the exact failing element (wrong
 * citation, irrelevant chunk, bad machine translation, questionable grade)
 * from the Trace panel. Zero friction: the anonymous Bearer session the chat
 * already uses is the only credential (ADR-0017 — no account), and the row
 * carries the user id so the self-deletion cascade (ADR-0007 amendment)
 * erases the feedback with its author.
 *
 * Invariants, enforced in order:
 *  1. The body is one feedback shape (a thumb or a flag — never both), by the
 *     shared contract (packages/contracts feedback.ts).
 *  2. The answer exists, has a persisted trace, and belongs to the caller:
 *     feedback only attaches to answers the user saw in their own transcript,
 *     so a flag can never outlive the trace it points into (unknown and
 *     foreign answers are both 404, indistinguishably — the chat-session
 *     route's posture).
 *  3. A flag's anchor is validated against the persisted trace: chunk ids
 *     against the retrieval refs, citation/translation/grade labels against
 *     the server-derived citations frame (lib/feedback.ts). A malformed
 *     anchor is a 422, never a stored row; a DEGRADED derivation (answer
 *     text reclaimed, chunk lookup failed) is a 503 `anchor_unavailable` —
 *     a server-side condition, never blamed on the user's input (thermo-
 *     review A3).
 *
 * Rate limiting is inherited from the /v1 middleware (ADR-0041): the endpoint
 * is metered per-IP like every other /v1 route.
 */

type FeedbackEnv = import("../env").ApiEnv["Bindings"] & Record<string, string | undefined>;

export const feedbackRoutes = newRouter().post(
  "/v1/feedback",
  FEEDBACK_OPENAPI,
  async (c): Promise<Response> => {
    const env = c.env as FeedbackEnv;
    const logger = createLogger({
      service: "api",
      route: "feedback",
      correlationId: c.get("correlationId"),
    });
    // Store-only wiring: feedback never touches the chat pipeline, so a
    // missing LLM role cannot gate reporting (same posture as auth, A4).
    const resolved = wiringOr503(() => buildStoreWiring(env), logger, "feedback_not_configured");
    if ("response" in resolved) return resolved.response;
    const { fullStore, runStore } = resolved.wiring;

    const bodyParse = await parseFeedbackRequest(c.req.raw, logger);
    if (!bodyParse.success) return c.json({ error: bodyParse.error }, 400);
    const req = bodyParse.output;

    const unauthorized = await authGuard(c, fullStore);
    if (unauthorized !== undefined) return unauthorized;
    const { userId } = c.get("authed");

    // The typed StoreBridge carries the success type — no assertion needed
    // (thermo-review B3).
    const target = await runStore(fullStore.getAnswerFeedbackTarget(req.messageId));
    if (target === null || target.userId !== userId) {
      // Unknown answer and someone else's answer: indistinguishable 404.
      return c.json({ error: "not_found" }, 404);
    }

    // The response echoes the trace's CANONICAL message id (thermo-review
    // A2): the row is keyed by it even when the caller looked the answer up
    // by a rehydrated row id, and the client learns the canonical key back.
    const respond = (row: {
      id: string;
      rating: 1 | -1;
      anchor: FeedbackAnchor | null;
    }): FeedbackResponse => ({
      id: row.id,
      messageId: target.messageId,
      rating: row.rating === 1 ? "up" : "down",
      anchor: row.anchor,
      status: FEEDBACK_INITIAL_STATUS,
    });

    // Thumbs: the whole answer is the anchor (anchor_type `answer`).
    if (req.rating !== undefined) {
      const rating = req.rating === "up" ? 1 : -1;
      const id = await runStore(
        fullStore.insertFeedback({
          // Key the row by the canonical trace message id, never the
          // client-held alias (thermo-review A2).
          messageId: target.messageId,
          userId,
          rating,
          anchorType: "answer",
          anchorId: null,
          category: null,
          freeText: req.freeText ?? null,
        }),
      );
      logger.info("feedback.thumb_stored", { rating: req.rating });
      return c.json(respond({ id, rating, anchor: null }));
    }

    // Flag: validate the anchor against the persisted trace before storing.
    // The contract's one-shape check guarantees `anchor` here; the guard
    // narrows instead of asserting (thermo-review B3).
    if (req.anchor === undefined) return c.json({ error: "invalid_request" }, 400);
    const anchor = req.anchor;
    const derived =
      anchor.type === "chunk"
        ? null
        : await deriveFeedbackCitations({
            messageId: target.messageId,
            trace: target.trace,
            answerText: target.answerText,
            fetchChunks: chunkFetcher(fullStore, runStore),
            warn: (msg, fields) => logger.warn(msg, fields),
          });
    // Degraded derivation is a server-side condition (thermo-review A3): the
    // answer text was reclaimed or the chunk lookup failed, so there is
    // nothing honest to validate against — 503, never a user-blaming 422.
    if (derived !== null && derived.degraded) {
      logger.warn("feedback.anchor_derivation_degraded", { reason: derived.reason });
      return c.json({ error: "anchor_unavailable" }, 503);
    }
    if (
      !validateFeedbackAnchor({
        anchor,
        trace: target.trace,
        citations: derived === null ? null : derived.citations,
      })
    ) {
      logger.warn("feedback.anchor_rejected", { type: anchor.type });
      return c.json({ error: "invalid_anchor" }, 422);
    }
    const id = await runStore(
      fullStore.insertFeedback({
        // Canonical trace message id (thermo-review A2).
        messageId: target.messageId,
        userId,
        rating: -1, // a flag is negative feedback by definition
        anchorType: anchor.type,
        anchorId: anchor.id,
        category: anchor.category,
        freeText: req.freeText ?? null,
      }),
    );
    logger.info("feedback.flag_stored", { anchorType: anchor.type, category: anchor.category });
    return c.json(respond({ id, rating: -1, anchor }));
  },
);
