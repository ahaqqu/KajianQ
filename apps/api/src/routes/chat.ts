import { ChatRequestSchema, type CostRecord } from "@app/contracts";
import { describeRoute, resolver } from "hono-openapi";
import * as v from "valibot";
import type { RagStore } from "@app/infra";
import type { ApiEnv } from "../env";
import { authGuard } from "../lib/auth";
import { newRouter } from "../lib/guard";
import {
  createProvidersFromEnv,
  createRagStoreFromEnv,
  storeBridge,
} from "../lib/chat-wiring";
import { runChatPipelinePromise, type ChatPipelineDeps } from "@app/kajianq-domain";

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

/** SSE frame helpers — the wire contract the eval harness consumes. */
function sseFrame(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`;
}

/** The route's env, widened with the provider-key bindings the wiring reads. */
type ChatEnv = ApiEnv["Bindings"] & Record<string, string | undefined>;

/** The wiring bundle a request needs: pipeline deps plus the full store. */
type ChatWiring = {
  pipeline: Omit<ChatPipelineDeps, "language">;
  fullStore: RagStore;
  runStore: (effect: unknown) => Promise<unknown>;
};

/**
 * Build the wiring from bindings. A binding-less environment (local dev
 * without DATABASE_URL) throws config-class from the wiring helpers; the
 * route maps that to 503 before any auth work.
 */
function buildWiring(env: ChatEnv, onCost: (cost: CostRecord) => void): ChatWiring {
  const store = createRagStoreFromEnv(env);
  const providers = createProvidersFromEnv(env);
  return {
    pipeline: {
      routerProvider: providers.router,
      generatorProvider: providers.generator,
      reviewerProvider: providers.reviewer,
      embedder: providers.embedder,
      store,
      // The bridge crosses the effect-version boundary (wiring owns the
      // runtime import); the single cast is bounded to this line.
      bridge: storeBridge(store) as ChatPipelineDeps["bridge"],
      onCost,
    },
    fullStore: store,
    runStore: storeBridge(store) as (effect: unknown) => Promise<unknown>,
  };
}

export const chatRoutes = newRouter().post(
  "/v1/chat",
  describeRoute({
    summary: "Chat",
    responses: {
      200: {
        description: "SSE stream of answer deltas",
        content: { "text/event-stream": { schema: resolver(v.any()) } },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: resolver(v.any()) } },
      },
    },
  }),
  async (c) => {
    const env = c.env as ChatEnv;
    let wiring: ChatWiring;
    try {
      wiring = buildWiring(env, () => {});
    } catch {
      return c.json({ error: "chat_not_configured" }, 503);
    }

    const bodyParse = v.safeParse(ChatRequestSchema, await c.req.json().catch(() => null));
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
    await runStore(
      store.insertChatMessage({ sessionId, role: "user", content: req.message }),
    );

    const answerMessageId = crypto.randomUUID();
    const traceId = crypto.randomUUID();

    const answer = await runChatPipelinePromise(
      { ...wiring.pipeline, language: req.language ?? "id" },
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
  },
);