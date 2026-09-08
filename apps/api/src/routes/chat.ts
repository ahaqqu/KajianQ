import { newRouter } from "../lib/guard";
import { authGuard, buildChatWiring, sseFrame, type ChatWiring } from "../lib/chat-wiring";
import { CHAT_OPENAPI_DESCRIPTION, parseChatRequest } from "../lib/chat-openapi";
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
  let wiring: ChatWiring;
  try {
    wiring = buildChatWiring(env);
  } catch {
    return c.json({ error: "chat_not_configured" }, 503);
  }

  const bodyParse = await parseChatRequest(c.req.raw);
  if (!bodyParse.success) {
    return c.json({ error: "invalid_request" }, 400);
  }
  const req = bodyParse.output;

  const store = wiring.fullStore;
  const unauthorized = await authGuard(c, store);
  if (unauthorized !== undefined) return unauthorized;
  const { userId } = c.get("authed");

  // Session + user message, via the store seam (promise-shaped bridge).
  const runStore = wiring.runStore;
  const sessionId = (await runStore(store.createChatSession({ userId }))) as string;
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
        // persistence failure here must not mask the pipeline error.
        void runStore(store.insertAnswerTrace({ messageId: answerMessageId, userId, trace })).catch(
          () => {},
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
