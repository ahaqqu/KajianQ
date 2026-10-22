import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_NEIGHBOUR_CAP,
  DEFAULT_NEIGHBOUR_RADIUS,
  runChatPipelinePromise,
  runStoreEffect,
  surahSourceKey,
  type ChatPipelineDeps,
} from "@app/kajianq-domain";
import { createMemoryRagStore } from "@app/kajianq-domain/test-utils/memory-rag-store";
import { createStubChatProviders } from "@app/kajianq-domain/test-utils/stub-chat-providers";
import { buildChatWiring } from "./chat-wiring";

/**
 * INTEGRATION TEST — the neighbourhood window an operator configures arrives at the
 * retriever through the real serving composition root (`buildChatWiring` →
 * `buildChatStages` → `createChatRetriever`).
 *
 * The value is asserted where it acts — the bounded store read's options, the typed
 * `neighbour_expansion` event, and the evidence the generator is shown — never on the
 * deps object's shape. A deps object carrying a key no stage reads is precisely the
 * failure this pins: it looks configured and widens nothing.
 */

const KEYED_ENV = { DATABASE_URL: "postgres://x", DEEPSEEK_API_KEY: "k" };

/** The stub embedder's query vector: the one verse seeded with it is the fused hit. */
const HIT_VEC = [1, 0, 0];

type Store = ReturnType<typeof createMemoryRagStore>;

/**
 * Seed Al-Baqarah with a single embedded verse (2:255). Every other verse is stored
 * without an embedding, so the fused search returns the anchor alone and every other
 * verse in the context arrived through the expansion under test. 286 verses exceed the
 * scope read's budget, so no surah completion competes with it.
 */
async function seedSurah(store: Store): Promise<void> {
  const parentId = await runStoreEffect(
    store.insertDocParent({
      sourceKey: surahSourceKey(2),
      title: "QS. 2",
      metadata: { sourceType: "quran", surah: 2 },
    }),
  );
  await runStoreEffect(
    store.insertDocChildren(
      Array.from({ length: 286 }, (_, ordinal) => {
        const ayah = ordinal + 1;
        return {
          parentId,
          textRaw: `ar-2:${ayah}`,
          textAr: `ar-2:${ayah}`,
          textId: `id-2:${ayah}`,
          citation: { sourceType: "quran", surah: 2, ayah },
          embeddingPrimary: ayah === 255 ? HIT_VEC : null,
          embeddingFallback: null,
          ordinal,
          metadata: { sourceType: "quran", surah: 2, ayah, citation: `QS. 2:${ayah}` },
        };
      }),
    ),
  );
}

/** The fused hit every configuration holds: the expansion's anchor, always in context. */
const ANCHOR = "QS. 2:255";

/** The verses the assembled context puts in front of the generator, beyond the anchor. */
function neighbourCitationsIn(context: string): string[] {
  return [...context.matchAll(/\[(QS\. 2:\d+)\]/g)]
    .map((match) => match[1] as string)
    .filter((citation) => citation !== ANCHOR)
    .sort((a, b) => Number(a.split(":")[1]) - Number(b.split(":")[1]));
}

type Run = {
  /** Every bounded neighbourhood read the retriever issued, with its options. */
  reads: { anchors: readonly string[]; radius: number; limit: number }[];
  /** The assembled context the generator was shown. */
  context: string;
  /** The typed neighbourhood event, when the expansion ran. */
  detail:
    | {
        anchors: readonly string[];
        returned: number;
        radius: number;
        cap: number;
        truncated: boolean;
      }
    | undefined;
};

/**
 * The serving wiring with its provider seams replaced by the domain's stubs and its
 * store by a seeded memory store that records the neighbourhood read. Everything else
 * — the knobs included — is `buildChatWiring`'s own.
 */
async function runWith(env: Record<string, string | undefined>): Promise<Run> {
  const store = createMemoryRagStore();
  await seedSurah(store);
  const reads: Run["reads"] = [];
  const storeSpy = {
    ...store,
    listDocChildNeighboursByChildIds(
      anchors: readonly string[],
      opts: { radius: number; limit: number },
    ) {
      reads.push({ anchors: [...anchors], radius: opts.radius, limit: opts.limit });
      return store.listDocChildNeighboursByChildIds(anchors, opts);
    },
  };
  const stub = createStubChatProviders({
    noStream: true,
    answerText: "Jawaban QS. 2:254: ayat yang agung.",
  });
  const turns: { role: string; content: string }[][] = [];
  const deps: ChatPipelineDeps = {
    ...buildChatWiring({ ...KEYED_ENV, ...env }).pipeline,
    routerProvider: stub.routerProvider,
    generatorProvider: {
      generate: (spec) => {
        turns.push([...spec.turns]);
        return stub.generatorProvider.generate(spec);
      },
    },
    reviewerProvider: stub.reviewerProvider,
    reviewerDecider: stub.reviewerDecider,
    embedder: stub.embedder,
    store: storeSpy,
    bridge: runStoreEffect,
    language: "id",
  };
  const answer = await runChatPipelinePromise(deps, {
    text: "Apa yang dimaksud dengan ayat yang agung?",
  });
  const userTurn = turns[0]?.find((turn) => turn.role === "user")?.content;
  if (userTurn === undefined) throw new Error("the generator was never shown a context");
  const event = answer.trace.events.find((entry) => entry.kind === "neighbour_expansion");
  return {
    reads,
    context: userTurn,
    detail:
      event === undefined ? undefined : { ...event.detail, anchors: [...event.detail.anchors] },
  };
}

describe("buildChatWiring — the configured neighbourhood window reaches the retriever", () => {
  it("applies the configured radius to the read and to the context", async () => {
    const run = await runWith({ NEIGHBOUR_EXPANSION_RADIUS: "3" });

    // The retriever's own bounded read carries the operator's radius...
    expect(run.reads).toHaveLength(1);
    expect(run.reads[0]?.radius).toBe(3);
    // ...so three ordinals on each side of 2:255 reach the generator, not one.
    expect(run.detail).toMatchObject({ radius: 3, cap: DEFAULT_NEIGHBOUR_CAP, returned: 6 });
    expect(neighbourCitationsIn(run.context)).toEqual([
      "QS. 2:252",
      "QS. 2:253",
      "QS. 2:254",
      "QS. 2:256",
      "QS. 2:257",
      "QS. 2:258",
    ]);
  });

  it("applies the configured cap to the read and to the context", async () => {
    const run = await runWith({ NEIGHBOUR_EXPANSION_RADIUS: "3", NEIGHBOUR_EXPANSION_CAP: "2" });

    // The cap bounds what reaches the context; the read asks for cap + the rows the
    // dedup may drop (the one anchor already in context) + one proof row. The read
    // answers in the store's order — the anchor's window by ascending ordinal — so the
    // cap keeps the window's first rows.
    expect(run.reads[0]).toMatchObject({ radius: 3, limit: 2 + 1 + 1 });
    expect(run.detail).toMatchObject({ radius: 3, cap: 2, returned: 2, truncated: true });
    expect(neighbourCitationsIn(run.context)).toEqual(["QS. 2:252", "QS. 2:253"]);
  });

  it("keeps the retriever's own defaults when an operator configures nothing", async () => {
    const unset = await runWith({});

    // Unset = the retriever's documented defaults: one ordinal each side, twelve chunks
    // at most.
    expect(unset.reads[0]).toMatchObject({
      radius: DEFAULT_NEIGHBOUR_RADIUS,
      limit: DEFAULT_NEIGHBOUR_CAP + 1 + 1,
    });
    expect(unset.detail).toMatchObject({
      radius: DEFAULT_NEIGHBOUR_RADIUS,
      cap: DEFAULT_NEIGHBOUR_CAP,
      returned: 2,
      truncated: false,
    });
    expect(neighbourCitationsIn(unset.context)).toEqual(["QS. 2:254", "QS. 2:256"]);

    // Stating those defaults explicitly is the same behaviour: an absent binding and the
    // default value are one answer, so an unconfigured box answers identically with the
    // knobs read.
    const explicit = await runWith({
      NEIGHBOUR_EXPANSION_RADIUS: String(DEFAULT_NEIGHBOUR_RADIUS),
      NEIGHBOUR_EXPANSION_CAP: String(DEFAULT_NEIGHBOUR_CAP),
    });
    expect(explicit.reads).toEqual(unset.reads);
    expect(explicit.detail).toEqual(unset.detail);
    expect(explicit.context).toBe(unset.context);
  });

  it("honours the documented disable: a zero radius issues no read at all", async () => {
    const run = await runWith({ NEIGHBOUR_EXPANSION_RADIUS: "0" });

    // `0` is a configured value, not an absent one: it must reach the retriever as zero
    // and turn the expansion off, so the context holds the fused hit alone.
    expect(run.reads).toEqual([]);
    expect(run.detail).toBeUndefined();
    expect(neighbourCitationsIn(run.context)).toEqual([]);
  });
});
