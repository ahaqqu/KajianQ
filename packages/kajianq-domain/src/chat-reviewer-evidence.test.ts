import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { RunContext, type AssembledContext, type Chunk, type Query } from "@app/rag-core";
import type { CostRecord } from "@app/contracts";
import { createKajianQReviewer } from "./chat-reviewer";
import { createKajianQAssembler } from "./chat-assembler";
import type { KajianQFilters } from "./filters";

/**
 * What the reviewer is actually shown.
 *
 * The reviewer's evidence lines used to be `- ${chunk.text}` — the raw text with
 * NO citation label. That made the cross-vendor gate structurally unable to
 * verify a citation: it never saw that a chunk was labelled "HR. Malik no. 185",
 * so every answer citing its sources was failed with "cites specific hadith
 * numbers … which are not present in the provided evidence". Three of five
 * questions were refused on the first live size-5 smoke for this reason.
 *
 * The deterministic validator never had this problem — it compares labels
 * directly — which is why the bug hid behind the gate's LLM half.
 *
 * The second live failure (gs-v0-015) was the same family one layer down: the
 * reviewer's `chunk.text` for a fallback-track hit is the translation only,
 * while the Generator's context carries the Arabic original too, so the
 * reviewer failed an answer for quoting Arabic it had never been shown. The
 * reviewer now reads the assembler's own context turn — the exact text the
 * Generator answered from — so the parity is structural, not a re-render that
 * can drift.
 */

const cost = (): CostRecord => ({
  modelId: "m",
  tokensIn: 1,
  tokensOut: 1,
  latencyMs: 1,
  costMicroUsd: 1,
});

/** The chunks the pipeline hands the assembler (retriever-shaped metadata). */
const CHUNKS: Chunk[] = [
  { id: "c1", text: "اللَّهُ لَا إِلَٰهَ إِلَّا هُوَ", metadata: { citation: "QS. 2:255" } },
  {
    id: "c2",
    text: "puasa dalam perjalanan",
    metadata: { citation: "HR. Malik no. 185 (Sahih)", grade: "sahih" },
  },
  // A chunk with no citation label must not produce a dangling bracket.
  { id: "c3", text: "tanpa label", metadata: {} },
  // A fallback-track hit: `text` is the translation, but the retriever also
  // carries the Arabic layer and the reviewer must see it.
  {
    id: "c4",
    text: "Dengan nama Allah Yang Maha Pengasih lagi Maha Penyayang.",
    metadata: {
      citation: "QS. 1:1",
      textAr: "بِسْمِ اللّٰهِ الرَّحْمٰنِ الرَّحِيْمِ",
      textId: "Dengan nama Allah Yang Maha Pengasih lagi Maha Penyayang.",
    },
  },
] as never;

/** The context the REAL assembler builds for those chunks (no drift in test). */
function assembledContext(): Promise<AssembledContext<KajianQFilters>> {
  const assembler = createKajianQAssembler();
  const query = { text: "Apa maksud Ayat Kursi?" } as Query<KajianQFilters>;
  return Effect.runPromise(assembler.assemble(query, CHUNKS) as never) as never;
}

async function runReviewer(captured: { user?: string }): Promise<void> {
  const reviewer = createKajianQReviewer({
    provider: {
      generate: (spec) => {
        captured.user = spec.turns.map((t) => t.content).join("\n");
        return Effect.succeed({ text: '{"verdict": "pass", "reason": "-"}', cost: cost() });
      },
    },
    applyProductRules: false,
    language: "id",
  });
  await Effect.runPromise(
    Effect.provideService(
      reviewer.review(
        { text: "Jawaban dengan QS. 2:255 dan HR. Malik no. 185." } as never,
        await assembledContext(),
      ) as never,
      RunContext,
      { config: {}, now: () => 1, record: () => {} } as never,
    ) as never,
  );
}

describe("reviewer evidence rendering", () => {
  it("shows each chunk's citation label so a citation can actually be verified", async () => {
    const captured: { user?: string } = {};
    await runReviewer(captured);
    expect(captured.user).toContain("[QS. 2:255]");
    expect(captured.user).toContain("[HR. Malik no. 185 (Sahih)]");
    // And the label rides the same block as its text, so the pairing is readable.
    expect(captured.user).toContain("اللَّهُ لَا إِلَٰهَ إِلَّا هُوَ [QS. 2:255]");
  });

  it("shows exactly the evidence the generator's context renders", async () => {
    const captured: { user?: string } = {};
    await runReviewer(captured);
    const context = await assembledContext();
    const evidence = context.turns.at(-1)?.content ?? "";
    expect(evidence).not.toBe("");
    expect(captured.user).toContain(evidence);
    // Both text layers of a fallback-track hit reach the reviewer.
    expect(captured.user).toContain("بِسْمِ اللّٰهِ الرَّحْمٰنِ الرَّحِيْمِ");
    expect(captured.user).toContain("(Terjemahan mesin — lihat teks Arab asli)");
    expect(captured.user).toContain(
      "Dengan nama Allah Yang Maha Pengasih lagi Maha Penyayang. [QS. 1:1]",
    );
  });

  it("emits no dangling label for a chunk that carries none", async () => {
    const captured: { user?: string } = {};
    await runReviewer(captured);
    expect(captured.user).toContain("tanpa label");
    expect(captured.user).not.toContain("[]");
  });

  it("does not repeat a grade the citation label already carries", async () => {
    // `[HR. Malik no. 187 (Sahih) (sahih)]` made the generator copy a
    // duplicated label, which the reviewer then failed as a modified citation.
    const captured: { user?: string } = {};
    await runReviewer(captured);
    expect(captured.user).not.toContain("(Sahih) (sahih)");
  });
});

/**
 * Round-3 A2: a generator-emitted refusal must short-circuit. The old flow ran
 * the canonical refusal draft through the reviewer LLM (a paid call), appended
 * the ulama disclaimer to it, and recorded no `refusal` event — contradicting
 * the invariant that product rules are "never applied to a refusal" and
 * hiding the refusal from the trace signal the eval harness reads.
 */
describe("generator-emitted refusal short-circuit", () => {
  async function runRefusalReview(draftText: string): Promise<{
    result: { text: string };
    events: { kind: string; detail?: Record<string, unknown> }[];
    providerCalled: boolean;
  }> {
    const events: { kind: string; detail?: Record<string, unknown> }[] = [];
    let providerCalled = false;
    const reviewer = createKajianQReviewer({
      provider: {
        generate: () => {
          providerCalled = true;
          return Effect.succeed({ text: '{"verdict": "pass", "reason": "-"}', cost: cost() });
        },
      },
      // applyProductRules deliberately left at its default (on): the refusal
      // must come out undecorated even with the rules enabled.
      language: "id",
    });
    const result = (await Effect.runPromise(
      Effect.provideService(
        reviewer.review({ text: draftText } as never, await assembledContext()) as never,
        RunContext,
        {
          config: {},
          now: () => 1,
          record: (e: { kind: string; detail?: Record<string, unknown> }) => events.push(e),
        } as never,
      ) as never,
    )) as { text: string };
    return { result, events, providerCalled };
  }

  it("returns the ID refusal verbatim with a refusal event and no reviewer call", async () => {
    const refusal = "tidak menemukan dalil yang memadai";
    const { result, events, providerCalled } = await runRefusalReview(refusal);
    expect(result.text).toBe(refusal);
    expect(providerCalled).toBe(false);
    const refusalEvent = events.find((e) => e.kind === "refusal");
    expect(refusalEvent).toBeDefined();
    expect(refusalEvent?.detail?.["trigger"]).toBe("generator_refusal");
    expect(events.some((e) => e.kind === "llm_call")).toBe(false);
  });

  it("returns the EN refusal verbatim and appends no disclaimer", async () => {
    const refusal = "could not find adequate evidence";
    const { result, events, providerCalled } = await runRefusalReview(refusal);
    expect(result.text).toBe(refusal);
    expect(providerCalled).toBe(false);
    expect(result.text).not.toContain("bukan fatwa");
    expect(result.text).not.toContain("not a fatwa");
    expect(events.find((e) => e.kind === "refusal")).toBeDefined();
  });

  it("does not short-circuit an ordinary answer", async () => {
    const { result, events, providerCalled } = await runRefusalReview(
      "Jawaban dengan QS. 2:255 dan HR. Malik no. 185.",
    );
    expect(providerCalled).toBe(true);
    expect(events.some((e) => e.kind === "refusal")).toBe(false);
    expect(result.text).toContain("QS. 2:255");
  });
});
