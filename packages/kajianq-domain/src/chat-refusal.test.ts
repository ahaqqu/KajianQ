import { describe, expect, it } from "vitest";
import { validateCitations } from "./chat-citation-validator";
import {
  DEFAULT_REFUSALS,
  isEarnedRefusal,
  isRefusalDraft,
  isRefusalOnly,
  REFUSAL_DRAFT_DECISIONS,
  refusalDraftDecision,
} from "./chat-refusal";

/**
 * The refusal vocabulary's pins: the earned refusal shape (#439), the decline
 * backstop (#443), and the decision table that owns the order between them (the
 * #443 review rounds A1/A2).
 *
 * `isRefusalDraft` is a substring match, so it also catches a HYBRID (the
 * sentence riding a grounded partial answer). Only a draft that cites NOTHING
 * **and declines** ships verbatim — no rules, no invented warning for a text
 * that cites no weak evidence (#285) — and no text whose own sentences assert
 * takes the exemption either (#443). Every case below feeds the REAL
 * deterministic validator's partition to the decision, so the pin is on the
 * composition the stage uses, not on hand-built arrays.
 *
 * Both failure directions are silent, which is why the rows are pinned in both
 * directions rather than described: a shape that wrongly takes the exemption
 * ships the model's own words with no product copy and no `product_rules`
 * event, and a boundary drawn too wide loses the pinned #285 floor text.
 */
describe("the earned refusal shape (#439)", () => {
  const CHUNKS = [
    { id: "c1", text: "اللَّهُ لَا إِلَٰهَ إِلَّا هُوَ", metadata: { citation: "QS. 2:255" } },
  ] as never;
  const sentence = `Mohon maaf, kami ${DEFAULT_REFUSALS.id} untuk pertanyaan ini.`;

  it("is the sentence with no citation-shaped span, in either language", () => {
    expect(isEarnedRefusal(sentence, validateCitations(sentence, CHUNKS))).toBe(true);
    const en = `Sorry, we ${DEFAULT_REFUSALS.en} for this question.`;
    expect(isEarnedRefusal(en, validateCitations(en, CHUNKS))).toBe(true);
  });

  it("is NOT a hybrid: the same sentence riding a grounded span", () => {
    const hybrid = ["Allah Mahahidup dalam [QS. 2:255].", sentence].join("\n\n");
    const citations = validateCitations(hybrid, CHUNKS);
    expect(citations.grounded).toEqual(["QS. 2:255"]);
    expect(isEarnedRefusal(hybrid, citations)).toBe(false);
  });

  it("is NOT a draft whose only span the gate refused", () => {
    // A predicate cannot carry the order — `isEarnedRefusal` reads both halves,
    // so this draft is not the earned shape whether or not the gate ran first.
    // The decision (below) is what makes the ORDER structural, by reading the
    // ungrounded half as its own first row.
    const refused = ["Haditsnya [HR. Bukhari no. 99999].", sentence].join("\n\n");
    const citations = validateCitations(refused, CHUNKS);
    expect(citations.ungrounded).toEqual(["HR. Bukhari no. 99999"]);
    expect(citations.grounded).toEqual([]);
    expect(isEarnedRefusal(refused, citations)).toBe(false);
  });

  it("is NOT an ordinary answer that never carried the sentence", () => {
    const grounded = "Allah Mahahidup dalam [QS. 2:255].";
    expect(isEarnedRefusal(grounded, validateCitations(grounded, CHUNKS))).toBe(false);
  });
});

/**
 * The ASSERTING refusal draft (#443) — the residual #439 deliberately left.
 *
 * `isRefusalDraft` reads the SENTENCE, and the earned shape used to read "cites
 * nothing" as "declines". A draft whose own sentences assert something and
 * which cites nothing at all satisfied both, so it shipped verbatim: the reader
 * got assertions with neither the refusal's own framing nor the product's
 * unconditional copy, and the trace recorded no `product_rules` event because
 * no rule ever ran. The failure is silent — no gate scores the delivered text.
 *
 * The signal is `isRefusalOnly`: the refusal and nothing else. It is a SHAPE
 * test, not a claim classifier, so its false positives take the SAFE direction
 * — an unrecognised text becomes the product's own refusal rather than the
 * model's words. One shape is the exception, and it fails OPEN rather than
 * safe: an assertion folded into the refusal's own sentence. It is recorded
 * where it bites, at the bottom of this file, and tracked as #452.
 */
describe("the asserting refusal draft (#443)", () => {
  const CHUNKS = [
    { id: "c1", text: "اللَّهُ لَا إِلَٰهَ إِلَّا هُوَ", metadata: { citation: "QS. 2:255" } },
  ] as never;
  const sentence = `Mohon maaf, kami ${DEFAULT_REFUSALS.id} untuk pertanyaan ini.`;
  /** Citation-free prose whose own sentence asserts a ruling. */
  const assertion = "Hadits tentang puasa dalam perjalanan berstatus sahih dan wajib diamalkan.";

  it("reads the decline: the sentence with its own framing and nothing else", () => {
    // The #285 pin's exact text — the shape that MUST keep shipping byte-for-byte.
    expect(isRefusalOnly(sentence)).toBe(true);
    expect(isRefusalOnly(`Sorry, we ${DEFAULT_REFUSALS.en} for this question.`)).toBe(true);
    // A mixed-language draft is read by either language's sentence.
    expect(isRefusalOnly(`Mohon maaf, kami ${DEFAULT_REFUSALS.id}.`)).toBe(true);
    // The bare sentence, with and without terminal punctuation, and multi-line
    // wrapping of one sentence (intra-paragraph newlines are not boundaries).
    expect(isRefusalOnly(DEFAULT_REFUSALS.id)).toBe(true);
    expect(isRefusalOnly(`${DEFAULT_REFUSALS.id}.`)).toBe(true);
    expect(isRefusalOnly(`Mohon maaf,\nkami ${DEFAULT_REFUSALS.id}\nuntuk pertanyaan ini.`)).toBe(
      true,
    );
    // The same sentence as a list item, and with blank lines around it: the new
    // boundaries must not manufacture an empty or extra segment.
    expect(isRefusalOnly(`- ${sentence}`)).toBe(true);
    expect(isRefusalOnly(`\n\n${sentence}\n\n`)).toBe(true);
  });

  it("reads the assertion: prose before the sentence, prose after it, and either side", () => {
    expect(isRefusalOnly([assertion, sentence].join("\n\n"))).toBe(false);
    expect(isRefusalOnly([sentence, assertion].join("\n\n"))).toBe(false);
    // Same line, no blank paragraph: the sentence boundary is what is read.
    expect(isRefusalOnly(`${assertion} ${sentence}`)).toBe(false);
    expect(isRefusalOnly(`${sentence} ${assertion}`)).toBe(false);
    // A LIST body is prose too.
    expect(isRefusalOnly([sentence, `- ${assertion}`].join("\n\n"))).toBe(false);
  });

  it("closes the boundary for every shape a sentence split can see (review A1)", () => {
    // Reviewer A1's rows: a newline is not a sentence boundary, so without the
    // paragraph / list-item / non-Latin-terminator split each of these took the
    // exemption and shipped the model's own words with the record claiming the
    // safe direction. Every row must leave the exemption now.
    const rows: [string, string][] = [
      ["unterminated prose", `Haditsnya sahih dan wajib diamalkan\n\nKami ${DEFAULT_REFUSALS.id}.`],
      [
        "list body",
        `- Hukumnya wajib bagi setiap muslim\n- Tidak ada pengecualian\n\nKami ${DEFAULT_REFUSALS.id}.`,
      ],
      ["Arabic line without a terminal period", `قَالَ رَسُولُ اللَّهِ ﷺ\n\nKami ${DEFAULT_REFUSALS.id}.`],
    ];
    for (const [name, draft] of rows) {
      const citations = validateCitations(draft, CHUNKS);
      // The partition separates nothing here — both lists are empty for every
      // row — so the decision turns on the shape alone.
      expect(citations.grounded, name).toEqual([]);
      expect(citations.ungrounded, name).toEqual([]);
      expect(isRefusalOnly(draft), name).toBe(false);
      expect(refusalDraftDecision(draft, citations)?.shape, name).toBe("asserting_refusal");
      expect(refusalDraftDecision(draft, citations)?.delivery, name).toBe("product_refusal");
    }
    // The control that must not move: the same assertion with its terminal
    // period already left the exemption before this round — the split may not
    // change it back.
    const terminated = `Haditsnya sahih dan wajib diamalkan.\n\nKami ${DEFAULT_REFUSALS.id}.`;
    expect(isRefusalOnly(terminated)).toBe(false);
  });

  it("is NOT the earned shape, feeds the real partition, and cites nothing either way", () => {
    for (const draft of [
      [assertion, sentence].join("\n\n"),
      [sentence, assertion].join("\n\n"),
      `${assertion} ${sentence}`,
    ]) {
      // The real validator's partition: no citation-shaped span at all. This is
      // the whole point — no signal in the partition separates these drafts from
      // a decline, which is why the exemption needed a new one.
      const citations = validateCitations(draft, CHUNKS);
      expect(citations.grounded).toEqual([]);
      expect(citations.ungrounded).toEqual([]);
      expect(isEarnedRefusal(draft, citations)).toBe(false);
      expect(refusalDraftDecision(draft, citations)?.shape).toBe("asserting_refusal");
    }
  });

  it("delivers the product's own refusal for the asserting shape, not the draft's words", () => {
    const draft = [assertion, sentence].join("\n\n");
    const decision = refusalDraftDecision(draft, validateCitations(draft, CHUNKS));
    expect(decision).toEqual(REFUSAL_DRAFT_DECISIONS.asserting_refusal);
    // Named explicitly so a rewrite of the table cannot quietly re-route it.
    expect(decision?.delivery).toBe("product_refusal");
    expect(decision?.trigger).toBe("asserting_refusal_draft");
  });

  it("leaves #439's two decisions exactly as they were", () => {
    // The cited hybrid still runs the Always rules under the unchanged trigger,
    // and the pure refusal still ships the draft itself.
    const hybrid = ["Allah Mahahidup dalam [QS. 2:255].", sentence].join("\n\n");
    const hybridDecision = refusalDraftDecision(hybrid, validateCitations(hybrid, CHUNKS));
    expect(hybridDecision?.shape).toBe("hybrid_refusal");
    expect(hybridDecision?.delivery).toBe("rules");
    expect(hybridDecision?.trigger).toBe("generator_refusal");

    const pure = refusalDraftDecision(sentence, validateCitations(sentence, CHUNKS));
    expect(pure?.shape).toBe("pure_refusal");
    expect(pure?.delivery).toBe("draft");
    expect(pure?.trigger).toBe("generator_refusal");
  });

  it("returns null for a draft that never carried the sentence (the ordinary path)", () => {
    const ordinary = "Allah Mahahidup dalam [QS. 2:255].";
    expect(refusalDraftDecision(ordinary, validateCitations(ordinary, CHUNKS))).toBeNull();
    expect(isRefusalOnly(ordinary)).toBe(false);
  });

  /**
   * The ORDER, as the table's own first row (review A2). The stage used to
   * refuse an ungrounded span in a branch above the classification, which made
   * the order a convention split across two call sites: reordered, an ordinary
   * fabricated-citation draft (no refusal sentence) returned `null` from the
   * decision and fell through to the paid reviewer / the rules — whose text
   * still carried the fabrication. Reading the ungrounded half first, inside
   * the decision and independently of `isRefusalDraft`, is what makes a reorder
   * unable to ship it.
   */
  it("refuses a fabricated citation from the decision's first row, sentence or not", () => {
    const fabricated = "Haditsnya [HR. Bukhari no. 99999].";
    const citations = validateCitations(fabricated, CHUNKS);
    expect(citations.ungrounded).toEqual(["HR. Bukhari no. 99999"]);
    expect(isRefusalDraft(fabricated)).toBe(false);
    const decision = refusalDraftDecision(fabricated, citations);
    expect(decision?.shape).toBe("ungrounded_citation");
    expect(decision?.trigger).toBe("ungrounded_citation");
    expect(decision?.delivery).toBe("product_refusal");
    // The reason names the refused span: the deleted guard path recorded
    // "asserts content of its own and cites nothing" for a draft that DID carry
    // one, a false record exactly where the guard was meant to speak.
    expect(decision?.reason).toContain("HR. Bukhari no. 99999");
  });

  it("takes the ungrounded row on a MIXED partition, never the hybrid that ships the fabrication", () => {
    // Grounded AND ungrounded in one draft. A `grounded.length > 0`-first table
    // would answer `hybrid_refusal` / `delivery: "rules"` and the fabricated
    // citation would ship with the Always rules appended; this row is what the
    // mixed case must hit.
    const mixed = [
      "Allah Mahahidup dalam [QS. 2:255].",
      "Haditsnya [HR. Bukhari no. 99999].",
      sentence,
    ].join("\n\n");
    const citations = validateCitations(mixed, CHUNKS);
    expect(citations.grounded).toEqual(["QS. 2:255"]);
    expect(citations.ungrounded).toEqual(["HR. Bukhari no. 99999"]);
    const decision = refusalDraftDecision(mixed, citations);
    expect(decision?.shape).toBe("ungrounded_citation");
    expect(decision?.delivery).toBe("product_refusal");
  });

  it("records its limit: a second framing sentence is not the refusal-only shape", () => {
    // Recorded, not hidden. A multi-sentence polite decline is not recognised as
    // the refusal-only shape (the refusal must be the text's only sentence), so
    // it takes the backstop — and the backstop's delivery is still a refusal the
    // reader recognises, which is the SAFE direction this signal fails in (the
    // model's politeness is lost, nothing unvouched ships).
    const twoSentences = `Mohon maaf. Kami ${DEFAULT_REFUSALS.id}.`;
    expect(isRefusalOnly(twoSentences)).toBe(false);
    expect(
      refusalDraftDecision(twoSentences, validateCitations(twoSentences, CHUNKS))?.delivery,
    ).toBe("product_refusal");
  });

  it("records the residual that fails OPEN: an assertion folded into the refusal's own sentence (#452)", () => {
    // This is NOT the safe direction and the record no longer says it is. The
    // fold and the pinned #285 floor are the same shape — "<clause>,
    // <connector> kami <sentence>." — so no boundary separates the claim from
    // the framing, and telling them apart needs vocabulary knowledge, i.e. the
    // claim classifier this predicate deliberately is not. The exemption is
    // granted, the draft's own words ship, and the defect is the #443 shape
    // narrowed to this one input: tracked as #452. This pin is the record — if
    // the fold is ever closed, this test is what forces the change to be
    // deliberate.
    const fold = `Haditsnya sahih dan wajib diamalkan, namun kami ${DEFAULT_REFUSALS.id}.`;
    expect(isRefusalOnly(fold)).toBe(true);
    const decision = refusalDraftDecision(fold, validateCitations(fold, CHUNKS));
    expect(decision?.shape).toBe("pure_refusal");
    expect(decision?.delivery).toBe("draft");
  });
});
