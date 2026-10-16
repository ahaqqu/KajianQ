import { Effect } from "effect";
import {
  RunContext,
  toStageError,
  type CostRecord,
  type Query,
  type Router,
  type Routing,
  type RunContextService,
  type SubQuery,
} from "@app/rag-core";
import { admitSubQueryText, decomposeQuery } from "./chat-router-decompose";
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
 * The route is **gated on the question, before the call**: the router's input
 * is the caller's question, and a text carrying no letter and no digit is not a
 * question. The stage declines it there — no classification is asked for, so no
 * sub-query can be invented for it, no composition rule fires (every rule's text
 * embeds the question, and there is no question to embed), and retrieval fans
 * out over nothing: no embed, no search. The route it returns is the deterministic
 * fallback below, carrying no sub-query and marked on the Trace.
 *
 * An unusable reply (unparseable JSON, or a classification outside the
 * vocabulary) lands on that same fallback: one factual sub-query made
 * of the verbatim question, marked `origin: "fallback"` and flagged on the
 * intent event's attributes, so the Trace never presents an invented
 * classification as the model's reading. The fallback selects no
 * source — a route that understood nothing must not narrow the corpus on a guess
 * — and says so with an empty `sources` list. The invariant behind both arms is
 * one admission — trim, then the content test — owned by
 * `chat-subquery-admission`, asked of the caller's question at the gate and of
 * every text that reaches the fan-out (`decomposeQuery`'s `push`), because the
 * reply's phrasing, a rule's own text and the fallback are each an
 * origin a text can reach the fan-out from.
 */

export type RouterProvider = {
  generate(spec: {
    turns: readonly { role: string; content: string }[];
    /**
     * Required, never optional, on the serving seam: the router prompt
     * carries the user's chat question, which is personal data (ADR-0043
     * Consequences). A non-optional field makes dropping the flag a compile
     * error at the call site, and the flag makes `FallbackProvider` skip
     * free-tier candidates for the call (`personalDataAllowed`, ADR-0009).
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
          const overrides = query.filters ?? {};
          const question = admitSubQueryText(query.text);
          if (question === undefined) {
            return yield* recordRouting(run, () => fallbackRouting(overrides, question));
          }
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
          const reading = readRouterText(reply.text, overrides);
          // Stage 3's decision, recorded by the stage that made it — and built
          // by the same mapping retrieval uses, over the same decomposition, so
          // the record this stage derived and the record the searches run cannot
          // drift. A dimension the caller pinned is the one exception: the
          // override rides into `routeFilters` verbatim while the event detail
          // publishes its normalized projection, and no wire request can set
          // one.
          return yield* recordRouting(run, () =>
            reading === undefined
              ? fallbackRouting(overrides, question)
              : routingOf(reading, query.text),
          );
        }),
      ),
  };
}

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
function recordRouting(
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
 */
function fallbackRouting(
  overrides: import("./filters").KajianQFilters,
  question: string | undefined,
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
    },
  };
}
