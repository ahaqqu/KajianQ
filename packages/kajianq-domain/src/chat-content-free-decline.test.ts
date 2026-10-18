import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  RunContext,
  type AssembledContext,
  type Decline,
  type RoutedQuery,
  type RunContextService,
} from "@app/rag-core";
import { DEFAULT_REFUSALS } from "./chat-refusal";
import {
  CONTENT_FREE_DECLINE_TEXT,
  createContentFreeDecliner,
  isContentFreeRoute,
} from "./chat-content-free-decline";
import type { KajianQFilters } from "./filters";

/**
 * The decline decision, on its own. What a run that takes it costs is the
 * pipeline-level pin — `chat-content-free-route.test.ts`, which asserts no
 * provider call at all through the real `runChatPipeline` wiring; this file's
 * subject is the decision itself and the copy it delivers.
 *
 * The traps are the near-misses of the marking: a route the model read carries
 * no marking, a route whose marking is absent, and a marking that is present but
 * not the boolean the router's gate writes. None of them is a decline, because a
 * route the model read must never take the canned answer.
 */

type Route = { query: RoutedQuery<KajianQFilters>; context: AssembledContext<KajianQFilters> };

/** A route as the engine hands it to a stage: the router's reading plus the runner's stamps. */
function route(attributes?: Record<string, unknown>): Route {
  const query: RoutedQuery<KajianQFilters> = {
    intent: "factual",
    subQueries: [],
    filters: {},
    ...(attributes !== undefined ? { attributes } : {}),
    sourceText: "\u200b",
  };
  return { query, context: { query, chunks: [], turns: [] } };
}

const GATE_ROUTE = { fallback: true, contentFree: true };

/** One stage call, with the ambient services a stage is written against. */
async function decline(language: "id" | "en", r: Route): Promise<Decline | null> {
  const run: RunContextService = { config: {}, now: () => 0, record: () => {} };
  return Effect.runPromise(
    Effect.scoped(
      Effect.provideService(
        createContentFreeDecliner({ language }).decline(r.query, r.context),
        RunContext,
        run,
      ),
    ),
  );
}

describe("isContentFreeRoute — the router gate's own marking, read one way", () => {
  it("is true only for the marking the gate writes", () => {
    expect(isContentFreeRoute(route(GATE_ROUTE).query)).toBe(true);
    // A route the model read carries no marking at all.
    expect(isContentFreeRoute(route({ madzhab: ["syafii"] }).query)).toBe(false);
    expect(isContentFreeRoute(route().query)).toBe(false);
    // Present but not the boolean the gate writes: a truthy value some other
    // producer marked with is not this gate's decision.
    expect(isContentFreeRoute(route({ contentFree: "true" }).query)).toBe(false);
    expect(isContentFreeRoute(route({ contentFree: 1 }).query)).toBe(false);
    expect(isContentFreeRoute(route({ contentFree: false }).query)).toBe(false);
  });
});

describe("the canned decline", () => {
  it("answers a content-free route in the active language", async () => {
    expect((await decline("id", route(GATE_ROUTE)))?.text).toBe(CONTENT_FREE_DECLINE_TEXT.id);
    expect((await decline("en", route(GATE_ROUTE)))?.text).toBe(CONTENT_FREE_DECLINE_TEXT.en);
  });

  it("declines nothing a question can reach", async () => {
    // The near-misses: a content-bearing question whose route still carries the
    // fallback marking, a route with no attributes at all, and an empty one.
    for (const attributes of [{ fallback: true }, {}, undefined]) {
      expect(await decline("id", route(attributes))).toBeNull();
    }
  });

  it("is not the refusal: other copy, other reason", async () => {
    // The two answers must be tellable apart without opening the trace.
    for (const language of ["id", "en"] as const) {
      expect(CONTENT_FREE_DECLINE_TEXT[language]).not.toContain(DEFAULT_REFUSALS[language]);
    }
    expect(CONTENT_FREE_DECLINE_TEXT.id).not.toBe(CONTENT_FREE_DECLINE_TEXT.en);
    const declined = await decline("id", route(GATE_ROUTE));
    expect(declined?.trigger).toBe("content_free_decline");
    expect(declined?.reason).not.toContain(DEFAULT_REFUSALS.id);
  });
});
