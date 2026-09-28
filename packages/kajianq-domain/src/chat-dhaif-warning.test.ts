import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { dhaifWarning, hasWeakWarning, ulamaDisclaimer } from "./chat-postprocess";
import { MACHINE_TRANSLATION_LABEL } from "./chat-assembler";
import { runChatPipeline } from "./chat-pipeline";
import { createMemoryRagStore } from "./test-utils/memory-rag-store";
import { createStubChatProviders } from "./test-utils/stub-chat-providers";

/**
 * INTEGRATION TEST (#278) — the dhaif warning on the path the WIRING runs.
 *
 * The trust invariant: **an answer whose assembled context carries a
 * dhaif-graded chunk carries the deterministic dhaif warning — every time,
 * without depending on the model** (spec §2.2 "Grade flag — Always"; the
 * control exists so a weak-grade citation cannot read as primary proof).
 *
 * Why this file exists rather than another unit test: every earlier test of
 * the rule handed `applyProductRules` a hand-built chunk list that already
 * carried `grade: "dhaif"`. That is the one input the live path can lose, so
 * the suite stayed green while the deployed answers shipped without the
 * warning. This test walks the real composition instead — store rows →
 * `createKajianQRetriever` → `createKajianQAssembler` → generator → reviewer,
 * driven by `runChatPipeline` (the same `buildChatStages` wiring production
 * uses, ADR-0021) — so a future narrowing of the reviewer's context, a lost
 * metadata key, or a suppression predicate that accepts a grade mention
 * instead of the product's copy all redden here.
 *
 * The failing shape is the readable one from staging (trace
 * dfd9d801-c3bc-42b9-9e09-39a5df785c94, message
 * 92853ab6-5626-40cc-a098-a7d7463832b0, 2026-09-27): 28 assembled chunks, 3 of
 * them dhaif-graded, and a draft that reproduces the evidence's own labels —
 * including the "(Dhaif)" the assembler renders from the store grade — plus
 * the model's own informal note.
 */

const ARABIC = "إِنَّ اللَّهَ لَا يَخْفَىٰ عَلَيْهِ شَيْءٌ";
const TRANSLATION = "Sesungguhnya Allah tidak ada sesuatu pun yang tersembunyi bagi-Nya.";
const DHAIF_CITATION = "HR. Tirmidhi no. 2878 (Dhaif)";
const SAHIH_CITATION = "HR. Bukhari no. 5010 (Sahih)";

/**
 * The metadata the ingestion writes for a weak-grade hadith — the shape is
 * copied from the live store row (`grade` is the key the rule reads, `grades`
 * is the per-scholar detail, `citation` is the rendered label).
 */
const DHAIF_METADATA = {
  book: 45,
  grade: "dhaif",
  grades: [
    { name: "Ahmad Muhammad Shakir", grade: "Daif" },
    { name: "Al-Albani", grade: "Daif" },
  ],
  citation: DHAIF_CITATION,
  hadithNo: "2878",
  collection: "tirmidhi",
  sourceType: "hadith",
};

const SAHIH_METADATA = {
  grade: "sahih",
  citation: SAHIH_CITATION,
  hadithNo: "5010",
  collection: "bukhari",
  sourceType: "hadith",
};

/** The primary-track embedding; the fallback track is never needed here. */
const PRIMARY_VEC = [1, 0, 0];

/**
 * The live failing answer's shape: it quotes the evidence's own "(Dhaif)"
 * label verbatim (the generator is instructed to) and then makes its own
 * informal weakness note — which is what used to suppress the canonical line.
 */
const DHAIF_LABEL_DRAFT = [
  `Hadits dari Abu Hurairah: "Setiap sesuatu memiliki puncak…" — **Catatan: hadits ini berlabel Dhaif** [${DHAIF_CITATION}].`,
  `Hadits lain: [${SAHIH_CITATION}].`,
].join("\n\n");

/** Seed a parent + child exactly as ingestion writes them (columns, not metadata). */
async function seedChild(
  store: ReturnType<typeof createMemoryRagStore>,
  metadata: Record<string, unknown>,
  ordinal: number,
): Promise<string> {
  const parentId = await Effect.runPromise(
    store.insertDocParent({
      sourceKey: `hadith/${String(metadata["collection"])}`,
      title: "Jami' at-Tirmidhi",
      metadata: {},
    }),
  );
  return Effect.runPromise(
    store.insertDocChild({
      parentId,
      textRaw: ARABIC,
      textAr: ARABIC,
      textId: TRANSLATION,
      citation: { sourceType: "hadith" },
      embeddingPrimary: PRIMARY_VEC,
      embeddingFallback: PRIMARY_VEC,
      ordinal,
      // No textAr/textId here on purpose: the retriever must add those layers
      // (and must not drop `grade` while doing it).
      metadata,
    }),
  );
}

const cost = (modelId: string) => ({
  modelId,
  tokensIn: 1,
  tokensOut: 1,
  latencyMs: 1,
  costMicroUsd: 1,
});

/** The all-citations-cleared decision stub (ADR-0042 pre-gate skip path). */
const SKIPPING_DECIDER = {
  modelId: "stub-decider",
  decide: (spec: { questions: Record<string, unknown> }) =>
    Effect.succeed({
      answers: Object.fromEntries(
        Object.keys(spec.questions).map((key) => [key, { type: "noul", noul: 0.9 }]),
      ),
      cost: cost("stub-decider"),
    }),
};

/**
 * The pipeline deps as the composition root builds them: the shared chat
 * provider stubs plus the real store. `decider: null` models an environment
 * without the decision vendor's key; `SKIPPING_DECIDER` is the "skip the paid
 * reviewer" path the failing trace took.
 */
function depsFor(
  store: ReturnType<typeof createMemoryRagStore>,
  answerText: string,
  decider: null | typeof SKIPPING_DECIDER = null,
) {
  return {
    ...createStubChatProviders({ answerText }),
    reviewerDecider: decider as never,
    store,
    bridge: (effect: never) => Effect.runPromise(effect),
  };
}

/** Run the wired pipeline over a store and return the settled answer. */
async function answerFor(
  store: ReturnType<typeof createMemoryRagStore>,
  answerText: string,
  decider: null | typeof SKIPPING_DECIDER = null,
  language: "id" | "en" = "id",
) {
  return Effect.runPromise(
    runChatPipeline({ ...depsFor(store, answerText, decider), language } as never, {
      text: "Apa keutamaan ayat kursi?",
    }) as never,
  );
}

describe("#278 — the dhaif warning as the wiring runs it", () => {
  it("carries the canonical warning when the assembled context holds a dhaif chunk", async () => {
    const store = createMemoryRagStore();
    const dhaifId = await seedChild(store, DHAIF_METADATA, 0);
    await seedChild(store, SAHIH_METADATA, 1);

    const answer = await answerFor(store, DHAIF_LABEL_DRAFT);
    const text = (answer as { text: string }).text;

    // The warning the user must see, appended after the model's own text.
    expect(text).toContain(dhaifWarning("id"));
    expect(text.startsWith(DHAIF_LABEL_DRAFT)).toBe(true);
    // And the citations frame's own predicate agrees with the delivered text —
    // the flag cannot report "no warning" for an answer that carries one.
    expect(hasWeakWarning(text)).toBe(true);

    // The trace proves the context really carried the weak-grade chunk: this is
    // the "assembled" half of the invariant, not a fixture that asserts itself.
    const events = (answer as { trace: { events: readonly unknown[] } }).trace.events as {
      stage: string;
      kind: string;
      detail: Record<string, unknown>;
    }[];
    const retrieval = events.find((e) => e.kind === "retrieval");
    const assembly = events.find((e) => e.kind === "assembly");
    const ids = ((retrieval?.detail["chunks"] ?? []) as { id: string }[]).map((c) => c.id);
    expect(ids).toContain(dhaifId);
    expect(assembly?.detail["chunkCount"]).toBe(ids.length);
  });

  it("carries the warning on the pre-gate skip path (the path the failing trace took)", async () => {
    const store = createMemoryRagStore();
    await seedChild(store, DHAIF_METADATA, 0);
    await seedChild(store, SAHIH_METADATA, 1);

    const answer = await answerFor(store, DHAIF_LABEL_DRAFT, SKIPPING_DECIDER);
    const text = (answer as { text: string }).text;
    const events = (answer as { trace: { events: readonly unknown[] } }).trace.events as {
      kind: string;
      detail: Record<string, unknown>;
    }[];

    // The stub cleared every citation, so the paid reviewer was skipped and the
    // deterministic rules were the only thing between the draft and the user.
    expect(events.find((e) => e.kind === "decision")?.detail["outcome"]).toBe("skip");
    expect(events.some((e) => e.kind === "review")).toBe(false);
    expect(text).toContain(dhaifWarning("id"));
  });

  it("carries the warning in the answer's language (EN)", async () => {
    const store = createMemoryRagStore();
    await seedChild(store, DHAIF_METADATA, 0);

    const answer = await answerFor(
      store,
      `The hadith is graded weak (dhaif): [${DHAIF_CITATION}].`,
      null,
      "en",
    );
    const text = (answer as { text: string }).text;
    expect(text).toContain(dhaifWarning("en"));
    expect(text).not.toContain(dhaifWarning("id"));
  });

  it("carries the warning when the dhaif chunk is assembled but never cited (the narrowing guard)", async () => {
    // The ticket's own shape: several dhaif-graded chunks among the assembled
    // evidence, and a draft that quotes none of them. The invariant reads the
    // ASSEMBLED context, so this is the case that reddens if a future change
    // narrows what the reviewer sees — to the cited chunks, to chunks with a
    // text layer, or to any capped slice that drops the grade.
    const store = createMemoryRagStore();
    await seedChild(store, DHAIF_METADATA, 0);
    await seedChild(
      store,
      { ...DHAIF_METADATA, citation: "HR. Tirmidhi no. 3364 (Dhaif)", hadithNo: "3364" },
      1,
    );
    await seedChild(
      store,
      {
        ...DHAIF_METADATA,
        citation: "HR. Ibn Majah no. 4299 (Dhaif)",
        hadithNo: "4299",
        collection: "ibnmajah",
      },
      2,
    );
    await seedChild(store, SAHIH_METADATA, 3);

    const answer = await answerFor(store, `Jawaban memakai [${SAHIH_CITATION}] saja.`);
    const text = (answer as { text: string }).text;
    expect(text).not.toContain("Dhaif");
    expect(text).toContain(dhaifWarning("id"));
  });

  it("carries no warning when the retrieved set holds no dhaif chunk (the narrowing regression)", async () => {
    // The same draft, the same informal note, the same "(Dhaif)"-shaped text —
    // but with the weak-grade chunk absent from the retrieved set. Nothing may
    // warn: the control reads the assembled context, not the answer's words.
    // This is the half that reddens if a future change warns on sound hadith,
    // and it is the test that a future narrowing of the reviewer's context
    // (dropping the dhaif chunk) breaks in the other direction.
    const store = createMemoryRagStore();
    await seedChild(store, SAHIH_METADATA, 0);

    const answer = await answerFor(store, DHAIF_LABEL_DRAFT);
    const text = (answer as { text: string }).text;
    expect(text).not.toContain(dhaifWarning("id"));
    expect(hasWeakWarning(text)).toBe(false);
  });

  it("carries no warning for a sound-only context that mentions no grade at all", async () => {
    const store = createMemoryRagStore();
    await seedChild(store, SAHIH_METADATA, 0);

    const answer = await answerFor(store, `Jawaban memakai [${SAHIH_CITATION}].`);
    const text = (answer as { text: string }).text;
    expect(text).not.toContain(dhaifWarning("id"));
    expect(hasWeakWarning(text)).toBe(false);
  });
});

/**
 * INTEGRATION TEST (#285) — the deterministic rules' firing on the delivery
 * paths the WIRING takes.
 *
 * The invariant: **a delivered answer whose deterministic rules ran carries
 * exactly one `product_rules` event naming the rules that appended text — on
 * every path that applies them — and no such event where they did not run.**
 *
 * Why the wiring and not the reviewer seam alone: the three rules-applying
 * exits are `provider === null || skipLlm`, the ADR-0042 pre-gate skip, and
 * reviewer-passed, and the pre-gate skip records **no `review` event at all**
 * (the #278 staging trace dfd9d801 carried only a `decision` skip). A rule
 * firing on that path was invisible to the trace; this suite is what reddens
 * if the event stops being recorded there, if it is recorded where the rules
 * were disabled, or if `applied` stops distinguishing "appended nothing"
 * (the residual exact-copy suppression) from "never ran".
 */

/** The typed trace events of a settled pipeline answer. */
const eventsOf = (answer: unknown) =>
  (answer as { trace: { events: readonly unknown[] } }).trace.events as {
    stage: string;
    kind: string;
    detail: Record<string, unknown>;
  }[];

const productRulesEvents = (answer: unknown) =>
  eventsOf(answer).filter((event) => event.kind === "product_rules");

/** The same wired pipeline as `answerFor`, with per-test deps overrides. */
async function answerVia(
  store: ReturnType<typeof createMemoryRagStore>,
  answerText: string,
  overrides: Record<string, unknown> = {},
) {
  return Effect.runPromise(
    runChatPipeline(
      { ...depsFor(store, answerText, null), language: "id", ...overrides } as never,
      { text: "Apa keutamaan ayat kursi?" },
    ) as never,
  );
}

describe("#285 — the product_rules event on the wiring's delivery paths", () => {
  it("records the fired rules on the pre-gate skip path (the #278 trace's path)", async () => {
    const store = createMemoryRagStore();
    await seedChild(store, DHAIF_METADATA, 0);

    const answer = await answerVia(store, `Jawaban memakai [${DHAIF_CITATION}] saja.`, {
      reviewerDecider: SKIPPING_DECIDER,
    });
    const events = eventsOf(answer);
    // The path: the cheap screen cleared every citation, so the paid reviewer
    // was skipped and no `review` event exists to hang the rule firing on.
    expect(events.find((e) => e.kind === "decision")?.detail["outcome"]).toBe("skip");
    expect(events.some((e) => e.kind === "review")).toBe(false);

    const rules = productRulesEvents(answer);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.stage).toBe("reviewer");
    expect(rules[0]?.detail["applied"]).toEqual([
      "dhaif_warning",
      "machine_translation_label",
      "ulama_disclaimer",
    ]);
    // The event and the delivered text agree rule-for-rule.
    const text = (answer as { text: string }).text;
    expect(text).toContain(dhaifWarning("id"));
    expect(text).toContain(MACHINE_TRANSLATION_LABEL);
    expect(text).toContain(ulamaDisclaimer("id"));
  });

  it("records the fired rules on the reviewer-passed path", async () => {
    const store = createMemoryRagStore();
    await seedChild(store, DHAIF_METADATA, 0);

    // No decider wired → the stub reviewer runs and passes.
    const answer = await answerVia(store, `Jawaban memakai [${DHAIF_CITATION}] saja.`);
    expect(eventsOf(answer).some((e) => e.kind === "review")).toBe(true);
    expect(productRulesEvents(answer)).toHaveLength(1);
  });

  it.each([
    ["no reviewer provider wired", { reviewerProvider: null }],
    ["skipLlm", { skipReviewer: true }],
  ])(
    "records the fired rules when the stage stops before the reviewer (%s)",
    async (_label, overrides) => {
      const store = createMemoryRagStore();
      await seedChild(store, DHAIF_METADATA, 0);

      const answer = await answerVia(store, `Jawaban memakai [${DHAIF_CITATION}] saja.`, overrides);
      expect(eventsOf(answer).some((e) => e.kind === "review")).toBe(false);
      expect(productRulesEvents(answer)).toHaveLength(1);
    },
  );

  it("records `applied: []` when the draft already carries every rule's copy (the exact-copy path)", async () => {
    // The case this event exists for: the model reproduced the canonical copy
    // character-for-character, so every rule found its own text present and
    // appended nothing. The delivered text is identical either way — only the
    // event distinguishes "ran, found the copy" from "never ran" (the next
    // test's negative), and `applied: []` is that record.
    const store = createMemoryRagStore();
    await seedChild(store, DHAIF_METADATA, 0);
    const draft = [
      "Jawaban sesuai konteks.",
      dhaifWarning("id"),
      `[${MACHINE_TRANSLATION_LABEL}]`,
      ulamaDisclaimer("id"),
    ].join("\n\n");

    const answer = await answerVia(store, draft, { reviewerDecider: SKIPPING_DECIDER });
    const rules = productRulesEvents(answer);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.detail["applied"]).toEqual([]);
    // Nothing was appended: the rules are not a second source of truth for
    // what the answer says.
    expect((answer as { text: string }).text).toBe(draft);
  });

  it("records nothing when the answer is the canonical refusal (the rules never ran)", async () => {
    const store = createMemoryRagStore();
    await seedChild(store, DHAIF_METADATA, 0);

    const answer = await answerVia(
      store,
      "Mohon maaf, kami tidak menemukan dalil yang memadai untuk pertanyaan ini.",
      { reviewerDecider: SKIPPING_DECIDER },
    );
    // The refusal short-circuits before any rule runs — and must not gain a
    // disclaimer, nor an event claiming the rules ran.
    expect(eventsOf(answer).some((e) => e.kind === "refusal")).toBe(true);
    expect(productRulesEvents(answer)).toHaveLength(0);
    expect((answer as { text: string }).text).not.toContain(ulamaDisclaimer("id"));
  });
});
