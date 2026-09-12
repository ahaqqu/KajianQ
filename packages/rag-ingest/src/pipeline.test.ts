import { describe, expect, it, vi } from "vitest";
import type { RagStore } from "@app/infra";
import type { Provider } from "@app/rag-core";
import { EmbedMisalignment, runIngestion } from "./pipeline";
import type { ParsedParent } from "./types";
import { Cause, Effect } from "effect";

/** In-memory RagStore fake: idempotent by sourceKey / (parentId, ordinal). */
function fakeStore() {
  const parents = new Map<string, { id: string; title: string | null; metadata: unknown }>();
  const children = new Map<string, Record<string, unknown>>();
  const pairs = new Map<string, Record<string, unknown>>();
  let seq = 0;
  const store: RagStore = {
    insertDocParent(input) {
      return Effect.sync(() => {
        seq += 1;
        const existing = parents.get(input.sourceKey);
        const id = existing?.id ?? `p${seq}`;
        parents.set(input.sourceKey, {
          id,
          title: input.title,
          metadata: input.metadata,
        });
        return id;
      });
    },
    insertDocChild(input) {
      return Effect.map(this.insertDocChildren([input]), (ids) => ids[0] ?? `c${seq}`);
    },
    insertDocChildren(batch) {
      return Effect.forEach(batch, (input) =>
        Effect.sync(() => {
          seq += 1;
          const key = `${input.parentId}:${input.ordinal}`;
          const id = (children.get(key)?.id as string | undefined) ?? `c${seq}`;
          children.set(key, {
            id,
            textRaw: input.textRaw,
            textAr: input.textAr,
            textId: input.textId ?? null,
            ordinal: input.ordinal,
          });
          return id;
        }),
      );
    },
    upsertAlignedPair(input) {
      return Effect.sync(() => {
        const existing = pairs.get(input.pairKey);
        const id = typeof existing?.id === "string" ? existing.id : `pair${pairs.size + 1}`;
        pairs.set(input.pairKey, { id, ...input });
        return id;
      });
    },
    similaritySearch() {
      return Effect.succeed([]);
    },
    getDocChildrenByIds() {
      return Effect.succeed([]);
    },
    insertAnswerTrace() {
      return Effect.succeed("");
    },
    getAnswerTraceByMessage() {
      return Effect.succeed(null);
    },
    getChatSessionUser() {
      return Effect.succeed(null);
    },
    createChatSession() {
      return Effect.succeed("");
    },
    insertChatMessage() {
      return Effect.succeed("");
    },
    getChatMessages() {
      return Effect.succeed([]);
    },
    createSession() {
      return Effect.succeed({ userId: "", sessionId: "", token: "", expiresAt: 0 });
    },
    resolveUserId() {
      return Effect.succeed(null);
    },
    deleteUserCascade() {
      return Effect.void;
    },
    cleanupExpiredSessions() {
      return Effect.succeed(0);
    },
    insertEvalRun(input) {
      return Effect.succeed(input.id ?? `eval${(seq += 1)}`);
    },
    refreshEvalRun() {
      return Effect.succeed(void 0);
    },
    insertEvalResult() {
      return Effect.succeed(`er${(seq += 1)}`);
    },
    getEvalRun() {
      return Effect.succeed(null);
    },
    listEvalRuns() {
      return Effect.succeed([]);
    },
    getEvalResultsByRun() {
      return Effect.succeed([]);
    },
  };
  return {
    store,
    parents: () => [...parents.values()],
    children: () => [...children.values()],
    pairs: () => [...pairs.values()],
  };
}

/** Deterministic embedder: vector is the text hash repeated to a fixed dim. */
function fakeProvider(dim = 8, seen?: string[][]): Provider {
  return {
    modelId: "fake-embedder",
    embed: (spec) =>
      Effect.sync(() => {
        seen?.push([...spec.texts]);
        const vectors = spec.texts.map((text) => {
          const seed = [...text].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 997, 7);
          return Array.from({ length: dim }, (_, i) => ((seed + i) % 17) / 17);
        });
        return {
          vectors,
          cost: {
            modelId: "fake-embedder",
            tokensIn: spec.texts.length,
            tokensOut: 0,
            latencyMs: 1,
            costMicroUsd: spec.texts.length,
          },
        };
      }),
    generate: () => Effect.die("not used"),
    stream: () => Effect.die("not used"),
  };
}

function twoParents(): ParsedParent[] {
  return [
    {
      sourceKey: "src/1",
      title: "One",
      metadata: { k: 1 },
      children: [
        {
          sourceKey: "src/1:0",
          textRaw: "raw one",
          textPrimary: "primary one",
          textSecondary: "secondary one",
          citation: { c: 1 },
          metadata: {},
        },
        {
          sourceKey: "src/1:1",
          textRaw: "raw two",
          textPrimary: "primary two",
          textSecondary: "secondary two",
          citation: { c: 2 },
          metadata: {},
        },
      ],
    },
    {
      sourceKey: "src/2",
      title: "Two",
      metadata: {},
      children: [
        {
          sourceKey: "src/2:0",
          textRaw: "raw three",
          textPrimary: "primary three",
          textSecondary: null,
          citation: { c: 3 },
          metadata: {},
        },
      ],
    },
  ];
}

describe("runIngestion", () => {
  it("writes parents and children, embedding both tracks and recording costs", async () => {
    const f = fakeStore();
    const provider = fakeProvider();
    const result = await runIngestion(
      async () => twoParents(),
      { archiveKey: "archive/key", raw: new Uint8Array() },
      { store: f.store, embedder: provider, summarizer: null },
    );

    expect(result.parentIds).toHaveLength(2);
    expect(f.children()).toHaveLength(3);
    // Primary track embedded for all 3 children; the secondary track only for
    // the 2 rows that carry it (the null-secondary row is skipped, never sent
    // as an empty part), so cost = 3 + 2 = 5 micro-USD.
    expect(result.report.llmCalls).toHaveLength(2);
    expect(result.report.childrenWritten).toBe(3);
    expect(result.report.parentsWritten).toBe(2);
    expect(result.report.costMicroUsd).toBe(5);
    expect(result.report.details?.embeddedSecondaryTrack).toBe(true);
  });

  it("never sends an empty text to the embedder (the empty-Part 400)", async () => {
    // Regression pin: the corpus legitimately contains rows with no
    // secondary-language text, and the pipeline used to map `null` to `""` —
    // which the vendor rejects with `400 … contains an empty Part`, failing the
    // whole run after hours of embedding. The row keeps a null fallback vector.
    const f = fakeStore();
    const seen: string[][] = [];
    const written: Record<string, unknown>[] = [];
    const store: RagStore = {
      ...f.store,
      insertDocChildren(batch) {
        for (const row of batch) written.push(row as unknown as Record<string, unknown>);
        return f.store.insertDocChildren(batch);
      },
    };
    const result = await runIngestion(
      async () => twoParents(),
      { archiveKey: "archive/key", raw: new Uint8Array() },
      { store, embedder: fakeProvider(8, seen), summarizer: null },
    );

    expect(seen.flat().every((text) => text.trim() !== "")).toBe(true);
    // Two batches: 3 primary texts + 2 secondary texts (not 3).
    expect(seen.map((batch) => batch.length).sort()).toEqual([2, 3]);
    const nullSecondary = written.find((c) => c.textId === null);
    expect(nullSecondary?.embeddingFallback).toBeNull();
    expect(nullSecondary?.embeddingPrimary).not.toBeNull();
    expect(result.report.costMicroUsd).toBe(5);
  });

  it("embedConcurrency > 1 runs batches in parallel while keeping rows aligned", async () => {
    const f = fakeStore();
    let inFlight = 0;
    let maxInFlight = 0;
    const slowEmbedder: Provider = {
      modelId: "fake-embedder",
      embed: (spec) =>
        Effect.gen(function* () {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          yield* Effect.sleep("10 millis");
          inFlight -= 1;
          return {
            vectors: spec.texts.map((text) => [text.length, 1]),
            cost: {
              modelId: "fake-embedder",
              tokensIn: spec.texts.length,
              tokensOut: 0,
              latencyMs: 10,
              costMicroUsd: spec.texts.length,
            },
          };
        }),
      generate: () => Effect.die("not used"),
      stream: () => Effect.die("not used"),
    };
    // 8 children of distinct lengths → 2 batches per track at batchSize 4.
    const parents: ParsedParent[] = [
      {
        sourceKey: "src/a",
        title: null,
        metadata: {},
        children: Array.from({ length: 8 }, (_, i) => ({
          sourceKey: `src/a/${i}`,
          textRaw: `raw ${i}`,
          textPrimary: `primary text ${i} `.repeat(i + 1),
          textSecondary: `sekunder ${i}`,
          citation: {},
          metadata: {},
        })),
      },
    ];
    const written: Record<string, unknown>[] = [];
    const store: RagStore = {
      ...f.store,
      insertDocChildren(batch) {
        written.push(...batch.map((row) => ({ ...row })));
        return f.store.insertDocChildren(batch);
      },
    };
    const result = await runIngestion(
      async () => parents,
      { archiveKey: "archive/key", raw: new Uint8Array() },
      { store, embedder: slowEmbedder, summarizer: null, embedBatchSize: 4, embedConcurrency: 2 },
    );
    expect(maxInFlight).toBe(2); // bounded, and actually parallel
    expect(result.report.childrenWritten).toBe(8);
    // Row alignment survived concurrent batches: vector[0] is the text length.
    for (const row of written) {
      expect(row.embeddingPrimary).toEqual([(row.textAr as string).length, 1]);
      expect(row.embeddingFallback).toEqual([(row.textId as string).length, 1]);
    }
  });

  it("defaults to serial embedding when embedConcurrency is unset", async () => {
    const f = fakeStore();
    let inFlight = 0;
    let maxInFlight = 0;
    const slowEmbedder: Provider = {
      modelId: "fake-embedder",
      embed: (spec) =>
        Effect.gen(function* () {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          yield* Effect.sleep("5 millis");
          inFlight -= 1;
          return {
            vectors: spec.texts.map(() => [1]),
            cost: {
              modelId: "fake-embedder",
              tokensIn: spec.texts.length,
              tokensOut: 0,
              latencyMs: 5,
              costMicroUsd: spec.texts.length,
            },
          };
        }),
      generate: () => Effect.die("not used"),
      stream: () => Effect.die("not used"),
    };
    const parents: ParsedParent[] = [
      {
        sourceKey: "src/a",
        title: null,
        metadata: {},
        children: Array.from({ length: 4 }, (_, i) => ({
          sourceKey: `src/a/${i}`,
          textRaw: `raw ${i}`,
          textPrimary: `primary ${i}`,
          textSecondary: null,
          citation: {},
          metadata: {},
        })),
      },
    ];
    await runIngestion(
      async () => parents,
      { archiveKey: "archive/key", raw: new Uint8Array() },
      { store: f.store, embedder: slowEmbedder, summarizer: null, embedBatchSize: 2 },
    );
    expect(maxInFlight).toBe(1);
  });

  it("a misaligned batch under concurrency fails the run, records its cost, and interrupts in-flight siblings", async () => {
    const f = fakeStore();
    const aborted: string[] = [];
    const flakyEmbedder: Provider = {
      modelId: "fake-embedder",
      embed: (spec) =>
        spec.texts[0] === "primary 2"
          ? // Misaligned response: a real billed call with the wrong shape.
            Effect.succeed({
              vectors: spec.texts.map(() => [1]).slice(0, spec.texts.length - 1),
              cost: {
                modelId: "fake-embedder",
                tokensIn: spec.texts.length,
                tokensOut: 0,
                latencyMs: 5,
                costMicroUsd: spec.texts.length,
              },
            })
          : Effect.sleep("20 millis").pipe(
              Effect.flatMap(() =>
                Effect.succeed({
                  vectors: spec.texts.map(() => [1]),
                  cost: {
                    modelId: "fake-embedder",
                    tokensIn: spec.texts.length,
                    tokensOut: 0,
                    latencyMs: 20,
                    costMicroUsd: spec.texts.length,
                  },
                }),
              ),
              // Track fail-fast sibling interruption: an in-flight batch's
              // exit is interruption-only (no typed failure of its own).
              Effect.onExit((exit) =>
                Effect.sync(() => {
                  if (exit._tag === "Failure" && Cause.isInterruptedOnly(exit.cause))
                    if (spec.texts[0] !== undefined) aborted.push(spec.texts[0]);
                }),
              ),
            ),
      generate: () => Effect.die("not used"),
      stream: () => Effect.die("not used"),
    };
    const parents: ParsedParent[] = [
      {
        sourceKey: "src/a",
        title: null,
        metadata: {},
        children: Array.from({ length: 6 }, (_, i) => ({
          sourceKey: `src/a/${i}`,
          textRaw: `raw ${i}`,
          textPrimary: `primary ${i}`,
          textSecondary: null,
          citation: {},
          metadata: {},
        })),
      },
    ];
    // The run rejects with the typed EmbedMisalignment wrapped in a
    // FiberFailure; unwrap the cause (Effect stows it on a module symbol,
    // not a plain property) and assert its shape.
    let rejection: unknown;
    try {
      await runIngestion(
        async () => parents,
        { archiveKey: "archive/key", raw: new Uint8Array() },
        {
          store: f.store,
          embedder: flakyEmbedder,
          summarizer: null,
          embedBatchSize: 2,
          embedConcurrency: 3,
        },
      );
    } catch (err) {
      rejection = err;
    }
    expect(rejection).toBeDefined();
    const causeSym = Object.getOwnPropertySymbols(rejection as object).find(
      (sym) => sym.description === "effect/Runtime/FiberFailure/Cause",
    );
    expect(causeSym).toBeDefined();
    const cause = causeSym
      ? (rejection as Record<symbol, Cause.Cause<EmbedMisalignment>>)[causeSym]
      : undefined;
    expect(cause).toBeDefined();
    const failure = cause ? Cause.failureOption(cause) : undefined;
    if (failure !== undefined && failure._tag === "Some") {
      expect(failure.value._tag).toBe("EmbedMisalignment");
      expect(failure.value.expected).toBe(2);
      expect(failure.value.received).toBe(1);
    }
    // Fail-fast interrupted in-flight siblings (their scope finalizers ran).
    expect(aborted.length).toBeGreaterThan(0);
    // No children written for a failed run.
    expect(f.children()).toHaveLength(0);
  });

  it("rejects non-positive or non-integer embedConcurrency at the boundary (C2)", async () => {
    const f = fakeStore();
    await expect(
      runIngestion(
        async () => twoParents(),
        { archiveKey: "archive/key", raw: new Uint8Array() },
        { store: f.store, embedder: fakeProvider(), summarizer: null, embedConcurrency: 0 },
      ),
    ).rejects.toThrow(RangeError);
    await expect(
      runIngestion(
        async () => twoParents(),
        { archiveKey: "archive/key", raw: new Uint8Array() },
        { store: f.store, embedder: fakeProvider(), summarizer: null, embedConcurrency: 1.5 },
      ),
    ).rejects.toThrow(/must be a positive integer/);
  });

  it("is idempotent: re-running produces no duplicate parents or children", async () => {
    const f = fakeStore();
    const run = () =>
      runIngestion(
        async () => twoParents(),
        { archiveKey: "archive/key", raw: new Uint8Array() },
        { store: f.store, embedder: fakeProvider(), summarizer: null },
      );
    await run();
    await run();
    expect(f.parents()).toHaveLength(2);
    expect(f.children()).toHaveLength(3);
  });

  it("stores the LLM parent summary and embeds parents from summaries", async () => {
    const f = fakeStore();
    const summarizer = vi.fn(async (input: { sourceKey: string }) => ({
      summary: `summary ${input.sourceKey}`,
      cost: {
        modelId: "test-summarizer",
        tokensIn: 1,
        tokensOut: 1,
        latencyMs: 1,
        costMicroUsd: 2,
      },
    }));
    await runIngestion(
      async () => twoParents(),
      { archiveKey: "archive/key", raw: new Uint8Array() },
      { store: f.store, embedder: fakeProvider(), summarizer },
    );
    expect(summarizer).toHaveBeenCalledTimes(2);
    const p1 = f.parents().find((p) => p.title === "One");
    expect((p1?.metadata as Record<string, unknown>)?.summary).toBe("summary src/1");
  });

  it("records the summarizer's LLM calls into the report's cost (review A6)", async () => {
    const f = fakeStore();
    const result = await runIngestion(
      async () => twoParents(),
      { archiveKey: "archive/key", raw: new Uint8Array() },
      {
        store: f.store,
        embedder: fakeProvider(),
        summarizer: async (input: { sourceKey: string }) => ({
          summary: `summary ${input.sourceKey}`,
          cost: {
            modelId: "test-summarizer",
            tokensIn: 1,
            tokensOut: 1,
            latencyMs: 1,
            costMicroUsd: 7,
          },
        }),
      },
    );
    const summarizerCalls = result.report.llmCalls.filter((c) => c.modelId === "test-summarizer");
    expect(summarizerCalls).toHaveLength(2); // one per parent
    // Embedding cost (5: 3 primary + 2 secondary texts, see the first test)
    // plus the two 7-micro summaries = 19.
    expect(result.report.costMicroUsd).toBe(5 + 2 * 7);
  });

  it("rejects a parser that emits duplicate parent keys (fail loudly, never dupe)", async () => {
    const f = fakeStore();
    const dup = twoParents();
    dup.push({ ...dup[0]! });
    await expect(
      runIngestion(
        async () => dup,
        { archiveKey: "k", raw: new Uint8Array() },
        { store: f.store, embedder: fakeProvider(), summarizer: null },
      ),
    ).rejects.toThrow(/duplicate parent sourceKey/);
  });

  it("rejects a child with empty primary text (canonical evidence is mandatory)", async () => {
    const f = fakeStore();
    const bad = twoParents();
    bad[0]!.children = [
      { ...bad[0]!.children[0]!, textPrimary: "  " },
      ...bad[0]!.children.slice(1),
    ];
    await expect(
      runIngestion(
        async () => bad,
        { archiveKey: "k", raw: new Uint8Array() },
        { store: f.store, embedder: fakeProvider(), summarizer: null },
      ),
    ).rejects.toThrow(/empty primary text/);
  });

  it("rejects a summarizer that returns an empty summary", async () => {
    const f = fakeStore();
    await expect(
      runIngestion(
        async () => twoParents(),
        { archiveKey: "k", raw: new Uint8Array() },
        {
          store: f.store,
          embedder: fakeProvider(),
          summarizer: async () => ({
            summary: "",
            cost: { modelId: "t", tokensIn: 0, tokensOut: 0, latencyMs: 0, costMicroUsd: 0 },
          }),
        },
      ),
    ).rejects.toThrow(/empty summary/);
  });
});
