import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { RunContext, type AssembledContext, type Chunk } from "@app/rag-core";
import type { CostRecord } from "@app/contracts";
import { createKajianQReviewer, DEFAULT_REFUSALS } from "./chat-reviewer";
import { refusalFloorText } from "./chat-refusal";
import { createKajianQAssembler } from "./chat-assembler";
import type { KajianQFilters } from "./filters";
import { routedQuery } from "./test-utils/routed-query";

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
  const query = routedQuery("Apa maksud Ayat Kursi?");
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
  it("shows the reviewer the verbatim question, not the router's intent", async () => {
    // The reviewer judges the draft against what the user asked; the context's
    // `intent` is the router's classification and must never stand in for it.
    const captured: { user?: string } = {};
    await runReviewer(captured);
    expect(captured.user).toContain("Question: Apa maksud Ayat Kursi?");
    expect(captured.user).not.toContain("Question: factual");
  });

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
 * Round-3 A2 + #439: a generator-emitted refusal must short-circuit. The old
 * flow ran the canonical refusal draft through the reviewer LLM (a paid call),
 * appended the ulama disclaimer to it, and recorded no `refusal` event —
 * contradicting the invariant that product rules are "never applied to a
 * refusal" and hiding the refusal from the trace signal the eval harness reads.
 *
 * #439 adds the other side of the same boundary: the short-circuit is a
 * SUBSTRING match, so a HYBRID draft (a grounded partial answer that runs into
 * the sentence) used to be returned before `applyProductRules` too, shipping a
 * quoted dhaif-graded hadith with no warning line — a control SPECS §2.2 marks
 * "Always". The classification may still skip the PAID reviewer (ADR-0009
 * cost discipline); it may not skip a deterministic rule. The exemption is now
 * keyed to the earned refusal shape: the sentence with no grounded span.
 */
describe("generator-emitted refusal short-circuit", () => {
  async function runRefusalReview(
    draftText: string,
    options: { applyProductRules?: boolean } = {},
  ): Promise<{
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
      ...options,
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
    // The earned refusal shape takes the whole exemption: no rule runs and the
    // trace records no `product_rules` event (#439's negative half).
    expect(events.some((e) => e.kind === "product_rules")).toBe(false);
  });

  it("runs the Always rules on a hybrid but still spends no reviewer call (#439)", async () => {
    // A grounded span (QS. 2:255 is in this context) makes the draft a hybrid:
    // its text answers from the evidence and then declines. The rules must run
    // — the provider above would have been called under the un-fixed
    // classification and this draft is where the grade flag went missing.
    const hybrid = [
      "Allah Mahahidup dalam [QS. 2:255].",
      "Untuk bagian lain dari pertanyaan ini saya tidak menemukan dalil yang memadai.",
    ].join("\n\n");
    const { result, events, providerCalled } = await runRefusalReview(hybrid);
    // The classification is still taken and still skips the paid reviewer.
    expect(providerCalled).toBe(false);
    expect(events.find((e) => e.kind === "refusal")?.detail?.["trigger"]).toBe("generator_refusal");
    // The deterministic rules ran on the delivered text, and the trace says so.
    // (No dhaif-graded chunk is in this context, so the grade flag has no
    // trigger here; the grade half is pinned by chat-dhaif-warning.test.ts.)
    const rules = events.filter((e) => e.kind === "product_rules");
    expect(rules).toHaveLength(1);
    expect(rules[0]?.detail?.["applied"]).toEqual([
      "machine_translation_label",
      "ulama_disclaimer",
    ]);
    expect(result.text.startsWith(hybrid)).toBe(true);
    expect(result.text).toContain("bukan fatwa");
    expect(result.text).toContain("Terjemahan mesin");
  });

  it("honours a disabled-rules wiring on the hybrid path: no event, no append (#285's other half)", async () => {
    // `applyProductRules: false` is how an eval or test wiring turns the rules
    // off. The hybrid exit must honour it and record no event claiming they
    // ran — the same contract the pre-gate skip path is pinned to.
    const hybrid = [
      "Allah Mahahidup dalam [QS. 2:255].",
      "Untuk bagian lain dari pertanyaan ini saya tidak menemukan dalil yang memadai.",
    ].join("\n\n");
    const { result, events } = await runRefusalReview(hybrid, { applyProductRules: false });
    expect(events.some((e) => e.kind === "product_rules")).toBe(false);
    expect(result.text).toBe(hybrid);
  });

  /**
   * #443 — the ASSERTING refusal draft: the sentence in a text that cites
   * nothing AND is not a decline. It used to take the earned-refusal exemption
   * and ship verbatim, so the reader got the draft's own assertions with no
   * refusal framing and no unconditional copy, and the trace recorded no
   * `product_rules` event because no rule ran. The stage's answer is the
   * product's own refusal in place of the model's words: the reader always gets
   * a refusal they can recognise, and no rule is invented for a text that cites
   * nothing (the #285 pin).
   */
  it("refuses a citation-free asserting draft with the product's own refusal (#443)", async () => {
    const assertion = "Hadits tentang puasa dalam perjalanan berstatus sahih dan wajib diamalkan.";
    const draft = [assertion, `Untuk pertanyaan ini kami ${DEFAULT_REFUSALS.id}.`].join("\n\n");
    const { result, events, providerCalled } = await runRefusalReview(draft);
    // The assertion never reaches the reader; the product's refusal does.
    expect(result.text).toBe(DEFAULT_REFUSALS.id);
    expect(result.text).not.toContain(assertion);
    // The decision is on the trace, under its own machine-readable trigger.
    const refusalEvent = events.find((e) => e.kind === "refusal");
    expect(refusalEvent?.detail?.["trigger"]).toBe("asserting_refusal_draft");
    // No rule ran, so nothing may claim it did (#285), and the text that ships
    // carries no dhaif warning invented for a text that cites nothing.
    expect(events.some((e) => e.kind === "product_rules")).toBe(false);
    // And the classification still skips the paid reviewer (ADR-0009).
    expect(providerCalled).toBe(false);
    expect(events.some((e) => e.kind === "llm_call")).toBe(false);
  });

  it("reads the asserting shape on either side of the sentence (#443)", async () => {
    // sentence-then-prose: the same exemption question, the other order.
    const after = `Kami ${DEFAULT_REFUSALS.id}.\n\nNamun perlu diketahui bahwa hukumnya wajib bagi setiap muslim.`;
    const { result, events } = await runRefusalReview(after);
    expect(result.text).toBe(DEFAULT_REFUSALS.id);
    expect(events.find((e) => e.kind === "refusal")?.detail?.["trigger"]).toBe(
      "asserting_refusal_draft",
    );
    // Same paragraph, no blank line: the sentence boundary is what is read.
    const inline = `Hukumnya wajib bagi setiap muslim. Kami ${DEFAULT_REFUSALS.id}.`;
    expect((await runRefusalReview(inline)).result.text).toBe(DEFAULT_REFUSALS.id);
  });

  it("reads a mixed-language asserting draft the same way (#443)", async () => {
    const draft = [
      "This ruling applies to every Muslim without exception.",
      refusalFloorText("en"),
    ].join("\n\n");
    const { result, events } = await runRefusalReview(draft);
    expect(result.text).toBe(DEFAULT_REFUSALS.id);
    expect(result.text).not.toContain("applies to every Muslim");
    expect(events.find((e) => e.kind === "refusal")?.detail?.["trigger"]).toBe(
      "asserting_refusal_draft",
    );
  });

  it("refuses the asserting shape even with the rules disabled: the refusal is not a decoration (#443)", async () => {
    // The trap for a "fix" that ran `withRules` on the asserting shape: with
    // `applyProductRules: false` such a fix would ship the draft's assertions
    // verbatim. The backstop's delivered text does not depend on the rules flag
    // — it replaces the draft, it never appends to it.
    const draft = `Haditsnya sahih dan wajib diamalkan.\n\nKami ${DEFAULT_REFUSALS.id}.`;
    const { result, events } = await runRefusalReview(draft, { applyProductRules: false });
    expect(result.text).toBe(DEFAULT_REFUSALS.id);
    expect(result.text).not.toContain("wajib diamalkan");
    expect(events.some((e) => e.kind === "product_rules")).toBe(false);
  });

  it("keeps a decline that quotes the evidence's own text but cites nothing (#443, the #285 floor)", async () => {
    // The other direction, and the floor the ticket names: the sentence with its
    // own framing and nothing else still ships byte-identical — even though this
    // run's assembled context carries a translation label and a citable hadith.
    const decline = refusalFloorText("id");
    const { result, events, providerCalled } = await runRefusalReview(decline);
    expect(result.text).toBe(decline);
    expect(providerCalled).toBe(false);
    expect(events.find((e) => e.kind === "refusal")?.detail?.["trigger"]).toBe("generator_refusal");
    expect(events.some((e) => e.kind === "product_rules")).toBe(false);
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

/**
 * Thermo-review B1: the reviewer-fail `refusal` event must carry a
 * machine-readable `trigger` like its sibling paths (`ungrounded_citation`,
 * `generator_refusal`) — a refusal-event filter (what `detectRefusal` reads)
 * must be able to tell a decline-to-answer backstop fail from every other
 * reviewer fail without parsing prose.
 */
describe("reviewer-fail refusal event", () => {
  async function runFailReview(): Promise<{
    result: { text: string };
    events: { kind: string; detail?: Record<string, unknown> }[];
  }> {
    const events: { kind: string; detail?: Record<string, unknown> }[] = [];
    const reviewer = createKajianQReviewer({
      provider: {
        generate: () =>
          Effect.succeed({ text: '{"verdict": "fail", "reason": "x"}', cost: cost() }),
      },
      language: "id",
    });
    const result = (await Effect.runPromise(
      Effect.provideService(
        reviewer.review(
          { text: "Jawaban dengan QS. 2:255 dan HR. Malik no. 185." } as never,
          await assembledContext(),
        ) as never,
        RunContext,
        {
          config: {},
          now: () => 1,
          record: (e: { kind: string; detail?: Record<string, unknown> }) => events.push(e),
        } as never,
      ) as never,
    )) as { text: string };
    return { result, events };
  }

  it("records the refusal with a machine-readable trigger and the reviewer copy", async () => {
    const { result, events } = await runFailReview();
    // The reviewer-refusal copy, NOT the canonical insufficiency string
    // (thermo-review A1): the prompt must not promise copy the path skips.
    expect(result.text).toBe("jawaban tidak didukung oleh dalil yang ditemukan");
    const refusalEvent = events.find((e) => e.kind === "refusal");
    expect(refusalEvent).toBeDefined();
    expect(refusalEvent?.detail?.["trigger"]).toBe("reviewer_fail");
  });
});
