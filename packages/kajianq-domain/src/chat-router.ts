import { Effect } from "effect";
import { RunContext, toStageError, type CostRecord, type Query, type Router } from "@app/rag-core";
import { readRouterText } from "./chat-router-output";
import { routerCallFor } from "./chat-router-prompt";
import { fallbackRouting, recordRouting, routingOf } from "./chat-router-routing";

export { extractJsonObject } from "./chat-router-output";
export { ROUTER_SYSTEM_PROMPT } from "./chat-router-prompt";

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
 * filter record of the decision — the store receives that same decision with
 * each value's derived case attached as data — so "which sources were searched,
 * with which filters the route decided" is derivable from the persisted trace
 * rather than inferred from the router's prose.
 *
 * The stage returns a `Routing` — what it understood — not a `RoutedQuery`:
 * the engine's runner stamps the caller's verbatim question and prior turns
 * onto it, so the fields downstream stages read are guaranteed rather than
 * echoed back by this stage (ADR-0018).
 *
 * **A follow-up is routed from the session's own prior turns.** The call
 * carries a bounded window of them (chat-router-prompt.ts owns the window and
 * the follow-up rule), so a question that names its topic only by reference —
 * "Apa dalilnya?", "Jelaskan hadits itu" — can be decomposed into retrieval
 * sub-queries about that topic instead of about the follow-up's own words. The
 * verbatim question is never rewritten from history: `sourceText` stays what
 * the caller typed, and only the sub-queries may resolve the reference. A
 * question that stands on its own is routed from its own words: the rule's other
 * arm says so, and the stage never folds a prior turn into a sub-query itself.
 * The window the call actually carried is recorded on the intent event's
 * attributes as how many prior turns it carried, so a follow-up answer's
 * evidence — how much prior context it saw, which sub-queries it ran, which
 * chunks came back — is auditable from the Trace.
 *
 * The route is **gated on the question, before the call**: the router's input
 * is the caller's question, and a text carrying no letter and no digit is not a
 * question. The stage declines it there — no classification is asked for, so no
 * sub-query can be invented for it, no composition rule fires (every rule's text
 * embeds the question, and there is no question to embed), and retrieval fans
 * out over nothing: no embed, no search. The route it returns is the deterministic
 * fallback (chat-router-routing.ts), carrying no sub-query and marked on the Trace.
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

/**
 * The router's sampling, pinned at the call to the vendor's deterministic
 * setting. The router's classification decides source routing, so a reading
 * that varies between runs searches a different corpus for the same question:
 * determinism is the stage's contract. It is deliberately code, not a
 * deployment knob — config names which model serves a stage (ADR-0009), and a
 * sampling dial would let a deployment re-open the variance. The answer
 * generator's sampling is a product decision and is not set here.
 */
const ROUTER_SAMPLING = { temperature: 0 };

export type RouterProvider = {
  generate(spec: {
    turns: readonly { role: string; content: string }[];
    /**
     * Required, never optional, on the serving seam: the router prompt
     * carries the user's chat question and any prior turns of the session,
     * which are personal data (ADR-0043 Consequences). A non-optional field
     * makes dropping the flag a compile error at the call site, and the flag
     * makes `FallbackProvider` skip free-tier candidates for the call
     * (`personalDataAllowed`, ADR-0009).
     */
    personalData: true;
    /**
     * Per-model wire settings, passed through by the provider seam. Required,
     * like `personalData`: the router's determinism depends on this call
     * carrying its sampling, so an optional field would let a call site drop it
     * without a compile error.
     */
    options: Record<string, unknown>;
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
          const call = routerCallFor(query.text, query.history);
          if (call.question === undefined) {
            return yield* recordRouting(run, () => fallbackRouting(overrides, call.question));
          }
          const reply = yield* provider
            .generate({
              turns: call.turns,
              // The user's question and any prior turns are personal data — never
              // a free-tier ride (ADR-0043 Consequences; enforced by the
              // provider seam).
              personalData: true,
              options: ROUTER_SAMPLING,
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
          // one. A pinned key outside the filter vocabulary — a retired
          // dimension — is rejected by that same mapping as a typed stage
          // failure before a search runs.
          return yield* recordRouting(run, () =>
            reading === undefined
              ? fallbackRouting(overrides, call.question, call.historyTurns)
              : routingOf(reading, query.text, call.historyTurns),
          );
        }),
      ),
  };
}
