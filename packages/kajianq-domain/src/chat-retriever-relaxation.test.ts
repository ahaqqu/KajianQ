import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { RunContext } from "@app/rag-core";
import { createKajianQRetriever } from "./chat-retriever";
import type { KajianQFilters } from "./filters";
import { routedQuery } from "./test-utils/routed-query";

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
    // ADR-0049's anchored neighbour read. The fused hits here are verses
    // (`sourceType: "quran"`), so the expansion does ask for their
    // neighbourhood; this test is about relaxation, so the read contributes
    // nothing — but it must exist, or the retriever would fail on a store that
    // does not implement the seam.
    listDocChildNeighboursByChildIds: () => Effect.succeed([]),
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

const routed = (filters: KajianQFilters) => routedQuery("apa maksud ayat kursi", { filters });

describe("retriever filter relaxation", () => {
  it("retries unfiltered when the inferred filters match nothing, and records the drop", async () => {
    const { retriever, calls, recorded, run } = makeRetriever({ hitsWhenFiltered: 0 });
    const chunks = await run<{ id: string }[]>(
      retriever.retrieve(routed({ textLayer: ["sharh"] })),
    );

    expect(chunks.length).toBeGreaterThan(0);
    expect(calls[0]).toEqual({ textLayer: ["sharh"] });
    expect(calls[1]).toEqual({});

    const relaxed = recorded.filter((e) => e.kind === "filter_relaxed");
    expect(relaxed.length).toBeGreaterThan(0);
    // The event's shape is pinned against the persisted trace schema in
    // `packages/contracts/src/trace.test.ts`; `valibot` is deliberately not a
    // dependency of this package.
  });

  it("does not relax when the filtered search already has hits", async () => {
    const { retriever, calls, recorded, run } = makeRetriever({ hitsWhenFiltered: 1 });
    await run(retriever.retrieve(routed({ grade: ["sahih"] })));

    // One search per track per sub-query, all still filtered.
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c).toEqual({ grade: ["sahih"] });
    expect(recorded.filter((e) => e.kind === "filter_relaxed")).toHaveLength(0);
  });

  it("does not search twice when no filters were inferred", async () => {
    const { retriever, calls, run } = makeRetriever({ hitsWhenFiltered: 0 });
    await run(retriever.retrieve(routed({})));
    expect(calls).toEqual([{}, {}]);
  });
});

/**
 * **Per-dimension relaxation.** The retry used to drop the WHOLE filter set,
 * which is a widening the trace could not describe: a `textLayer` hint that
 * matched nothing took the `grade` screen down with it, so a question routed to
 * sahih-only evidence silently came back over dhaif material too — and the
 * single `filter_relaxed` event, recording the whole set as "dropped", read
 * identically whether one hint was wrong or all of them were.
 *
 * The cases named here before they were written: (1) only the unsatisfiable
 * dimension is given up, and the surviving record is on the event, so
 * `intended − dropped` reconstructs exactly what each search ran with; (2) the
 * drop is learned once for the run rather than re-probed per sub-query and per
 * track, which keeps a wrong hint from costing a search per fan-out branch;
 * (3) a drop that does not help is still recorded, with the hits it produced —
 * a relaxation that changed nothing is machinery the trace must still show.
 */
describe("filter relaxation gives up one dimension at a time", () => {
  /** A store where a given dimension never matches anything, and the rest do. */
  function makeStore(unsatisfiable: readonly string[]) {
    const calls: Record<string, string | readonly string[]>[] = [];
    const store = {
      similaritySearch: (
        _track: string,
        _embedding: readonly number[],
        o: { filters?: Record<string, string | readonly string[]> },
      ) => {
        const filters = o.filters ?? {};
        calls.push(filters);
        const blocked = Object.keys(filters).some((key) => unsatisfiable.includes(key));
        return Effect.succeed(blocked ? [] : [hit("c1")]);
      },
      listDocChildNeighboursByChildIds: () => Effect.succeed([]),
    };
    return { store, calls };
  }

  const runWith = (
    store: unknown,
    recorded: { kind: string }[],
    filters: KajianQFilters,
    /** How many sub-queries the run fans out over (one embed vector each). */
    subQueries = 2,
  ) => {
    const retriever = createKajianQRetriever({
      store: store as never,
      embedder: {
        embed: ({ texts }) =>
          Effect.succeed({
            vectors: texts.map(() => [0.1, 0.2]),
            cost,
          }),
      },
      bridge: ((e: unknown) => Effect.runPromise(e as never)) as never,
      limit: 5,
    });
    return Effect.runPromise(
      Effect.provideService(
        retriever.retrieve(
          routedQuery("apa maksud ayat kursi", {
            intent: "ruling",
            subQueries: [
              { text: "satu", role: "factual", origin: "model" },
              { text: "dua", role: "sanction", origin: "model" },
            ],
            filters,
          }),
        ) as never,
        RunContext,
        {
          config: {},
          now: () => 1,
          record: (e: unknown) => recorded.push(e as { kind: string }),
        } as never,
      ) as never,
    ) as Promise<unknown>;
  };

  it("gives up only the dimension that matched nothing, and records what survived", async () => {
    const { store, calls } = makeStore(["textLayer"]);
    const recorded: { kind: string }[] = [];
    await runWith(store, recorded, { textLayer: ["sharh"], grade: ["sahih"] });

    // First search: both dimensions. Then textLayer alone is given up — the
    // grade screen SURVIVES, which is the whole point.
    expect(calls[0]).toEqual({ textLayer: ["sharh"], grade: ["sahih"] });
    expect(calls[1]).toEqual({ grade: ["sahih"] });
    for (const call of calls.slice(1)) expect(call).toEqual({ grade: ["sahih"] });

    const relaxed = recorded.filter((e) => e.kind === "filter_relaxed") as unknown as {
      detail: {
        dropped: Record<string, string[]>;
        retained: Record<string, string[]>;
        hits: number;
        adopted: boolean;
      };
    }[];
    expect(relaxed).toHaveLength(1);
    expect(relaxed[0]?.detail.dropped).toEqual({ textLayer: ["sharh"] });
    expect(relaxed[0]?.detail.retained).toEqual({ grade: ["sahih"] });
    expect(relaxed[0]?.detail.hits).toBeGreaterThan(0);
    expect(relaxed[0]?.detail.adopted).toBe(true);
  });

  it("learns the drop once for the run, not once per sub-query per track", async () => {
    const { store, calls } = makeStore(["textLayer"]);
    await runWith(store, [], { textLayer: ["sharh"], grade: ["sahih"] });

    // Two sub-queries × two tracks = 4 searches, plus ONE probe: the adopted
    // record carries into the second sub-query and the fallback track, so a
    // wrong hint costs one extra search for the run rather than one per branch.
    expect(calls).toHaveLength(5);
    expect(calls.filter((c) => "textLayer" in c)).toHaveLength(1);
  });

  it("keeps a satisfiable hint and probes past it to the dimension that is actually blocking", async () => {
    // The source selection matches nothing while the grade screen is fine. The
    // blind order would give up `grade` first (it is ahead of `sourceType` by
    // declaration) and widen a sahih-screened question over dhaif material for
    // no reason. Probing says otherwise: dropping grade changes nothing, dropping
    // sourceType finds the context — and only the drop that helped is adopted.
    const { store, calls } = makeStore(["sourceType"]);
    const recorded: { kind: string }[] = [];
    await runWith(store, recorded, { sourceType: ["principle"], grade: ["sahih"] });

    expect(calls[0]).toEqual({ sourceType: ["principle"], grade: ["sahih"] });
    expect(calls[1]).toEqual({ sourceType: ["principle"] }); // probe: drop grade
    expect(calls[2]).toEqual({ grade: ["sahih"] }); // probe: drop sourceType — hits

    const relaxed = recorded.filter((e) => e.kind === "filter_relaxed") as unknown as {
      detail: {
        dropped: Record<string, string[]>;
        retained: Record<string, string[]>;
        hits: number;
        adopted: boolean;
      };
    }[];
    expect(relaxed.map((e) => [e.detail.dropped, e.detail.adopted, e.detail.hits])).toEqual([
      [{ grade: ["sahih"] }, false, 0],
      [{ sourceType: ["principle"] }, true, 1],
    ]);
    // The probe that changed nothing is still machinery on the trace, and the
    // adopted one names the record the search went on to run with.
    expect(relaxed[1]?.detail.retained).toEqual({ grade: ["sahih"] });
  });

  it("probes in the declared order, cheapest-to-be-wrong hint first", async () => {
    const { store, calls } = makeStore(["principleTags", "textLayer"]);
    const recorded: { kind: string }[] = [];
    await runWith(store, recorded, {
      principleTags: ["yusr"],
      textLayer: ["sharh"],
      grade: ["sahih"],
    });
    // Two dimensions block at once, so no single drop finds the context: the
    // probes run in the declared order, each omitting exactly one dimension, and
    // every one of them is recorded as NOT adopted — the run's live record is
    // left exactly as the route decided it, because nothing was proven wrong.
    expect(calls[0]).toEqual({ principleTags: ["yusr"], textLayer: ["sharh"], grade: ["sahih"] });
    expect(calls[1]).toEqual({ textLayer: ["sharh"], grade: ["sahih"] });
    expect(calls[2]).toEqual({ principleTags: ["yusr"], grade: ["sahih"] });
    expect(calls[3]).toEqual({ principleTags: ["yusr"], textLayer: ["sharh"] });
    // One sweep for the run: the fan-out's remaining searches pay nothing.
    expect(calls).toHaveLength(7);
    const relaxed = recorded.filter((e) => e.kind === "filter_relaxed") as unknown as {
      detail: { dropped: Record<string, string[]>; adopted: boolean; hits: number };
    }[];
    expect(relaxed.map((e) => [Object.keys(e.detail.dropped)[0], e.detail.adopted])).toEqual([
      ["principleTags", false],
      ["textLayer", false],
      ["grade", false],
    ]);
    // Nothing was adopted, so nothing was relaxed: every search after the sweep
    // still runs with the route's own record, all three dimensions intact.
    expect(calls.at(-1)).toEqual({
      principleTags: ["yusr"],
      textLayer: ["sharh"],
      grade: ["sahih"],
    });
  });
});
