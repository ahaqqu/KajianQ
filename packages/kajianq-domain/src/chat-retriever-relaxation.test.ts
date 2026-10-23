import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { RunContext } from "@app/rag-core";
import { createKajianQRetriever } from "./chat-retriever";
import type { KajianQFilters } from "./filters";
import type { MetadataFilterMatch, MetadataFilterValue } from "./chat-retriever-parts";
import { routedQuery } from "./test-utils/routed-query";

/**
 * Filter relaxation: the router's `grade` filter is a HINT inferred by the
 * cheap-tier model, which does not reliably obey the prompt's "leave
 * unconstrained attributes empty" — a hint that empties the result set is wrong,
 * not strict. The retriever retries with the hint given up, and records the drop:
 * a silent fallback would hide the machinery the trace exists to expose.
 */

const cost = { modelId: "m", tokensIn: 1, tokensOut: 1, latencyMs: 1, costMicroUsd: 1 };

const hit = (id: string) => ({
  child: { id, textAr: "نص", textId: null, metadata: { sourceType: "quran" } },
  distance: 0.1,
  rankDense: 1,
});

/**
 * The decision a search ran with, as the trace records it — dimension to value
 * set. A value may reach the store carrying a derived case (`grade: sahih` also
 * matching an ungraded sahihayn row); that expansion is the filter policy's
 * business, pinned in `chat-filter-policy.test.ts`, and relaxation's contract is
 * which dimensions survive.
 */
const isMatch = (value: MetadataFilterValue): value is MetadataFilterMatch =>
  typeof value === "object" && !Array.isArray(value);

const decisionOf = (filters: Record<string, MetadataFilterValue>): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(filters)) {
    out[key] =
      typeof value === "string"
        ? [value]
        : isMatch(value)
          ? [...value.values]
          : [...(value as string[])];
  }
  return out;
};

function makeRetriever(opts: { hitsWhenFiltered: number }) {
  const recorded: { kind: string }[] = [];
  const calls: (Record<string, string[]> | undefined)[] = [];
  const store = {
    similaritySearch: (
      _track: "primary" | "fallback",
      _embedding: readonly number[],
      o: { filters?: Record<string, string> },
    ) => {
      calls.push(o.filters === undefined ? undefined : decisionOf(o.filters));
      const filtered = o.filters !== undefined && Object.keys(o.filters).length > 0;
      const rows = filtered
        ? Array.from({ length: opts.hitsWhenFiltered }, (_, i) => hit(`f${i}`))
        : [hit("c1")];
      return Effect.succeed(rows);
    },
    // The anchored neighbour read must exist even though it contributes nothing here:
    // the fused hits are verses, so the expansion asks for it, and the retriever would
    // fail on a store that does not implement the seam.
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
    const chunks = await run<{ id: string }[]>(retriever.retrieve(routed({ grade: ["sahih"] })));

    expect(chunks.length).toBeGreaterThan(0);
    expect(calls[0]).toEqual({ grade: ["sahih"] });
    expect(calls[1]).toEqual({});

    const relaxed = recorded.filter((e) => e.kind === "filter_relaxed");
    expect(relaxed.length).toBeGreaterThan(0);
    // The event's shape is pinned against the persisted trace schema in
    // `packages/contracts/src/trace.test.ts`; `valibot` is not a dependency here.
  });

  it("does not relax when the filtered search already has hits", async () => {
    const { retriever, calls, recorded, run } = makeRetriever({ hitsWhenFiltered: 1 });
    await run(retriever.retrieve(routed({ grade: ["sahih"] })));

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
 * **Per-dimension relaxation**, in the order the cases run:
 *   1. only the unsatisfiable dimension is given up, and the surviving record is on the
 *      event, so `intended − dropped` reconstructs what each search ran with;
 *   2. the drop is learned once for the run rather than re-probed per sub-query and per
 *      track, so a wrong hint cannot cost a search per fan-out branch;
 *   3. a drop that does not help is still recorded, with the hits it produced.
 */
describe("filter relaxation gives up one dimension at a time", () => {
  function makeStore(unsatisfiable: readonly string[]) {
    const calls: Record<string, string | readonly string[]>[] = [];
    const store = {
      similaritySearch: (
        _track: string,
        _embedding: readonly number[],
        o: { filters?: Record<string, string | readonly string[]> },
      ) => {
        const filters = o.filters ?? {};
        calls.push(decisionOf(filters));
        const blocked = Object.keys(filters).some((key) => unsatisfiable.includes(key));
        return Effect.succeed(blocked ? [] : [hit("c1")]);
      },
      listDocChildNeighboursByChildIds: () => Effect.succeed([]),
    };
    return { store, calls };
  }

  const runWith = <T = unknown>(
    store: unknown,
    recorded: { kind: string }[],
    filters: KajianQFilters,
    /** How many sub-queries the run fans out over (one embed vector each). */
    subQueries = 2,
  ): Promise<T> => {
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
    ) as Promise<T>;
  };

  it("retries the WHOLE record once when no single hint is at fault", async () => {
    // Two dimensions unsatisfiable at once: every per-dimension probe still carries
    // the other dead one and returns nothing, so the sweep alone would leave the run
    // searching a record that matches no rows. Two such dimensions are a real state —
    // a source no row carries and a grade no row carries.
    const { store, calls } = makeStore(["sourceType", "grade"]);
    const recorded: { kind: string }[] = [];
    const chunks = await runWith<{ id: string }[]>(store, recorded, {
      sourceType: ["principle"],
      grade: ["mutawatir"],
    });

    // The probes run in the declared order, each omitting exactly one dimension.
    expect(calls.slice(0, 4)).toEqual([
      { sourceType: ["principle"], grade: ["mutawatir"] },
      { sourceType: ["principle"] },
      { grade: ["mutawatir"] },
      {},
    ]);
    // The last of those is ONE record-level retry with `{}`, adopted: the record as a
    // SET was what matched nothing. It is recorded as a whole-record drop instead of
    // a silent widening.
    expect(chunks.length).toBeGreaterThan(0);

    const relaxed = recorded.filter((e) => e.kind === "filter_relaxed") as unknown as {
      detail: {
        dropped: Record<string, string[]>;
        retained: Record<string, string[]>;
        hits: number;
        adopted: boolean;
      };
    }[];
    expect(relaxed.map((e) => [e.detail.dropped, e.detail.adopted])).toEqual([
      [{ grade: ["mutawatir"] }, false],
      [{ sourceType: ["principle"] }, false],
      // Every live dimension at once: the record-level last resort.
      [{ sourceType: ["principle"], grade: ["mutawatir"] }, true],
    ]);
    expect(relaxed.at(-1)?.detail.retained).toEqual({});
    expect(relaxed.at(-1)?.detail.hits).toBeGreaterThan(0);

    // Adopted for the RUN: the remaining searches run unfiltered rather than re-probing.
    expect(calls).toHaveLength(7);
    for (const call of calls.slice(4)) expect(call).toEqual({});
  });

  it("gives up only the dimension that matched nothing, and records what survived", async () => {
    const { store, calls } = makeStore(["sourceType"]);
    const recorded: { kind: string }[] = [];
    await runWith(store, recorded, { sourceType: ["principle"], grade: ["sahih"] });

    expect(calls[0]).toEqual({ sourceType: ["principle"], grade: ["sahih"] });
    expect(calls[1]).toEqual({ sourceType: ["principle"] }); // probe: drop grade
    expect(calls[2]).toEqual({ grade: ["sahih"] }); // probe: drop sourceType — hits
    for (const call of calls.slice(2)) expect(call).toEqual({ grade: ["sahih"] });

    const relaxed = recorded.filter((e) => e.kind === "filter_relaxed") as unknown as {
      detail: {
        dropped: Record<string, string[]>;
        retained: Record<string, string[]>;
        hits: number;
        adopted: boolean;
      };
    }[];
    // The probe that changed nothing is on the trace beside the adopted drop.
    expect(relaxed.map((e) => [e.detail.dropped, e.detail.adopted])).toEqual([
      [{ grade: ["sahih"] }, false],
      [{ sourceType: ["principle"] }, true],
    ]);
    expect(relaxed[1]?.detail.retained).toEqual({ grade: ["sahih"] });
    expect(relaxed[1]?.detail.hits).toBeGreaterThan(0);
  });

  it("learns the drop once for the run, not once per sub-query per track", async () => {
    const { store, calls } = makeStore(["grade"]);
    await runWith(store, [], { sourceType: ["quran"], grade: ["sahih"] });

    // The adopted record carries into the second sub-query and the fallback track, so a
    // wrong hint costs one extra search for the run, not one per branch.
    expect(calls).toHaveLength(5);
    expect(calls.filter((c) => "grade" in c)).toHaveLength(1);
  });

  it("keeps a satisfiable hint and probes past it to the dimension that is actually blocking", async () => {
    // The declared order gives up `grade` first; dropping it does not help here, so
    // the probe is discarded and only the drop that helped — the source selection —
    // is adopted. A blind whole-record retry could not tell the two apart.
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
    // The probe that changed nothing is still machinery on the trace.
    expect(relaxed[1]?.detail.retained).toEqual({ grade: ["sahih"] });
  });

  it("does not repeat the `{}` search — or its event — when exactly one dimension is live", async () => {
    // The last resort exists for TWO OR MORE live dimensions, where every probe still
    // carried the other dead one. With a single live dimension its own probe already ran
    // `{}`, so a last resort would repeat a byte-identical search and event — and the
    // trace's discriminator would misread that event as the record-level last resort.
    const calls: Record<string, string[]>[] = [];
    const recorded: { kind: string }[] = [];
    const store = {
      similaritySearch: (
        _track: string,
        _embedding: readonly number[],
        o: { filters?: Record<string, string[]> },
      ) => {
        calls.push(decisionOf(o.filters ?? {}));
        return Effect.succeed([]);
      },
      listDocChildNeighboursByChildIds: () => Effect.succeed([]),
    };

    const chunks = await runWith<{ id: string }[]>(store, recorded, { grade: ["sahih"] });

    // One unfiltered search, and it is the rescue: the run REACHES a `{}` search instead
    // of refusing at the filtered one.
    expect(calls[0]).toEqual({ grade: ["sahih"] });
    expect(calls[1]).toEqual({});
    expect(calls.filter((call) => Object.keys(call).length === 0)).toHaveLength(1);
    expect(chunks).toHaveLength(0);

    const relaxed = recorded.filter((e) => e.kind === "filter_relaxed") as unknown as {
      detail: {
        dropped: Record<string, string[]>;
        retained: Record<string, string[]>;
        hits: number;
        adopted: boolean;
      };
    }[];
    expect(relaxed).toHaveLength(1);
    expect(relaxed[0]?.detail.dropped).toEqual({ grade: ["sahih"] });
    expect(relaxed[0]?.detail.retained).toEqual({});
    expect(relaxed[0]?.detail.hits).toBe(0);
    expect(relaxed[0]?.detail.adopted).toBe(false);
  });
});
