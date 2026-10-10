import { describe, expect, it } from "vitest";
import { validateCitations } from "./chat-citation-validator";
import {
  DEFAULT_REFUSALS,
  isEarnedRefusal,
  isRefusalDraft,
  isRefusalOnly,
  REFUSAL_DRAFT_DECISIONS,
  REFUSAL_FLOORS,
  refusalDraftDecision,
  refusalFloorText,
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
  const sentence = refusalFloorText("id");

  it("owns the floors: the pinned #285 copy is the frame the rule reads (review B1)", () => {
    // The floor text is spelled out ONCE, here. `REFUSAL_FLOORS` is what the
    // exemption's rule derives from and every floor draft in this suite renders
    // through `refusalFloorText`, so a copy edit reddens on this pin instead of
    // silently transcribing a floor that no longer exists.
    expect(refusalFloorText("id")).toBe(
      "Mohon maaf, kami tidak menemukan dalil yang memadai untuk pertanyaan ini.",
    );
    expect(refusalFloorText("en")).toBe(
      "Sorry, we could not find adequate evidence for this question.",
    );
  });

  it("is the sentence with no citation-shaped span, in either language", () => {
    expect(isEarnedRefusal(sentence, validateCitations(sentence, CHUNKS))).toBe(true);
    const en = refusalFloorText("en");
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
 * The ASSERTING refusal draft (#443) — the residual #439 deliberately left, and
 * the fold #452 closed inside it.
 *
 * `isRefusalDraft` reads the SENTENCE, and the earned shape used to read "cites
 * nothing" as "declines". A draft whose own sentences assert something and
 * which cites nothing at all satisfied both, so it shipped verbatim: the reader
 * got assertions with neither the refusal's own framing nor the product's
 * unconditional copy, and the trace recorded no `product_rules` event because
 * no rule ever ran. The failure is silent — no gate scores the delivered text.
 *
 * The signal is `isRefusalOnly`: the refusal plus the framing the product
 * itself pins, and nothing else — a positive vocabulary, not a claim
 * classifier. An unrecognised text takes the SAFE direction (the product's own
 * refusal rather than the model's words); #452 closed the one shape that failed
 * OPEN instead, an assertion folded into the refusal's own sentence, which no
 * sentence boundary can see. Both directions of that closure are pinned at the
 * bottom of this file: the fold leaving the exemption, and the legitimate
 * declines that must keep shipping their own text.
 */
describe("the asserting refusal draft (#443)", () => {
  const CHUNKS = [
    { id: "c1", text: "اللَّهُ لَا إِلَٰهَ إِلَّا هُوَ", metadata: { citation: "QS. 2:255" } },
  ] as never;
  const sentence = refusalFloorText("id");
  /** Citation-free prose whose own sentence asserts a ruling. */
  const assertion = "Hadits tentang puasa dalam perjalanan berstatus sahih dan wajib diamalkan.";

  it("reads the decline: the sentence with its own framing and nothing else", () => {
    // The #285 pin's exact text — the shape that MUST keep shipping byte-for-byte.
    expect(isRefusalOnly(sentence)).toBe(true);
    expect(isRefusalOnly(refusalFloorText("en"))).toBe(true);
    // A mixed-language draft is read by either language's sentence.
    expect(isRefusalOnly(`${REFUSAL_FLOORS.id.head} ${DEFAULT_REFUSALS.id}.`)).toBe(true);
    // The bare sentence, with and without terminal punctuation, and multi-line
    // wrapping of one sentence (intra-paragraph newlines are not boundaries).
    expect(isRefusalOnly(DEFAULT_REFUSALS.id)).toBe(true);
    expect(isRefusalOnly(`${DEFAULT_REFUSALS.id}.`)).toBe(true);
    const { head, tail } = REFUSAL_FLOORS.id;
    const wrapped = `${head.replace(", ", ",\n")}\n${DEFAULT_REFUSALS.id}\n${tail}.`;
    expect(isRefusalOnly(wrapped)).toBe(true);
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

  it("keeps a legitimate decline that says more shipping its own text (#452)", () => {
    // The OVER-NARROWING direction of #452's fix, and a pin that MOVED: it used
    // to read "a second framing sentence is not the refusal-only shape" and
    // recorded `product_refusal` as the safe direction. `Mohon maaf.` is the
    // floor's own apology frame standing as its own sentence — the frame the
    // product itself pins — and it carries nothing of the model's, so refusing
    // it costs the reader the model's politeness for no safety gain. A frame
    // rule that reads whole runs is exactly what can over-narrow here (an
    // exemption granted only to the sentence plus a frame welded to it refuses
    // this text), so the shipped text is pinned, not just the predicate.
    const twoSentences = `${REFUSAL_FLOORS.id.head.replace(", kami", ".")} Kami ${DEFAULT_REFUSALS.id}.`;
    const citations = validateCitations(twoSentences, CHUNKS);
    expect(citations.grounded).toEqual([]);
    expect(citations.ungrounded).toEqual([]);
    expect(isRefusalOnly(twoSentences)).toBe(true);
    const decision = refusalDraftDecision(twoSentences, citations);
    expect(decision?.shape).toBe("pure_refusal");
    expect(decision?.delivery).toBe("draft");
  });

  it("keeps the EN floor shipping its own text (#452)", () => {
    // The other over-narrowing shape: a frame built from the ID floor alone
    // would leave the EN floor outside the exemption. Its predicate pin is
    // above; this is the decision, because "reads it" and "ships it" are
    // different claims.
    const en = refusalFloorText("en");
    const citations = validateCitations(en, CHUNKS);
    expect(citations.grounded).toEqual([]);
    expect(citations.ungrounded).toEqual([]);
    expect(isRefusalOnly(en)).toBe(true);
    expect(refusalDraftDecision(en, citations)?.delivery).toBe("draft");
  });

  it("closes the fold: an assertion inside the refusal's own sentence leaves the exemption (#452)", () => {
    // The residual #443 recorded as failing OPEN, and the spellings a test that
    // only reads sentence boundaries would still miss: a connector other than
    // `namun`, and the clause written AFTER the sentence. Every row carries the
    // canonical sentence, cites nothing, and asserts something of its own — so
    // no boundary separates them, and each must take the backstop: the reader
    // gets the product's own refusal rather than the model's assertion.
    const rows: [string, string][] = [
      ["the fold", `Haditsnya sahih dan wajib diamalkan, namun kami ${DEFAULT_REFUSALS.id}.`],
      [
        "another connector",
        `Haditsnya sahih dan wajib diamalkan, tetapi kami ${DEFAULT_REFUSALS.id}.`,
      ],
      [
        "clause after the sentence",
        `Kami ${DEFAULT_REFUSALS.id}, namun haditsnya sahih dan wajib diamalkan.`,
      ],
      // The EN sentence with the same fold, so the vocabulary cannot be read as
      // an ID-only frame plus whatever the EN half happens to permit.
      ["an EN fold", `The hadith is sound and binding, but we ${DEFAULT_REFUSALS.en}.`],
    ];
    for (const [name, draft] of rows) {
      const citations = validateCitations(draft, CHUNKS);
      expect(citations.grounded, name).toEqual([]);
      expect(citations.ungrounded, name).toEqual([]);
      expect(isRefusalOnly(draft), name).toBe(false);
      const decision = refusalDraftDecision(draft, citations);
      expect(decision?.shape, name).toBe("asserting_refusal");
      expect(decision?.delivery, name).toBe("product_refusal");
    }
  });

  it("closes the frame-as-word-bag: a claim in the frame's own words leaves the exemption (review A1)", () => {
    // Review A1's rows, reproduced at head ca581b9 before the fix: every word is
    // one the floor's frame pins, so a rule that read the frame as an unordered
    // bag admitted them and shipped the model's own sentence verbatim
    // (`generator_refusal`, no `product_rules` event). The frame is read as
    // ORDERED runs now, so a permutation of its words is content. These rows are
    // the gate on that closure.
    const rows = [
      "We question this. Kami tidak menemukan dalil yang memadai.",
      "Ini pertanyaan kami. Kami tidak menemukan dalil yang memadai.",
      "Question this for we. Kami tidak menemukan dalil yang memadai.",
    ];
    for (const draft of rows) {
      const citations = validateCitations(draft, CHUNKS);
      expect(citations.grounded, draft).toEqual([]);
      expect(citations.ungrounded, draft).toEqual([]);
      expect(isRefusalOnly(draft), draft).toBe(false);
      const decision = refusalDraftDecision(draft, citations);
      expect(decision?.shape, draft).toBe("asserting_refusal");
      expect(decision?.delivery, draft).toBe("product_refusal");
    }
  });

  it("reads a symbol-only segment as content, not framing (review A2)", () => {
    // A residue with no word run at all used to satisfy `[].every(...)`, so any
    // emoji, dash or punctuation-only segment shipped inside the pure refusal.
    // Two mechanisms refuse them now: a non-word residue matches no frame run
    // (the emoji and dash rows — review A2's own evidence), and an EMPTY residue
    // needs the segment itself to have carried the canonical sentence (the
    // separator row: `,` is no sentence boundary, so `,,,` survives as its own
    // segment and normalises away to nothing — exactly the case `[].every`
    // answered `true`). The bare sentence, whose segment does carry it, is
    // pinned above.
    const rows = [
      `Mohon maaf, kami ${DEFAULT_REFUSALS.id} untuk pertanyaan ini. 🤲🤲`,
      `🤲🤲. Kami tidak menemukan dalil yang memadai.`,
      `—\n\nKami ${DEFAULT_REFUSALS.id}.`,
      `,,,\n\nKami ${DEFAULT_REFUSALS.id}.`,
    ];
    for (const draft of rows) {
      expect(isRefusalOnly(draft), draft).toBe(false);
      expect(refusalDraftDecision(draft, validateCitations(draft, CHUNKS))?.delivery, draft).toBe(
        "product_refusal",
      );
    }
  });

  it("reads the sentence's own vocabulary as content, not framing (the negation flip)", () => {
    // The trap in the fix itself: a vocabulary that admitted the canonical
    // sentence's own words as "framing" would grant the exemption to the
    // sentence with its negation dropped — the opposite claim, written in the
    // refusal's own vocabulary. The residue is read against the PINNED FRAME
    // only, so this leaves the exemption and is refused.
    const flipped = `Kami menemukan dalil yang memadai. ${REFUSAL_FLOORS.id.head} ${DEFAULT_REFUSALS.id}.`;
    expect(isRefusalOnly(flipped)).toBe(false);
    expect(refusalDraftDecision(flipped, validateCitations(flipped, CHUNKS))?.delivery).toBe(
      "product_refusal",
    );
  });
});
