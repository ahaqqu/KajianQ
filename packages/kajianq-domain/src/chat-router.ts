import { Effect, Schema } from "effect";
import type { CostRecord } from "@app/contracts";
import { RunContext, toStageError, type Query, type Router } from "@app/rag-core";
import type { KajianQFilters, Madzhab, Grade, TextLayer } from "./filters";
import { MADZHABS } from "./filters";

/**
 * KajianQRouter — Smart Router stages 1–2 (spec §3.3): intent + principle
 * detection and query decomposition, one cheap-tier LLM call returning JSON.
 * Model choice comes from the wiring's injected Provider (config, never
 * here); the call's cost is recorded to the run's trace sink (ADR-0021).
 */

/** The routed intent JSON the router LLM must return. */
const RouterOutputSchema = Schema.Struct({
  intent: Schema.String,
  subQueries: Schema.Array(Schema.String),
  madzhab: Schema.optional(Schema.String),
  grade: Schema.optional(Schema.String),
  textLayer: Schema.optional(Schema.String),
});

type RouterOutput = Schema.Schema.Type<typeof RouterOutputSchema>;

export type RouterProvider = {
  generate(spec: {
    turns: readonly { role: string; content: string }[];
  }): Effect.Effect<{ text: string; cost: CostRecord }, unknown>;
};

/**
 * Extract the router LLM's JSON object (thermo-review C2): the reply must
 * yield an object carrying the contract's keys — the old first-`{`-to-last-`}`
 * slice accepted any stray-braced prose. `undefined` when extraction fails so
 * the caller records the fallback instead of silently degrading.
 */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "intent" in parsed &&
      "subQueries" in parsed
    ) {
      return parsed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function createKajianQRouter(provider: RouterProvider): Router<KajianQFilters> {
  return {
    route: (query: Query<KajianQFilters>) =>
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
            })
            .pipe(Effect.mapError((cause) => ({ cause })));
          const call: CostRecord = reply.cost;
          const extracted = extractJsonObject(reply.text);
          const parsed = Schema.decodeUnknownEither(RouterOutputSchema)(extracted);
          const out: RouterOutput =
            parsed._tag === "Right"
              ? parsed.right
              : // C2: an unparseable/mis-keyed router reply is recorded, not
                // silently degraded — the fallback single factual sub-query
                // is visible in the trace's `subquery` event.
                (run.record({
                  stage: "router",
                  kind: "subquery",
                  detail: { text: query.text },
                  at: run.now(),
                }) ?? { intent: "factual", subQueries: [query.text] });
          run.record({
            stage: "router",
            kind: "llm_call",
            detail: { purpose: "intent" },
            cost: call,
            at: run.now(),
          });
          const overrides = query.filters ?? {};
          const filters: KajianQFilters = {};
          if (overrides.madzhab) filters.madzhab = overrides.madzhab;
          else if (out.madzhab) {
            const m = narrowMadzhab(out.madzhab);
            if (m) filters.madzhab = m;
          }
          if (overrides.grade) filters.grade = overrides.grade;
          else if (out.grade) {
            const g = narrowGrade(out.grade);
            if (g) filters.grade = g;
          }
          if (overrides.textLayer) filters.textLayer = overrides.textLayer;
          else if (out.textLayer) {
            const t = narrowTextLayer(out.textLayer);
            if (t) filters.textLayer = t;
          }
          const subQueries = out.subQueries.length > 0 ? out.subQueries : [query.text];
          return {
            intent: out.intent,
            subQueries: subQueries.map((text) => ({ text })),
            filters,
          };
        }),
      ),
  };
}

/**
 * The router LLM's filter suggestions are free strings; an unrecognized value
 * is dropped (never force-matched into a wrong filter — the caller's explicit
 * overrides always win).
 */
function narrowMadzhab(v: string): Madzhab | undefined {
  return (MADZHABS as readonly string[]).includes(v) ? (v as Madzhab) : undefined;
}
function narrowGrade(v: string): Grade | undefined {
  return v === "sahih" || v === "hasan" || v === "mutawatir" || v === "dhaif"
    ? (v as Grade)
    : undefined;
}
function narrowTextLayer(v: string): TextLayer | undefined {
  return v === "matn" || v === "sharh" ? (v as TextLayer) : undefined;
}

/** Stages 1–2 in one prompt: intent, filters, and 2–4 sub-queries. */
export const ROUTER_SYSTEM_PROMPT = [
  "You are the routing stage of a classical Islamic knowledge retrieval system.",
  "Given the user's question, reply with ONLY a JSON object:",
  '{"intent": "factual|ruling|analogy|comparison|history|aqidah",',
  ' "subQueries": ["2-4 focused retrieval queries, mixing the question language and its classical terms"],',
  ' "madzhab": "" | "hanafi"|"maliki"|"syafii"|"hambali",',
  ' "grade": "" | "sahih"|"hasan",',
  ' "textLayer": "" | "matn"|"sharh"}',
  'Use "" for filters the question does not constrain. No prose outside the JSON.',
].join("\n");
