import { describe, expect, it } from "vite-plus/test";
import { MACHINE_TRANSLATION_LABEL, splitAnswerBlocks } from "./chat-render";
import { messages } from "./i18n-messages";

/**
 * The postprocess appends warning → MT label → disclaimer
 * (`packages/kajianq-domain/src/chat-postprocess.ts`), so the tail of an
 * Indonesian answer is `[warning][MT label]`. The peel must walk the whole
 * trailing rule run rather than only the last two paragraphs: otherwise the
 * warning stays in `split.body` (drawn as prose) and the frame-flag card draws
 * it again.
 *
 * This spec owns the trailing rule run as a whole: every order and repeat of
 * the three rule kinds, the product's canonical copy as the only value the
 * card may render, and the marker tolerance a copy tweak gets. The
 * client↔server copy pair itself is pinned by
 * `tests/parity/chat-rule-copy.test.mjs`.
 */

/** The product's canonical copies — read from the i18n copy the card renders. */
const WARNING_ID = messages.id.dhaifWarningCard;
const WARNING_EN = messages.en.dhaifWarningCard;
const DISCLAIMER = "Jawaban ini bukan fatwa; rujuk ulama untuk keputusan hukum.";
const MT = `[${MACHINE_TRANSLATION_LABEL}]`;
const PROSE = "Jawaban.";

/** Occurrences of `needle` in a string, so "exactly once" is measurable. */
const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

/**
 * Every trailing-run shape a delivered, rehydrated, or hand-edited answer can
 * produce. `bodyTail` is what must remain of the run in `body`, in text order,
 * after the leading prose: the MT label and any non-canonical marker prose.
 */
const SHAPES: readonly {
  name: string;
  /** The rule run, in text order, appended after the leading prose. */
  tail: readonly string[];
  warning: string | null;
  disclaimer: string | null;
  bodyTail: readonly string[];
}[] = [
  // The reviewer's shapes: a re-seen marker must not break the walk.
  {
    name: "[W][W]",
    tail: [WARNING_ID, WARNING_ID],
    warning: WARNING_ID,
    disclaimer: null,
    bodyTail: [],
  },
  {
    name: "[W][MT][W]",
    tail: [WARNING_ID, MT, WARNING_ID],
    warning: WARNING_ID,
    disclaimer: null,
    bodyTail: [MT],
  },
  {
    name: "[D][W][W]",
    tail: [DISCLAIMER, WARNING_ID, WARNING_ID],
    warning: WARNING_ID,
    disclaimer: DISCLAIMER,
    bodyTail: [],
  },
  // The live postprocess orders.
  {
    name: "[W][MT]",
    tail: [WARNING_ID, MT],
    warning: WARNING_ID,
    disclaimer: null,
    bodyTail: [MT],
  },
  { name: "[W]", tail: [WARNING_ID], warning: WARNING_ID, disclaimer: null, bodyTail: [] },
  {
    name: "[D][W]",
    tail: [DISCLAIMER, WARNING_ID],
    warning: WARNING_ID,
    disclaimer: DISCLAIMER,
    bodyTail: [],
  },
  {
    name: "[W][MT][D]",
    tail: [WARNING_ID, MT, DISCLAIMER],
    warning: WARNING_ID,
    disclaimer: DISCLAIMER,
    bodyTail: [MT],
  },
  {
    name: "[MT][W][D]",
    tail: [MT, WARNING_ID, DISCLAIMER],
    warning: WARNING_ID,
    disclaimer: DISCLAIMER,
    bodyTail: [MT],
  },
  {
    name: "[MT][D][W]",
    tail: [MT, DISCLAIMER, WARNING_ID],
    warning: WARNING_ID,
    disclaimer: DISCLAIMER,
    bodyTail: [MT],
  },
  {
    name: "[D][MT][W]",
    tail: [DISCLAIMER, MT, WARNING_ID],
    warning: WARNING_ID,
    disclaimer: DISCLAIMER,
    bodyTail: [MT],
  },
  // The EN copy, and the same shapes with the answer's own language.
  {
    name: "[W_en][MT]",
    tail: [WARNING_EN, MT],
    warning: WARNING_EN,
    disclaimer: null,
    bodyTail: [MT],
  },
  {
    name: "[W_en][MT][D]",
    tail: [WARNING_EN, MT, DISCLAIMER],
    warning: WARNING_EN,
    disclaimer: DISCLAIMER,
    bodyTail: [MT],
  },
];

describe("splitAnswerBlocks — the trailing rule run (#292)", () => {
  for (const shape of SHAPES) {
    it(`peels ${shape.name} in one pass, leaving the canonical sentence at one render`, () => {
      const split = splitAnswerBlocks([PROSE, ...shape.tail].join("\n\n"));
      expect(split.warning).toBe(shape.warning);
      expect(split.disclaimer).toBe(shape.disclaimer);
      expect(split.body).toBe([PROSE, ...shape.bodyTail].join("\n\n"));
      // The two display surfaces the card draws from: `body` as prose, and the
      // peeled values as the card/footer. The canonical sentence is in exactly
      // one of them.
      const displayed = [split.body, split.warning ?? "", split.disclaimer ?? ""].join("\n\n");
      expect(occurrences(displayed, shape.warning ?? "\u0000")).toBe(
        shape.warning === null ? 0 : 1,
      );
    });
  }

  it("peels a run that is the whole answer (no prose above it)", () => {
    const split = splitAnswerBlocks([WARNING_ID, MT].join("\n\n"));
    expect(split.warning).toBe(WARNING_ID);
    expect(split.body).toBe(MT);
  });

  it("drops a byte-identical repeat but keeps different marker prose in place", () => {
    // The reviewer's server-producible shape: the draft's own paraphrased
    // warning, then the canonical line the postprocess appended, then the
    // label. The canonical line peels; the paraphrase is ordinary prose and
    // must neither become a second card nor stop the walk above it.
    const paraphrase = "[Peringatan] Sebagian ulama menilai riwayat ini lemah.";
    const split = splitAnswerBlocks([PROSE, DISCLAIMER, paraphrase, WARNING_ID, MT].join("\n\n"));
    expect(split.warning).toBe(WARNING_ID);
    expect(split.disclaimer).toBe(DISCLAIMER);
    expect(split.body).toBe([PROSE, paraphrase, MT].join("\n\n"));
    expect(occurrences(split.body, WARNING_ID)).toBe(0);
  });
});

describe("splitAnswerBlocks — the card's copy authority (A2)", () => {
  it("leaves marker-prefixed prose in the body: it is not the product's copy", () => {
    const prose = "[Peringatan] Sebagian ulama menilai riwayat ini lemah.";
    const split = splitAnswerBlocks([PROSE, prose, MT].join("\n\n"));
    expect(split.warning).toBeNull();
    expect(split.body).toBe([PROSE, prose, MT].join("\n\n"));
  });

  it("leaves a warning-marker paragraph in the other locale's wording as prose", () => {
    // Not the product's copy either: a reworded or paraphrased line is prose,
    // and only the frame flag may put a card beside it.
    const reworded = "[Peringatan] Hadits ini lemah, jangan dijadikan dalil.";
    expect(splitAnswerBlocks([PROSE, reworded].join("\n\n")).warning).toBeNull();
  });

  it("recognizes the canonical copy in either locale, so a language switch renders once", () => {
    // An answer keeps the language it was generated in: after a UI language
    // switch its warning line is still the copy the server appended, and the
    // peel takes it rather than leaving it in `body` beside a second,
    // localized card.
    expect(splitAnswerBlocks([PROSE, WARNING_ID].join("\n\n")).warning).toBe(WARNING_ID);
    expect(splitAnswerBlocks([PROSE, WARNING_EN].join("\n\n")).warning).toBe(WARNING_EN);
  });
});

describe("splitAnswerBlocks — marker tolerance (A3)", () => {
  // The canonical line above a non-canonical rule paragraph is taken by the body
  // scan wherever the walk stops, so the tolerance is load-bearing one paragraph
  // higher: a rule paragraph ABOVE the variant (the disclaimer) must still reach
  // its footer. The first row per tolerance is compatibility, the second is the
  // discriminating one — it reddens when the tolerant opening match is removed.
  const VARIANTS = ["[peringatan] catatan tambahan", "[Peringatan: versi lain", "[Warning!] note"];

  it.each(VARIANTS)("still walks past %s to the canonical line above it", (variant) => {
    const split = splitAnswerBlocks([PROSE, WARNING_ID, variant, MT].join("\n\n"));
    expect(split.warning).toBe(WARNING_ID);
    expect(split.body).toBe([PROSE, variant, MT].join("\n\n"));
  });

  // Mutation: exact-marker matching (`p.startsWith(m)`). The variant between the
  // disclaimer and the tail counts as prose, the walk stops there, and the
  // disclaimer stays in `body` instead of the footer.
  it.each(VARIANTS)(
    "still walks past %s so the disclaimer above it reaches its footer",
    (variant) => {
      const split = splitAnswerBlocks([PROSE, DISCLAIMER, variant, MT].join("\n\n"));
      expect(split.disclaimer).toBe(DISCLAIMER);
      expect(split.warning).toBeNull();
      expect(split.body).toBe([PROSE, variant, MT].join("\n\n"));
    },
  );

  // The label peels bracket-optional (`RULE_KINDS` → `opensWith(…, false)`), so
  // both forms are pinned: a rehydrated or hand-edited answer carries it bare,
  // which is the branch `opensWith`'s ternary takes for the label.
  it.each([
    ["bracketed + reworded head (B1 shape)", "[Terjemahan mesin — rujuk teks Arab asli]"],
    ["bare + reworded head", "Terjemahan mesin — rujuk teks Arab asli"],
    ["bare + canonical label", MACHINE_TRANSLATION_LABEL],
  ])("still walks past the MT label: %s", (_name, label) => {
    const split = splitAnswerBlocks([PROSE, WARNING_ID, label].join("\n\n"));
    expect(split.warning).toBe(WARNING_ID);
    expect(split.body).toBe([PROSE, label].join("\n\n"));
  });

  // Mutation: the label made bracket-required (`opensWith(…, true)`). A bare
  // label between the disclaimer and the tail no longer classifies, the walk
  // stops, and the disclaimer stays in `body` — the two bare rows redden here.
  it.each([
    ["bracketed + reworded head (B1 shape)", "[Terjemahan mesin — rujuk teks Arab asli]"],
    ["bare + reworded head", "Terjemahan mesin — rujuk teks Arab asli"],
    ["bare + canonical label", MACHINE_TRANSLATION_LABEL],
  ])(
    "still walks past the MT label so the disclaimer above it reaches its footer: %s",
    (_name, label) => {
      const split = splitAnswerBlocks([PROSE, DISCLAIMER, label].join("\n\n"));
      expect(split.disclaimer).toBe(DISCLAIMER);
      expect(split.warning).toBeNull();
      expect(split.body).toBe([PROSE, label].join("\n\n"));
    },
  );

  it("does not classify a paragraph that merely mentions the phrase mid-sentence", () => {
    // No bracketed opening, so it is prose and stays whole in `body`. The
    // canonical line above it is the card's copy wherever it sits, so it peels
    // rather than leaving the card to draw over a prose copy.
    const split = splitAnswerBlocks(
      [WARNING_ID, "Peringatan tanpa kurung sama sekali.", MT].join("\n\n"),
    );
    expect(split.warning).toBe(WARNING_ID);
    expect(split.body).toBe(["Peringatan tanpa kurung sama sekali.", MT].join("\n\n"));
  });

  // Mutation: warning markers made bracket-optional (`opensWith(…, false)`). The
  // unbracketed phrase would classify as a warning rule, the walk would continue
  // past it, and the disclaimer above would peel; at head the phrase is prose,
  // so the walk stops and the disclaimer stays whole in `body`.
  it("does not treat an unbracketed phrase as a warning rule", () => {
    const phrase = "Peringatan tanpa kurung sama sekali.";
    const split = splitAnswerBlocks([PROSE, DISCLAIMER, phrase, MT].join("\n\n"));
    expect(split.warning).toBeNull();
    expect(split.disclaimer).toBeNull();
    expect(split.body).toBe([PROSE, DISCLAIMER, phrase, MT].join("\n\n"));
  });

  it("does not eat prose when the trailing rule run ends", () => {
    const split = splitAnswerBlocks(
      ["[Peringatan] ini kalimat pengantar.", PROSE, MT].join("\n\n"),
    );
    expect(split.warning).toBeNull();
    expect(split.body).toBe(["[Peringatan] ini kalimat pengantar.", PROSE, MT].join("\n\n"));
  });
});
