import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { RunContext } from "@app/rag-core";
import { createKajianQRetriever } from "./chat-retriever";

/**
 * Filter relaxation (found by the first live Golden Set run).
 *
 * The router's `madzhab`/`grade`/`textLayer` filters are HINTS inferred by the
 * cheap-tier model, and it does not reliably obey the prompt's "leave
 * unconstrained attributes empty": a Quran question ("Apa maksud Ayat Kursi?")
 * was routed with `textLayer: "sharh"`, and since no Quran chunk carries a
 * `textLayer`, the filtered vector search matched NOTHING. Four of five smoke
 * questions came back with an empty context, so nothing could be cited and the
 * answers failed as ungrounded.
 *
 * A hint that empties the result set is wrong, not strict. The retriever retries
 * once unfiltered — and records the drop, because a silent fallback would hide
 * the machinery the trace exists to expose.
 */

const cost = { modelId: "m", tokensIn: 1, tokensOut: 1, latencyMs: 1, costMicroUsd: 1 };

const hit = (id: string) => ({
  child: { id, textAr: "نص", textId: null, metadata: { sourceType: "quran" } },
  distance: 0.1,
  rankDense: 1,
});

function makeRetriever(opts: { hitsWhenFiltered: number }) {
  const recorded: { kind: string }[] = [];
  const calls: (Record<string, string> | undefined)[] = [];
  const store = {
    similaritySearch: (
      _track: "primary" | "fallback",
      _embedding: readonly number[],
      o: { filters?: Record<string, string> },
    ) => {
      calls.push(o.filters);
      const filtered = o.filters !== undefined && Object.keys(o.filters).length > 0;
      const rows = filtered
        ? Array.from({ length: opts.hitsWhenFiltered }, (_, i) => hit(`f${i}`))
        : [hit("c1")];
      return Effect.succeed(rows);
    },
  };
  const retriever = createKajianQRetriever({
    store: store as never,
    embedder: { embed: () => Effect.succeed({ vectors: [[0.1, 0.2]], cost }) },
    bridge: ((e: unknown) => Effect.runPromise(e as never)) as never,
    limit: 5,
  });
  const run = <T>(effect: unknown): Promise<T> =>
    Effect.runPromise(
      Effect.provideService(effect as never, RunContext, {
        config: {},
        now: () => 1,
        record: (e: unknown) => recorded.push(e as { kind: string }),
      } as never) as never,
    ) as Promise<T>;
  return { retriever, calls, recorded, run };
}

const routed = (filters: Record<string, string>) =>
  ({ intent: "factual", subQueries: [{ text: "apa maksud ayat kursi" }], filters }) as never;

describe("retriever filter relaxation", () => {
  it("retries unfiltered when the inferred filters match nothing, and records the drop", async () => {
    const { retriever, calls, recorded, run } = makeRetriever({ hitsWhenFiltered: 0 });
    const chunks = await run<{ id: string }[]>(retriever.retrieve(routed({ textLayer: "sharh" })));

    expect(chunks.length).toBeGreaterThan(0);
    expect(calls[0]).toEqual({ textLayer: "sharh" });
    expect(calls[1]).toEqual({});

    const relaxed = recorded.filter((e) => e.kind === "filter_relaxed");
    expect(relaxed.length).toBeGreaterThan(0);
    // The event's shape is pinned against the persisted trace schema in
    // `packages/contracts/src/trace.test.ts`; `valibot` is deliberately not a
    // dependency of this package.
  });

  it("does not relax when the filtered search already has hits", async () => {
    const { retriever, calls, recorded, run } = makeRetriever({ hitsWhenFiltered: 1 });
    await run(retriever.retrieve(routed({ grade: "sahih" })));

    // One search per track per sub-query, all still filtered.
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c).toEqual({ grade: "sahih" });
    expect(recorded.filter((e) => e.kind === "filter_relaxed")).toHaveLength(0);
  });

  it("does not search twice when no filters were inferred", async () => {
    const { retriever, calls, run } = makeRetriever({ hitsWhenFiltered: 0 });
    await run(retriever.retrieve(routed({})));
    expect(calls).toEqual([{}, {}]);
  });
});
