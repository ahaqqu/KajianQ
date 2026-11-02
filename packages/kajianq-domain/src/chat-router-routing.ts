import { Effect } from "effect";
import type { Routing, RunContextService, SubQuery } from "@app/rag-core";
import { decomposeQuery } from "./chat-router-decompose";
import type { RouterReading } from "./chat-router-output";
import { routeFilters, sourceRoutingDetail, type SourceRoutingInput } from "./chat-source-routing";

/**
 * Route assembly: what the router returns once it has a reading (or none) — the
 * decomposition, the filters stage 3 derives from it, and the deterministic
 * fallback for a reply that could not be read. The stage in `chat-router.ts`
 * asks the model and records the call; this module owns how a reading (or the
 * absence of one) becomes a `Routing`, so both arms cross one boundary and the
 * Trace's `source_routing` event is written by the code that built the route.
 */

/**
 * Record the route's `source_routing` decision and hand the route back — the one
 * boundary both arms cross, so the gate's deterministic route and the model's
 * reading fail the same way. Building the route is inside the boundary too:
 * `routeFilters` reads every Sub-query's role through `roleSources`, and
 * `sourceRoutingDetail` reads the filter record through `filterEntries`; either
 * throws on something the store cannot express, and that throw is a stage failure
 * — the declared `Effect<Routing, StageError>` — never a defect escaping a channel
 * the stage does not declare.
 */
export function recordRouting(
  run: RunContextService,
  build: () => Routing<import("./filters").KajianQFilters>,
): Effect.Effect<Routing<import("./filters").KajianQFilters>, { cause: unknown }> {
  return Effect.gen(function* () {
    const { routing, decision } = yield* Effect.try({
      try: () => {
        const routing = build();
        return { routing, decision: sourceRoutingDetail(routing.filters) };
      },
      catch: (cause: unknown) => ({ cause }),
    });
    run.record({
      stage: "router",
      kind: "source_routing",
      detail: decision,
      at: run.now(),
    });
    return routing;
  });
}

/** What a usable reply routes to: the classification, sub-queries, and stage 3's filters.
 * `historyTurns` is the window the call carried (chat-router-prompt.ts), absent on a
 * single-turn call — the intent event's attributes are where the Trace records that a
 * follow-up's retrieval was resolved from prior turns. */
export function routingOf(
  reading: RouterReading,
  question: string,
  historyTurns: number,
): Routing<import("./filters").KajianQFilters> {
  // The decomposition first, deliberately: stage 3's source selection is the
  // union of the category and the roles of the parts retrieval will *actually*
  // fan out over — repairs and the ceiling included — so a source is never
  // selected for a part the route dropped, nor missed for a part it runs.
  const subQueries = decomposeQuery({
    question,
    needsPrinciple: reading.needsPrinciple,
    principleTags: reading.principleTags,
    ...(reading.category !== undefined ? { category: reading.category } : {}),
    modelSubQueries: reading.modelSubQueries,
  });
  const filters = routeFilters(routingInputOf(reading, subQueries));
  return {
    intent: reading.intent,
    subQueries,
    filters,
    ...(reading.confidence !== undefined ? { confidence: reading.confidence } : {}),
    ...(reading.reasoning !== undefined ? { reasoning: reading.reasoning } : {}),
    // The EFFECTIVE filters, not the model's hints: they are what retrieval
    // runs with, and the payload that claims to say what was understood must
    // not disagree with the search it caused.
    attributes: { ...reading.attributes, ...filters, ...historyAttribute(historyTurns) },
  };
}

/** The window a call carried, as trace content: present only when there was one, so a
 * single-turn trace keeps the exact shape it had and absence means "no prior turns". */
function historyAttribute(historyTurns: number): Record<string, unknown> {
  return historyTurns > 0 ? { historyTurns } : {};
}

/** The router's reading, as source routing reads it. */
function routingInputOf(
  reading: RouterReading,
  subQueries: readonly SubQuery[],
): SourceRoutingInput {
  return {
    intent: reading.intent,
    ...(reading.category !== undefined ? { category: reading.category } : {}),
    needsPrinciple: reading.needsPrinciple,
    filters: reading.filters,
    subQueries,
  };
}

/**
 * The stage's deterministic fallback: what the router routes to when no model
 * reading routes the query. Two shapes reach it — the caller's text is not a
 * query, so none was asked for (`question === undefined`), or the model's reply
 * could not be read (`question` is the admitted question then) — and both are
 * marked `fallback` on the intent event, so the Trace never presents a
 * deterministic route as the model's judgment. `contentFree` tells the two
 * apart on the trace: a reader can see that the router had nothing to ask about,
 * not that the model answered badly.
 *
 * `question` is the caller's text *after* the one admission — trimmed, and
 * `undefined` when it carries no letter and no digit. A text that cannot
 * retrieve contributes no sub-query, so this arm fans out over nothing and
 * retrieval short-circuits before any embed or search: the same treatment the
 * decomposer gives that text under any origin, taken one stage earlier.
 *
 * `historyTurns` records the window the failed call carried: the call still
 * happened and still cost money, and the answer's Trace must show that the
 * fallback route was given prior turns even though it could not use the reply.
 */
export function fallbackRouting(
  overrides: import("./filters").KajianQFilters,
  question: string | undefined,
  historyTurns = 0,
): Routing<import("./filters").KajianQFilters> {
  return {
    intent: "factual",
    subQueries:
      question === undefined ? [] : [{ text: question, role: "factual", origin: "fallback" }],
    filters: overrides,
    // The effective filters reach retrieval, so they belong in the payload that
    // claims to say what was understood: a trace reader must be able to tell
    // which filters this route actually ran with (chat-router-output.ts's
    // `attributes` contract). `fallback: true` is what marks the route as the
    // deterministic one; it is never the whole payload.
    attributes: {
      fallback: true,
      ...(question === undefined ? { contentFree: true } : {}),
      ...overrides,
      ...historyAttribute(historyTurns),
    },
  };
}
