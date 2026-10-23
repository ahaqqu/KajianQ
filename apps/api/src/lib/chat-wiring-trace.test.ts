import { describe, expect, it, vi } from "vite-plus/test";
import { CALLER_PRIORITY_K, totalCostMicroUsd, type Trace } from "@app/contracts";
import { runChatPipelinePromise, runStoreEffect, type ChatPipelineDeps } from "@app/kajianq-domain";
import { createMemoryRagStore } from "@app/kajianq-domain/test-utils/memory-rag-store";
import { createStubChatProviders } from "@app/kajianq-domain/test-utils/stub-chat-providers";
import { deriveTraceFrame } from "./chat-trace";
import { buildChatWiring } from "./chat-wiring";

/**
 * INTEGRATION TEST — a run's trace cost equals the sum of its provider calls,
 * asserted through the real serving composition root (`buildChatWiring`), not a
 * hand-built deps literal.
 *
 * The retrieval stage records its embed call through the run's own sink, like
 * every other stage records its provider call, so the cost is on the trace by
 * construction. A run that fails after the embed keeps exactly one embed record:
 * the cost settles once at the sink, and nothing re-forwards a failed trace's
 * costs into it.
 *
 * The zero is a route carrying no sub-query: the retriever returns before it
 * embeds anything (`subQueries.length === 0`), so the run makes no provider
 * call at all and its trace has no costs — the invariant holds as `0 = 0`. A
 * cache hit that skipped embedding would be the same shape: no call, no event.
 */

// The database client lives behind the RagStore adapter, so this test never
// reaches one: constructing or querying the pool is the failure this mock makes
// loud.
vi.mock("pg", () => ({
  Pool: class {
    on(): void {}
    query(): never {
      throw new Error("chat-wiring trace test: the database must not be reached");
    }
  },
}));

const KEYED_ENV = { DATABASE_URL: "postgres://x", DEEPSEEK_API_KEY: "k" };

const ARABIC = "اللَّهُ لَا إِلَٰهَ إِلَّا هُوَ الْحَيُّ الْقَيُّومُ";
const TRANSLATION = "Allah, tidak ada tuhan selain Dia, Yang Mahahidup.";
const CITATION = "QS. 2:255";

/** The stub costs the sum is computed from, keyed by the seam that produces them. */
const PROVIDER_COST_MICRO_USD = {
  router: 1,
  generator: 2,
  reviewer: 1,
  pregate: 6,
  rerank: 6,
  embed: 11,
} as const;

type Seam = keyof typeof PROVIDER_COST_MICRO_USD;

/** Seed the one Quran chunk a grounded `QS. 2:255` answer is built from. */
async function seedAyatKursi(store: ReturnType<typeof createMemoryRagStore>): Promise<void> {
  const parentId = await runStoreEffect(
    store.insertDocParent({ sourceKey: "quran/2", title: "Al-Baqarah", metadata: {} }),
  );
  await runStoreEffect(
    store.insertDocChild({
      parentId,
      textRaw: ARABIC,
      textAr: ARABIC,
      textId: TRANSLATION,
      citation: { sourceType: "quran", surah: 2, ayah: 255 },
      embeddingPrimary: [1, 0, 0],
      ordinal: 0,
      metadata: { sourceType: "quran", citation: CITATION },
    } as never),
  );
}

/** Record every method a seam is asked for, in call order, then delegate. */
function watch<T extends object>(seam: Seam, impl: T, calls: string[]): T {
  const wrapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(impl)) {
    wrapped[key] =
      typeof value === "function"
        ? (...args: unknown[]) => {
            calls.push(`${seam}.${key}`);
            return (value as (...inner: unknown[]) => unknown)(...args);
          }
        : value;
  }
  return wrapped as T;
}

/**
 * The serving wiring with its provider seams replaced by the domain's stubs and
 * its store by the memory store. Everything else is `buildChatWiring`'s own.
 */
function wiredDeps(
  store: ReturnType<typeof createMemoryRagStore>,
  calls: string[],
  overrides: Parameters<typeof createStubChatProviders>[0] = {},
): ChatPipelineDeps {
  const providers = createStubChatProviders(overrides);
  return {
    ...buildChatWiring(KEYED_ENV).pipeline,
    routerProvider: watch("router", providers.routerProvider, calls),
    generatorProvider: watch("generator", providers.generatorProvider, calls),
    reviewerProvider: watch("reviewer", providers.reviewerProvider, calls),
    reviewerDecider:
      providers.reviewerDecider === null
        ? null
        : watch("pregate", providers.reviewerDecider, calls),
    rerankDecider:
      providers.rerankDecider === null ? null : watch("rerank", providers.rerankDecider, calls),
    embedder: watch("embed", providers.embedder, calls),
    store,
    bridge: runStoreEffect,
    language: "id",
  };
}

/** What the seams actually spent, from the calls the stubs received. */
function spentMicroUsd(calls: readonly string[]): number {
  return calls.reduce((sum, call) => sum + PROVIDER_COST_MICRO_USD[call.split(".")[0] as Seam], 0);
}

describe("buildChatWiring — the embed call's cost rides the answer trace", () => {
  it("sums the run's provider calls (router + generator + pre-gate + embed)", async () => {
    const store = createMemoryRagStore();
    await seedAyatKursi(store);
    const calls: string[] = [];
    const answer = await runChatPipelinePromise(
      wiredDeps(store, calls, {
        answerText: `Jawaban ${CITATION}: Allah Mahahidup.`,
        // A non-zero, estimated embed record: the shape every provider call carries.
        embedCost: {
          tokensIn: 3,
          tokensOut: 0,
          latencyMs: 7,
          costMicroUsd: PROVIDER_COST_MICRO_USD.embed,
          estimated: true,
        },
        pregateMicroUsd: PROVIDER_COST_MICRO_USD.pregate,
      }),
      { text: "Apa itu Ayat Kursi?" },
    );

    // The path the sum covers: the pre-gate clears the citation, so the paid
    // reviewer is never entered.
    expect([...new Set(calls.map((call) => call.split(".")[0]))]).toEqual([
      "router",
      "embed",
      "generator",
      "pregate",
    ]);
    const expected = spentMicroUsd(calls);
    expect(expected).toBe(
      PROVIDER_COST_MICRO_USD.router +
        PROVIDER_COST_MICRO_USD.embed +
        PROVIDER_COST_MICRO_USD.generator +
        PROVIDER_COST_MICRO_USD.pregate,
    );

    // The invariant: the trace's recorded spend IS the sum of the provider calls.
    expect(totalCostMicroUsd(answer.trace)).toBe(expected);

    // ... because the embed call left a full cost record on the trace.
    const embedEvents = answer.trace.events.filter(
      (event) => event.kind === "llm_call" && event.cost?.modelId === "stub-embedder",
    );
    expect(embedEvents).toHaveLength(1);
    expect(embedEvents[0]).toMatchObject({
      stage: "retriever",
      kind: "llm_call",
      detail: { purpose: "embed" },
      cost: {
        modelId: "stub-embedder",
        tokensIn: 3,
        tokensOut: 0,
        latencyMs: 7,
        costMicroUsd: PROVIDER_COST_MICRO_USD.embed,
        estimated: true,
      },
    });

    // The panel's model list comes from the trace's cost records, so the embedder
    // is named only because its record exists.
    const frame = deriveTraceFrame({
      trace: answer.trace,
      messageId: "message-1",
      chunksById: new Map(),
    });
    expect(frame.technical.models).toContain("stub-embedder");
  });

  it("holds at zero when the retrieval stage has nothing to embed", async () => {
    const calls: string[] = [];
    // A text with no letter or digit is not a question: the router admits no
    // sub-query before any model call, the retriever returns before embedding,
    // and the run is declined from canned copy.
    const answer = await runChatPipelinePromise(wiredDeps(createMemoryRagStore(), calls), {
      text: "\u200b",
    });

    expect(calls).toEqual([]);
    expect(totalCostMicroUsd(answer.trace)).toBe(0);
    expect(answer.trace.events.filter((event) => event.kind === "llm_call")).toEqual([]);
  });

  it("keeps exactly one embed record when the run fails after embedding", async () => {
    // A failure after retrieval has spent: the embed's cost settled at the run's
    // sink before the generator failed, so the failed trace carries it once —
    // never zero times, and never twice through a failed-trace re-forward.
    const store = createMemoryRagStore();
    await seedAyatKursi(store);
    const calls: string[] = [];
    let failedTrace: Trace | undefined;
    await expect(
      runChatPipelinePromise(
        wiredDeps(store, calls, {
          answerText: `Jawaban ${CITATION}: Allah Mahahidup.`,
          embedCost: {
            tokensIn: 3,
            tokensOut: 0,
            latencyMs: 7,
            costMicroUsd: PROVIDER_COST_MICRO_USD.embed,
            estimated: true,
          },
          generatorFails: true,
        }),
        { text: "Apa itu Ayat Kursi?" },
        {},
        {
          onFailedTrace: (trace) => {
            failedTrace = trace;
          },
        },
      ),
    ).rejects.toThrow();

    expect(failedTrace).toBeDefined();
    const trace = failedTrace as Trace;
    const embedEvents = trace.events.filter(
      (event) => event.kind === "llm_call" && event.cost?.modelId === "stub-embedder",
    );
    expect(embedEvents).toHaveLength(1);
    // The router's call plus the embed's: the generator failed before it could
    // settle a cost, and nothing re-forwarding the failed trace adds the embed
    // a second time.
    expect(totalCostMicroUsd(trace)).toBe(
      PROVIDER_COST_MICRO_USD.router + PROVIDER_COST_MICRO_USD.embed,
    );
    expect(totalCostMicroUsd(trace)).toBe(12);
  });
});

describe("buildChatWiring — the rerank's decision call rides the answer trace", () => {
  it("records both scores on the rerank event and sums the call into the trace", async () => {
    const store = createMemoryRagStore();
    const parentId = await runStoreEffect(
      store.insertDocParent({ sourceKey: "quran/2", title: "Al-Baqarah", metadata: {} }),
    );
    // The caller's own query's leading hits are guaranteed into the context and
    // kept out of the rerank (ADR-0062), so the fixture must leave the rerank a
    // fused block of at least two candidates beyond that bound.
    const ayahs = Array.from({ length: CALLER_PRIORITY_K + 2 }, (_, i) => 255 + i);
    for (const [ordinal, ayah] of ayahs.entries()) {
      await runStoreEffect(
        store.insertDocChild({
          parentId,
          textRaw: ARABIC,
          textAr: ARABIC,
          textId: TRANSLATION,
          citation: { sourceType: "quran", surah: 2, ayah },
          embeddingPrimary: [1, 0, 0],
          ordinal,
          metadata: { sourceType: "quran", citation: `QS. 2:${ayah}` },
        } as never),
      );
    }
    const calls: string[] = [];
    const answer = await runChatPipelinePromise(
      wiredDeps(store, calls, {
        answerText: `Jawaban ${CITATION}: Allah Mahahidup.`,
        embedCost: {
          tokensIn: 3,
          tokensOut: 0,
          latencyMs: 7,
          costMicroUsd: PROVIDER_COST_MICRO_USD.embed,
          estimated: true,
        },
        pregateMicroUsd: PROVIDER_COST_MICRO_USD.pregate,
        rerankMicroUsd: PROVIDER_COST_MICRO_USD.rerank,
      }),
      { text: "Apa itu Ayat Kursi?" },
    );

    // The retriever embeds, then ranks the fused survivors before the
    // assembler; the pre-gate still clears the citation, so no paid reviewer.
    expect([...new Set(calls.map((call) => call.split(".")[0]))]).toEqual([
      "router",
      "embed",
      "rerank",
      "generator",
      "pregate",
    ]);
    expect(totalCostMicroUsd(answer.trace)).toBe(spentMicroUsd(calls));

    const rerank = answer.trace.events.find((event) => event.kind === "rerank");
    expect(rerank).toBeDefined();
    if (rerank?.kind !== "rerank") throw new Error("unreachable");
    expect(rerank.detail.outcome).toBe("applied");
    expect(rerank.detail.items).toHaveLength(2);
    for (const item of rerank.detail.items) {
      // Both scores are recorded: the fused order's score and the decision
      // model's probability, with the rank each candidate landed on.
      expect(item.fusedScore).toBeTypeOf("number");
      expect(item.rerankScore).toBeTypeOf("number");
      expect(item.rankAfter).toBeTypeOf("number");
    }
    const call = answer.trace.events.find(
      (event) => event.kind === "llm_call" && event.detail?.purpose === "rerank",
    );
    expect(call?.cost?.costMicroUsd).toBe(PROVIDER_COST_MICRO_USD.rerank);
  });
});
