import { newRouter } from "../lib/guard";
import {
  authGuard,
  buildChatWiring,
  sseFrame,
  ChatConfigError,
  type ChatWiring,
} from "../lib/chat-wiring";
import { CHAT_OPENAPI_DESCRIPTION, parseChatRequest } from "../lib/chat-openapi";
import { createLogger } from "@app/infra";
import { runChatPipelinePromise } from "@app/kajianq-domain";

/** The route's env, widened with the provider-key bindings the wiring reads. */
type ChatEnv = import("../env").ApiEnv["Bindings"] & Record<string, string | undefined>;

/**
 * POST /v1/chat (#8): the guarded, SSE-streamed chat surface. Validates the
 * body, resolves auth, creates the session, persists the user message, runs
 * the KajianQ pipeline through the engine runner, persists the answer trace +
 * assistant message, and streams the answer to the client. Every LLM call's
 * cost lands on the persisted trace (traceability rule 4) — the route never
 * hand-assembles one (ADR-0021). Effect bridging goes through the domain's
 * promise runner and the wiring's store bridge — no direct effect runtime
 * import here (ADR-0027 decision 3).
 */

export const chatRoutes = newRouter().post("/v1/chat", CHAT_OPENAPI_DESCRIPTION, async (c) => {
  const env = c.env as ChatEnv;
  const logger = createLogger({
    service: "api",
    route: "chat",
    correlationId: c.get("correlationId"),
  });
  let wiring: ChatWiring;
  try {
    wiring = buildChatWiring(env);
  } catch (err) {
    // A7: only a typed config failure is "not configured"; anything else
    // (adapter bug, malformed URL, transient infra fault) falls through to
    // the app's typed error handler with its cause logged, never masked.
    if (err instanceof ChatConfigError) {
      logger.warn("chat.not_configured", { missing: err.missing ?? "unknown" });
      return c.json({ error: "chat_not_configured" }, 503);
    }
    throw err;
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
  await runStore(store.insertChatMessage({ sessionId, role: "user", content: req.message }));

  const answerMessageId = crypto.randomUUID();
  const traceId = crypto.randomUUID();

  const answer = await runChatPipelinePromise(
    { ...wiring.pipeline, language: req.language ?? "id" } as Parameters<
      typeof runChatPipelinePromise
    >[0],
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

  // The engine pipeline is not streamed stage-by-stage yet; the SSE wire
  // contract (meta → deltas → done) is in place from the start so the PWA
  // and the eval harness consume it unchanged.
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
      controller.enqueue(enc.encode(sseFrame("delta", answer.text)));
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
