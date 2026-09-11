import { newRouter } from "../lib/guard";
import { authGuard, chatWiringOr503, sseFrame, type ChatWiring } from "../lib/chat-wiring";
import { CHAT_OPENAPI_DESCRIPTION, parseChatRequest } from "../lib/chat-openapi";
import { createLogger } from "@app/infra";
import { runChatPipelinePromise, type ChatPipelineDeps } from "@app/kajianq-domain";

/** The route's env, widened with the provider-key bindings the wiring reads. */
type ChatEnv = import("../env").ApiEnv["Bindings"] & Record<string, string | undefined>;

/** How many prior turns of a session ride the prompt (follow-up context). */
const HISTORY_LIMIT = 10;

/**
 * POST /v1/chat (#10): the guarded, SSE-streamed chat surface. Validates the
 * body, resolves auth, creates the session, persists the user message, loads
 * the session's prior turns for follow-up context, runs the KajianQ pipeline
 * through the engine runner, persists the answer trace + assistant message,
 * and streams the answer to the client. Every LLM call's cost lands on the
 * persisted trace (traceability rule 4) — the route never hand-assembles one
 * (ADR-0021). Effect bridging goes through the domain's promise runner and
 * the wiring's store bridge — no direct effect runtime import here (ADR-0027
 * decision 3).
 *
 * Streaming and the citation gate (the ordering that matters): generation
 * streams from the vendor through `Provider.stream`, so the answer is never
 * buffered inside a single vendor round-trip, and the route re-emits the
 * vendor's own delta sequence on the wire. The reviewer still sees the
 * *complete* answer before any of it is delivered — the citation invariant is
 * checked on the whole text — and a refused answer replaces the deltas with a
 * single `refusal` frame carrying the plain refusal. A fabricated citation
 * therefore never reaches the user as an answer, only as a refusal.
 *
 * The trade-off, stated plainly: this gives up time-to-first-token (deltas
 * are replayed after validation rather than as they arrive) in exchange for
 * never putting an unvalidated citation on the wire. For a product whose #1
 * stated risk is hallucinated religious content, that is the correct side of
 * the trade. It is recorded in SPECS §3.3 and flagged in the PR.
 */
export const chatRoutes = newRouter().post("/v1/chat", CHAT_OPENAPI_DESCRIPTION, async (c) => {
  const env = c.env as ChatEnv;
  const logger = createLogger({
    service: "api",
    route: "chat",
    correlationId: c.get("correlationId"),
  });
  let wiring: ChatWiring;
  {
    // B1: one shared wiring→503 posture (chat-wiring.ts), not a per-route copy.
    const resolved = chatWiringOr503(env, logger, "chat_not_configured");
    if ("response" in resolved) return resolved.response;
    wiring = resolved.wiring;
  }

  const bodyParse = await parseChatRequest(c.req.raw, logger);
  if (!bodyParse.success) {
    // C3: distinct, diagnostic codes for JSON-parse vs schema failures.
    return c.json({ error: bodyParse.error }, 400);
  }
  const req = bodyParse.output;

  const store = wiring.fullStore;
  const unauthorized = await authGuard(c, store);
  if (unauthorized !== undefined) return unauthorized;
  const { userId } = c.get("authed");

  // Session + user message, via the store seam (promise-shaped bridge).
  // A6: an explicitly supplied sessionId appends to that session (validated
  // to belong to the authenticated user); absent = a new session.
  const runStore = wiring.runStore;
  let sessionId = req.sessionId ?? null;
  if (sessionId !== null) {
    const owner = (await runStore(store.getChatSessionUser(sessionId))) as string | null;
    if (owner !== userId) {
      return c.json({ error: "invalid_request" }, 404);
    }
  } else {
    sessionId = (await runStore(store.createChatSession({ userId }))) as string;
  }

  // Follow-up context: the session's prior turns, loaded BEFORE this question
  // is persisted so the current message is not duplicated into its own
  // history. A history-read failure is not fatal — the question is still
  // answerable single-turn — but it is logged, never silently swallowed.
  const history = await loadHistory(store, runStore, sessionId, logger);

  await runStore(store.insertChatMessage({ sessionId, role: "user", content: req.message }));

  const answerMessageId = crypto.randomUUID();
  const traceId = crypto.randomUUID();

  // Vendor deltas as they are produced. They are replayed only after the
  // reviewer validated the complete answer (see the module comment).
  const deltas: string[] = [];

  const answer = await runChatPipelinePromise(
    // B6: typed as the domain's own deps shape so the literal is
    // compile-checked — no `as Parameters<…>` cast to hide a rename.
    {
      ...wiring.pipeline,
      language: req.language ?? "id",
      ...(history.length > 0 ? { history } : {}),
      onDelta: (delta: string) => deltas.push(delta),
    } satisfies ChatPipelineDeps,
    { text: req.message },
    {},
    {
      traceId,
      onFailedTrace: (trace) => {
        // A failed run's trace still persists (traceability guardrail);
        // persistence failure here must not mask the pipeline error — but
        // C4: it is logged (structured, with the correlation id) so a lost
        // trace is never silent.
        void runStore(store.insertAnswerTrace({ messageId: answerMessageId, userId, trace })).catch(
          (err: unknown) => {
            logger.warn("answer_trace.persist_failed", {
              messageId: answerMessageId,
              traceId: trace.id,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        );
      },
    },
  );

  // Persist the settled answer trace + assistant message, then stream.
  await runStore(
    store.insertAnswerTrace({ messageId: answerMessageId, userId, trace: answer.trace }),
  );
  await runStore(
    store.insertChatMessage({
      sessionId,
      role: "assistant",
      content: answer.text,
      answerTraceId: answer.trace.id,
    }),
  );

  // The SSE wire contract (meta → deltas → done, ADR-0034). A refused answer
  // never ships the vendor's text: the reviewer recorded a `refusal` event on
  // the trace (the same signal the eval harness reads), and the frames carry
  // the plain refusal instead. Otherwise the vendor's own delta sequence is
  // replayed when it reproduces the delivered text; post-processing may have
  // APPENDED deterministic rules (disclaimer, dhaif warning), which ride one
  // trailing delta so the model's streamed text stays byte-identical on the
  // wire. When generation did not stream at all, the text is chunked.
  const refused = answer.trace.events.some((e) => e.kind === "refusal");
  const streamed = deltas.join("");
  const frames = refused
    ? chunkText(answer.text)
    : streamed !== "" && answer.text.startsWith(streamed)
      ? [...deltas, ...chunkText(answer.text.slice(streamed.length))]
      : chunkText(answer.text);

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(
        enc.encode(
          sseFrame(
            "meta",
            JSON.stringify({ sessionId, messageId: answerMessageId, traceId: answer.trace.id }),
          ),
        ),
      );
      for (const delta of frames) {
        controller.enqueue(enc.encode(sseFrame("delta", delta)));
      }
      controller.enqueue(enc.encode(sseFrame("done", "{}")));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=UTF-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
});

/**
 * Chunk text into SSE-sized deltas (non-streaming providers, refusals).
 * A slice loop, not a built regex: the chunk size is a compile-time constant,
 * and constructing a regex from a variable is the ReDoS pattern the security
 * scan blocks (and needs no regex here).
 */
const CHUNK_SIZE = 512;
function chunkText(text: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK_SIZE) {
    chunks.push(text.slice(i, i + CHUNK_SIZE));
  }
  return chunks;
}

/**
 * Load the session's prior turns for follow-up context. Returns `[]` on a
 * store failure (the question remains answerable) with a structured warning —
 * a missing history must be visible in ops, never a silent quality drop.
 */
async function loadHistory(
  store: ChatWiring["fullStore"],
  runStore: ChatWiring["runStore"],
  sessionId: string,
  logger: ReturnType<typeof createLogger>,
): Promise<{ role: string; content: string }[]> {
  try {
    const rows = (await runStore(store.getChatMessages(sessionId, { limit: HISTORY_LIMIT }))) as
      | readonly { role: string; content: string }[]
      | null;
    if (!Array.isArray(rows)) return [];
    return rows.map((m) => ({ role: m.role, content: m.content }));
  } catch (err) {
    logger.warn("chat.history_unavailable", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
