import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { RunContext, type AssembledContext } from "@app/rag-core";
import type { CostRecord } from "@app/contracts";
import { createKajianQReviewer } from "./chat-reviewer";
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
 */

const cost = (): CostRecord => ({
  modelId: "m",
  tokensIn: 1,
  tokensOut: 1,
  latencyMs: 1,
  costMicroUsd: 1,
});

const context = (): AssembledContext<KajianQFilters> =>
  ({
    query: { intent: "Apa maksud Ayat Kursi?", subQueries: [], filters: {} },
    chunks: [
      { id: "c1", text: "اللَّهُ لَا إِلَٰهَ إِلَّا هُوَ", metadata: { citation: "QS. 2:255" } },
      {
        id: "c2",
        text: "puasa dalam perjalanan",
        metadata: { citation: "HR. Malik no. 185 (Sahih)" },
      },
      // A chunk with no citation label must not produce a dangling prefix.
      { id: "c3", text: "tanpa label", metadata: {} },
    ],
    turns: [],
  }) as never;

function runReviewer(captured: { user?: string }) {
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
  return Effect.runPromise(
    Effect.provideService(
      reviewer.review(
        { text: "Jawaban dengan QS. 2:255 dan HR. Malik no. 185." } as never,
        context(),
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
    // And the label rides the same line as its text, so the pairing is readable.
    expect(captured.user).toContain("[QS. 2:255] اللَّهُ لَا إِلَٰهَ إِلَّا هُوَ");
  });

  it("emits no label prefix for a chunk that carries none", async () => {
    const captured: { user?: string } = {};
    await runReviewer(captured);
    expect(captured.user).toContain("- tanpa label");
    expect(captured.user).not.toContain("[] ");
  });
});
