import { Effect } from "effect";
import {
  RunContext,
  toStageError,
  type CostRecord,
  type Query,
  type Router,
  type Routing,
  type SubQuery,
} from "@app/rag-core";
import { decomposeQuery } from "./chat-router-decompose";
import { readRouterText, ROUTER_SYSTEM_PROMPT, type RouterReading } from "./chat-router-output";
import { routeFilters, sourceRoutingDetail, type SourceRoutingInput } from "./chat-source-routing";

export { extractJsonObject, ROUTER_SYSTEM_PROMPT } from "./chat-router-output";

/**
 * KajianQRouter — Smart Router stages 1–3 (spec §3.3, CONTEXT.md "Smart
 * Router"): intent & Principle detection, query decomposition, and source
 * routing with metadata filters. Model choice comes from the wiring's
 * injected Provider (config, never here); the call's cost is recorded to the
 * run's trace sink (ADR-0021).
 *
 * Stages 1–2 ride one cheap-tier call returning JSON. Stage 3 is **rules, not
 * a second call**: which sources may answer a question is a product decision
 * with a published justification (the usul authority order, spec §2.2), and a
 * model that gets it wrong narrows the corpus silently — so the model hints
 * and `chat-source-routing.ts` decides. The decision is recorded as its own
 * typed `source_routing` event carrying the selected sources and the exact
 * filter record retrieval is handed, so "which sources were searched, with
 * which filters" is derivable from the persisted trace rather than inferred
 * from the router's prose.
 *
 * The stage returns a `Routing` — what it understood — not a `RoutedQuery`:
 * the engine's runner stamps the caller's verbatim question and prior turns
 * onto it, so the fields downstream stages read are guaranteed rather than
 * echoed back by this stage (ADR-0018).
 *
 * An unusable reply (unparseable JSON, or a classification outside the
 * vocabulary) lands on the deterministic fallback: one factual sub-query made
 * of the verbatim question, marked `origin: "fallback"` and flagged on the
 * intent event's attributes, so the Trace never presents an invented
 * classification as the model's reading. The fallback selects no source — a
 * route that understood nothing must not narrow the corpus on a guess — and
 * says so with an empty `sources` list.
 */

export type RouterProvider = {
  generate(spec: {
    turns: readonly { role: string; content: string }[];
    /**
     * Required, never optional, on the serving seam: the router prompt
     * carries the user's chat question, which is personal data
     * (ADR-0043 Consequences — the measured gap this type now closes). A
     * non-optional field makes dropping the flag a compile error at the
     * call site, and the flag makes `FallbackProvider` skip free-tier
     * candidates for the call (`personalDataAllowed`, ADR-0009).
     */
    personalData: true;
  }): Effect.Effect<{ text: string; cost: CostRecord }, unknown>;
};

export function createKajianQRouter(
  provider: RouterProvider,
): Router<import("./filters").KajianQFilters> {
  return {
    route: (query: Query<import("./filters").KajianQFilters>) =>
      toStageError(
        "router",
        Effect.gen(function* () {
          const run = yield* RunContext;
          const reply = yield* provider
            .generate({
              turns: [
                { role: "system", content: ROUTER_SYSTEM_PROMPT },
                { role: "user", content: query.text },
              ],
              // The user's question is personal data — never a free-tier ride
              // (ADR-0043 Consequences; enforced by the provider seam).
              personalData: true,
            })
            .pipe(Effect.mapError((cause) => ({ cause })));
          run.record({
            stage: "router",
            kind: "llm_call",
            detail: { purpose: "intent" },
            cost: reply.cost,
            at: run.now(),
          });
          const overrides = query.filters ?? {};
          const reading = readRouterText(reply.text, overrides);
          // Stage 3's decision, recorded by the stage that made it — and built
          // by the same mapping retrieval uses, over the same decomposition, so
          // the record this stage derived and the record the searches run cannot
          // drift. A dimension the caller pinned is the one exception: the
          // override rides into `routeFilters` verbatim while the event detail
          // publishes its normalized projection (review A4 of the #438 fix
          // round), and no wire request can set one. A role or a dimension the
          // route cannot express fails here, before any search runs, instead of
          // being silently dropped or silently contributing nothing.
          const { routing, decision } = yield* Effect.try({
            try: () => {
              const routing =
                reading === undefined
                  ? fallbackRouting(query.text, overrides)
                  : routingOf(reading, query.text);
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
        }),
      ),
  };
}

/** What a usable reply routes to: the classification, sub-queries, and stage 3's filters. */
function routingOf(
  reading: RouterReading,
  question: string,
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
    attributes: { ...reading.attributes, ...filters },
  };
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
    principleTags: reading.principleTags,
    filters: reading.filters,
    subQueries,
  };
}

/** The reply was unusable: one factual sub-query, visibly marked as the fallback. */
function fallbackRouting(
  question: string,
  overrides: import("./filters").KajianQFilters,
): Routing<import("./filters").KajianQFilters> {
  return {
    intent: "factual",
    subQueries: [{ text: question, role: "factual", origin: "fallback" }],
    filters: overrides,
    // The effective filters reach retrieval, so they belong in the payload that
    // claims to say what was understood: a trace reader must be able to tell
    // which filters this route actually ran with (chat-router-output.ts's
    // `attributes` contract). `fallback: true` is what marks the route as the
    // deterministic one; it is never the whole payload.
    attributes: { fallback: true, ...overrides },
  };
}
