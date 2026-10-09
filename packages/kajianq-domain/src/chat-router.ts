import { Effect } from "effect";
import {
  RunContext,
  toStageError,
  type CostRecord,
  type Query,
  type Router,
  type Routing,
} from "@app/rag-core";
import { decomposeQuery } from "./chat-router-decompose";
import { readRouterText, ROUTER_SYSTEM_PROMPT, type RouterReading } from "./chat-router-output";

export { extractJsonObject, ROUTER_SYSTEM_PROMPT } from "./chat-router-output";

/**
 * KajianQRouter — Smart Router stages 1–2 (spec §3.3, CONTEXT.md "Smart
 * Router"): intent & Principle detection and query decomposition, one
 * cheap-tier LLM call returning JSON. Model choice comes from the wiring's
 * injected Provider (config, never here); the call's cost is recorded to the
 * run's trace sink (ADR-0021).
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
 * classification as the model's reading.
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
          if (reading === undefined) return fallbackRouting(query.text, overrides);
          return routingOf(reading, query.text);
        }),
      ),
  };
}

/** What a usable reply routes to: the classification plus the repaired sub-queries. */
function routingOf(
  reading: RouterReading,
  question: string,
): Routing<import("./filters").KajianQFilters> {
  return {
    intent: reading.intent,
    subQueries: decomposeQuery({
      question,
      needsPrinciple: reading.needsPrinciple,
      principleTags: reading.principleTags,
      ...(reading.category !== undefined ? { category: reading.category } : {}),
      modelSubQueries: reading.modelSubQueries,
    }),
    filters: reading.filters,
    ...(reading.confidence !== undefined ? { confidence: reading.confidence } : {}),
    ...(reading.reasoning !== undefined ? { reasoning: reading.reasoning } : {}),
    attributes: reading.attributes,
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
