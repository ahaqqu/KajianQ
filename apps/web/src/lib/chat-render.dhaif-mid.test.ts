import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import {
  type AnswerInline,
  MACHINE_TRANSLATION_LABEL,
  renderBodyBlocks,
  type SplitAnswer,
  splitAnswerBlocks,
} from "./chat-render";
import { messages } from "./i18n-messages";

/**
 * The canonical dhaif line can sit wherever the model placed it, not only in the
 * trailing rule run. `applyProductRules` suppresses its own append when the draft
 * already carries the copy (`hasWeakWarning` in `chat-postprocess.ts`), so the
 * delivered text is `[prose][canonical warning][prose][MT label][disclaimer]`:
 * the trailing run the peel walks holds only the label and the disclaimer, while
 * the frame flag (`dhaifWarning: true`, derived from the same delivered string)
 * still draws the card. The peel must own that paragraph wherever it sits, or the
 * sentence renders twice — once as prose, once as the card.
 *
 * The card's copy authority is unchanged (`CANONICAL_WARNINGS` is the one set,
 * both directions): the copy moves to the card wherever it sits — alone, or out
 * of a paragraph whose remainder is product rule copy (the label, the
 * disclaimer), whose bytes stay in the body. A paragraph whose remainder is the
 * model's words or markup stays whole (A2 and the pinned residual below).
 */

/** The product's canonical copies — read from the i18n copy the card renders. */
const WARNING_ID = messages.id.dhaifWarningCard;
const WARNING_EN = messages.en.dhaifWarningCard;
const DISCLAIMER = "Jawaban ini bukan fatwa; rujuk ulama untuk keputusan hukum.";
const MT = `[${MACHINE_TRANSLATION_LABEL}]`;
const PROSE = ["Paragraf pertama.", "Paragraf kedua.", "Paragraf ketiga."] as const;

/** Occurrences of `needle` in a string, so "exactly once" is measurable. */
const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

const inlineText = (inlines: readonly AnswerInline[]): string =>
  inlines
    .map((inline) =>
      inline.kind === "citation"
        ? inline.label
        : inline.kind === "text"
          ? inline.text
          : inlineText(inline.children),
    )
    .join("");

/** What `body` actually draws: every block's text, as the card renders it. */
const bodyText = (body: string): string =>
  renderBodyBlocks(body, [])
    .flatMap((block) =>
      block.kind === "para" ? [inlineText(block.inlines)] : block.items.map(inlineText),
    )
    .join("\n\n");

/**
 * The three display surfaces of one answer, as `AnswerCard.tsx` draws them:
 * `body` as prose, the card's warning value (`split.warning`, or the canonical
 * copy when the frame flag is set and the peel found nothing), and the footer's
 * disclaimer. `cardFlag` models the frame's `dhaifWarning: true`.
 */
const displayed = (split: SplitAnswer, cardFlag: boolean): string =>
  [
    bodyText(split.body),
    split.warning ?? (cardFlag ? WARNING_ID : ""),
    split.disclaimer ?? "",
  ].join("\n\n");

/** The delivered shape `[prose][copy…][prose][MT label][disclaimer]`, varied. */
function deliveredShape(input: {
  /** Where among the prose paragraphs the copy paragraph sits (0..PROSE.length). */
  warningAt: number;
  /** How many copies the one paragraph carries, newline-separated. */
  copies: number;
  /** Where the disclaimer sits: the footer after the label, the body, or absent. */
  disclaimer: "footer" | "body" | "none";
}): string {
  const warning = Array.from({ length: input.copies }, () => WARNING_ID).join("\n");
  const paragraphs: string[] = [...PROSE];
  paragraphs.splice(input.warningAt, 0, warning);
  if (input.disclaimer === "body") {
    // Above the prose, so a prose paragraph stops the trailing walk before it:
    // a disclaimer in the trailing run is the footer's (the walk keeps going
    // through rule paragraphs).
    paragraphs.unshift(DISCLAIMER);
  }
  paragraphs.push(MT);
  if (input.disclaimer === "footer") paragraphs.push(DISCLAIMER);
  return paragraphs.join("\n\n");
}

/** A paragraph carrying `copies` canonical lines above the given rule copy. */
const copyParagraph = (copy: string, copies: number, remainder: string): string =>
  [...Array.from({ length: copies }, () => copy), remainder].join("\n");

describe("splitAnswerBlocks — the canonical line mid-answer (#303)", () => {
  // The reachable shape's own row, with the mutation named: a trailing-only
  // peel leaves this copy in `body` and the flag card draws it again.
  it("peels the delivered `[prose][copy][prose][MT][disclaimer]` shape — mutation: the peel stops at the trailing run", () => {
    const split = splitAnswerBlocks([PROSE[0], WARNING_ID, PROSE[1], MT, DISCLAIMER].join("\n\n"));
    expect(split.warning).toBe(WARNING_ID);
    expect(split.disclaimer).toBe(DISCLAIMER);
    expect(split.body).toBe([PROSE[0], PROSE[1], MT].join("\n\n"));
    expect(occurrences(bodyText(split.body), WARNING_ID)).toBe(0);
    expect(occurrences(displayed(split, true), WARNING_ID)).toBe(1);
  });

  it.each([
    ["ID", WARNING_ID],
    ["EN", WARNING_EN],
  ])(
    "peels the %s copy at the first, middle and last body position, at one render",
    (_locale, copy) => {
      for (const paragraphs of [
        [copy, PROSE[0], PROSE[1], MT],
        [PROSE[0], copy, PROSE[1], MT],
        [PROSE[0], PROSE[1], copy, MT],
        [PROSE[0], PROSE[1], MT, copy],
      ]) {
        const split = splitAnswerBlocks(paragraphs.join("\n\n"));
        expect(split.warning).toBe(copy);
        expect(occurrences(bodyText(split.body), copy)).toBe(0);
        expect(occurrences(displayed(split, true), copy)).toBe(1);
      }
    },
  );

  it("drops every canonical-copy paragraph, not only the first found", () => {
    // Two separate paragraphs carrying the product's copy: the card draws one,
    // so the body may keep none of them.
    const split = splitAnswerBlocks([PROSE[0], WARNING_ID, PROSE[1], WARNING_ID, MT].join("\n\n"));
    expect(split.warning).toBe(WARNING_ID);
    expect(split.body).toBe([PROSE[0], PROSE[1], MT].join("\n\n"));
    expect(occurrences(displayed(split, true), WARNING_ID)).toBe(1);
  });

  it("keeps one render when a mid-answer copy and a trailing copy meet", () => {
    const split = splitAnswerBlocks(
      [PROSE[0], WARNING_ID, PROSE[1], WARNING_ID, MT, DISCLAIMER].join("\n\n"),
    );
    expect(split.warning).toBe(WARNING_ID);
    expect(split.disclaimer).toBe(DISCLAIMER);
    expect(split.body).toBe([PROSE[0], PROSE[1], MT].join("\n\n"));
    expect(occurrences(displayed(split, true), WARNING_ID)).toBe(1);
  });

  /**
   * The copy can share ONE paragraph with product rule copy — the delivered
   * `[copy][MT label]` variant: `applyProductRules` appends the label as its own
   * paragraph when the draft already carried the warning, and a model that
   * reflows the two into one paragraph (or a rehydration that trims the blank
   * line) produces this shape. Stripping the copy leaves the label's bytes in
   * place, so no answer content moves; the no-drop constraint holds because the
   * remainder is the product's own copy, never the model's words.
   */
  describe("the copy sharing a paragraph with product rule copy", () => {
    it.each([
      ["the MT label", WARNING_ID, copyParagraph(WARNING_ID, 1, MT), MT],
      ["two copies above the MT label", WARNING_ID, copyParagraph(WARNING_ID, 2, MT), MT],
      ["the EN copy above the MT label", WARNING_EN, copyParagraph(WARNING_EN, 1, MT), MT],
      ["the disclaimer", WARNING_ID, copyParagraph(WARNING_ID, 1, DISCLAIMER), DISCLAIMER],
      [
        "the label and the disclaimer",
        WARNING_ID,
        copyParagraph(WARNING_ID, 1, `${MT}\n${DISCLAIMER}`),
        `${MT}\n${DISCLAIMER}`,
      ],
    ])(
      "peels the copy beside %s and keeps the rule copy in place",
      (_name, copy, paragraph, remainder) => {
        const split = splitAnswerBlocks([PROSE[0], paragraph, PROSE[1]].join("\n\n"));
        expect(split.warning).toBe(copy);
        expect(occurrences(bodyText(split.body), WARNING_ID)).toBe(0);
        expect(occurrences(bodyText(split.body), WARNING_EN)).toBe(0);
        expect(occurrences(displayed(split, true), copy)).toBe(1);
        // The remainder renders byte-identically, in the paragraph's own position.
        expect(bodyText(split.body)).toContain(remainder);
        // The prose around it survives, in order.
        expect(bodyText(split.body).startsWith(PROSE[0])).toBe(true);
        expect(bodyText(split.body).endsWith(PROSE[1])).toBe(true);
      },
    );

    it("keeps the trailing footer when the copy + label paragraph sits above it", () => {
      const split = splitAnswerBlocks(
        [PROSE[0], copyParagraph(WARNING_ID, 1, MT), PROSE[1], DISCLAIMER].join("\n\n"),
      );
      expect(split.warning).toBe(WARNING_ID);
      expect(split.disclaimer).toBe(DISCLAIMER);
      expect(split.body).toBe([PROSE[0], MT, PROSE[1]].join("\n\n"));
      expect(occurrences(displayed(split, true), WARNING_ID)).toBe(1);
      expect(occurrences(displayed(split, true), DISCLAIMER)).toBe(1);
    });

    it("peels the copy from a trailing copy + label paragraph", () => {
      // The shape also arrives as the last paragraph of the rule run; the walk
      // keeps it in `body` as marker prose, and the body pass must still split
      // the copy out of it.
      const split = splitAnswerBlocks(
        [PROSE[0], PROSE[1], copyParagraph(WARNING_ID, 1, MT), DISCLAIMER].join("\n\n"),
      );
      expect(split.warning).toBe(WARNING_ID);
      expect(split.disclaimer).toBe(DISCLAIMER);
      expect(split.body).toBe([PROSE[0], PROSE[1], MT].join("\n\n"));
      expect(occurrences(displayed(split, true), WARNING_ID)).toBe(1);
    });

    it("peels the copy when the copy + label paragraph is the whole answer", () => {
      const split = splitAnswerBlocks(copyParagraph(WARNING_ID, 1, MT));
      expect(split.warning).toBe(WARNING_ID);
      expect(split.body).toBe(MT);
      expect(occurrences(displayed(split, true), WARNING_ID)).toBe(1);
    });

    it.each([
      ["same line", `${DISCLAIMER} ${WARNING_ID}`],
      ["same paragraph", `${DISCLAIMER}\n${WARNING_ID}`],
    ])("strips the copy out of a trailing disclaimer that carries it (%s)", (_name, paragraph) => {
      // The walk classifies a paragraph opening with the disclaimer as the
      // footer; the copy riding that same paragraph must not reach the footer
      // and be drawn again by the card.
      const split = splitAnswerBlocks([PROSE[0], paragraph].join("\n\n"));
      expect(split.warning).toBe(WARNING_ID);
      expect(split.disclaimer).toBe(DISCLAIMER);
      expect(split.body).toBe(PROSE[0]);
      expect(occurrences(displayed(split, true), WARNING_ID)).toBe(1);
      expect(occurrences(displayed(split, true), DISCLAIMER)).toBe(1);
    });

    it("strips the copy out of a mid-answer disclaimer that carries it", () => {
      const split = splitAnswerBlocks(
        [PROSE[0], `${DISCLAIMER}\n${WARNING_ID}`, PROSE[1], MT].join("\n\n"),
      );
      expect(split.warning).toBe(WARNING_ID);
      expect(split.disclaimer).toBeNull();
      expect(split.body).toBe([PROSE[0], DISCLAIMER, PROSE[1], MT].join("\n\n"));
      expect(occurrences(displayed(split, true), WARNING_ID)).toBe(1);
    });

    it("holds for any position and copy count beside product rule copy (property)", () => {
      const segment = fc.constantFrom<string>(...PROSE, "Kalimat model lain.");
      fc.assert(
        fc.property(
          fc.array(segment, { maxLength: 5 }),
          fc.nat({ max: 6 }),
          fc.integer({ min: 1, max: 4 }),
          fc.constantFrom("label" as const, "disclaimer" as const),
          (others, rawAt, copies, remainderKind) => {
            const remainder = remainderKind === "label" ? MT : DISCLAIMER;
            const paragraphs = [...others];
            paragraphs.splice(
              Math.min(rawAt, others.length),
              0,
              copyParagraph(WARNING_ID, copies, remainder),
            );
            const split = splitAnswerBlocks(paragraphs.join("\n\n"));
            expect(split.warning).toBe(WARNING_ID);
            expect(occurrences(bodyText(split.body), WARNING_ID)).toBe(0);
            expect(occurrences(displayed(split, true), WARNING_ID)).toBe(1);
            // The rule copy the paragraph carried still renders, and exactly once.
            expect(occurrences(displayed(split, true), remainder)).toBe(1);
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  /**
   * The copy sharing a paragraph with rule copy, enumerated: position in the
   * body × copies × the remainder kind. Every row asserts one render of the
   * canonical line and the remainder rendered once, in order.
   */
  describe("enumeration: copy + rule copy position × copies × remainder", () => {
    const REMAINDERS = {
      label: { text: MT, trailing: [DISCLAIMER] },
      disclaimer: { text: DISCLAIMER, trailing: [MT] },
      both: { text: `${MT}\n${DISCLAIMER}`, trailing: [] },
    } as const;

    const rows = [0, 1, 2, 3].flatMap((mixedAt) =>
      [1, 2, 3].flatMap((copies) =>
        (Object.keys(REMAINDERS) as (keyof typeof REMAINDERS)[]).map((kind) => ({
          mixedAt,
          copies,
          kind,
        })),
      ),
    );

    it.each(rows)(
      "exactly one render for copy at $mixedAt × $copies copies beside $kind",
      (row) => {
        const remainder = REMAINDERS[row.kind];
        const paragraphs: string[] = [...PROSE];
        paragraphs.splice(row.mixedAt, 0, copyParagraph(WARNING_ID, row.copies, remainder.text));
        paragraphs.push(...remainder.trailing);
        const split = splitAnswerBlocks(paragraphs.join("\n\n"));

        // The canonical line: once, as the card's value; the body keeps none.
        expect(split.warning).toBe(WARNING_ID);
        expect(occurrences(bodyText(split.body), WARNING_ID)).toBe(0);
        expect(occurrences(displayed(split, true), WARNING_ID)).toBe(1);

        // The remainder stays in place, and no prose paragraph is dropped.
        const expectedBody = [
          ...PROSE.slice(0, row.mixedAt),
          remainder.text,
          ...PROSE.slice(row.mixedAt),
          ...(row.kind === "disclaimer" ? [MT] : []),
        ].join("\n\n");
        expect(bodyText(split.body)).toBe(expectedBody);

        // The label and the disclaimer each render once, on their surface.
        expect(occurrences(bodyText(split.body), MT)).toBe(1);
        if (row.kind === "label") {
          expect(split.disclaimer).toBe(DISCLAIMER);
          expect(occurrences(bodyText(split.body), DISCLAIMER)).toBe(0);
          expect(occurrences(displayed(split, true), DISCLAIMER)).toBe(1);
        } else {
          expect(split.disclaimer).toBeNull();
          expect(occurrences(bodyText(split.body), DISCLAIMER)).toBe(1);
          expect(occurrences(displayed(split, true), DISCLAIMER)).toBe(1);
        }
      },
    );
  });

  /**
   * The enumeration over the reachable shape: copy position × copies per
   * paragraph × disclaimer position. Every row asserts the canonical line renders
   * exactly once, the body keeps every prose paragraph in order, and the label
   * and the disclaimer are each rendered once on the surface that owns them.
   */
  describe("enumeration: body position × copies × disclaimer position", () => {
    const rows = [0, 1, 2, 3].flatMap((warningAt) =>
      [1, 2, 3].flatMap((copies) =>
        (["footer", "body", "none"] as const).map((disclaimer) => ({
          warningAt,
          copies,
          disclaimer,
        })),
      ),
    );

    it.each(rows)(
      "exactly one render for copy at $warningAt × $copies copies × disclaimer in $disclaimer",
      (row) => {
        const split = splitAnswerBlocks(deliveredShape(row));
        // The canonical line: once, as the card's value, never in the body.
        expect(split.warning).toBe(WARNING_ID);
        expect(occurrences(bodyText(split.body), WARNING_ID)).toBe(0);
        expect(occurrences(displayed(split, true), WARNING_ID)).toBe(1);

        // No prose paragraph is dropped, and order is kept.
        const drawn = bodyText(split.body).split("\n\n");
        expect(drawn).toEqual([...(row.disclaimer === "body" ? [DISCLAIMER] : []), ...PROSE, MT]);

        // The label is provenance and stays in the body, once.
        expect(occurrences(bodyText(split.body), MT)).toBe(1);

        // The disclaimer reaches the footer when it is trailing; in the body it
        // renders there once and is not also a footer; absent renders nowhere.
        if (row.disclaimer === "footer") {
          expect(split.disclaimer).toBe(DISCLAIMER);
          expect(occurrences(displayed(split, true), DISCLAIMER)).toBe(1);
        } else if (row.disclaimer === "body") {
          expect(split.disclaimer).toBeNull();
          expect(occurrences(bodyText(split.body), DISCLAIMER)).toBe(1);
          expect(occurrences(displayed(split, true), DISCLAIMER)).toBe(1);
        } else {
          expect(split.disclaimer).toBeNull();
          expect(occurrences(displayed(split, true), DISCLAIMER)).toBe(0);
        }
      },
    );
  });

  it("holds for any positions and copy counts (property)", () => {
    // The same invariant the enumeration states, over shapes the matrix does
    // not enumerate: the copy paragraph's index anywhere in the paragraph list,
    // the number of copies, and whether the copy is space- or newline-separated.
    const segment = fc.constantFrom<string>(...PROSE, MT, "Kalimat model lain.");
    fc.assert(
      fc.property(
        fc.array(segment, { maxLength: 6 }),
        fc.nat({ max: 7 }),
        fc.integer({ min: 1, max: 4 }),
        fc.boolean(),
        (others, rawAt, copies, spaceSeparated) => {
          const at = Math.min(rawAt, others.length);
          const copy = Array.from({ length: copies }, () => WARNING_ID).join(
            spaceSeparated ? " " : "\n",
          );
          const paragraphs = [...others];
          paragraphs.splice(at, 0, copy);
          const split = splitAnswerBlocks(paragraphs.join("\n\n"));
          // Exactly once, never zero: the card owns the copy and `body` has none.
          expect(split.warning).toBe(WARNING_ID);
          expect(occurrences(bodyText(split.body), WARNING_ID)).toBe(0);
          expect(occurrences(displayed(split, true), WARNING_ID)).toBe(1);
          // Every other paragraph survives in order, none dropped.
          expect(bodyText(split.body)).toBe(others.join("\n\n"));
        },
      ),
      { numRuns: 200 },
    );
  });
});

/**
 * The residual the owner deliberately leaves: a copy the paragraph does not stop
 * at — wrapped in markdown, opened as a list/blockquote item, or embedded in the
 * model's own sentence. Stripping those would drop markup the card does not
 * render or rewrite the model's words, which the no-drop constraint forbids; the
 * frame flag still draws the card, so the sentence renders twice. These rows pin
 * that residual so a future widening that eats the model's words reddens here.
 */
describe("splitAnswerBlocks — the copy's residual shapes (#303)", () => {
  const RESIDUAL_SHAPES: readonly { name: string; paragraph: string }[] = [
    { name: "bold copy", paragraph: `**${WARNING_ID}**` },
    { name: "list item copy", paragraph: `- ${WARNING_ID}` },
    { name: "blockquote copy", paragraph: `> ${WARNING_ID}` },
    {
      name: "copy embedded in the model's words",
      paragraph: `${WARNING_ID} Sebagian ulama menilai riwayat ini lemah.`,
    },
    {
      name: "copy above marker-prefixed prose",
      paragraph: `${WARNING_ID}\n[Peringatan] Sebagian ulama menilai riwayat ini lemah.`,
    },
  ];

  for (const shape of RESIDUAL_SHAPES) {
    it(`keeps ${shape.name} whole in the body — pinned at two renders`, () => {
      const split = splitAnswerBlocks([PROSE[0], shape.paragraph, PROSE[1], MT].join("\n\n"));
      expect(split.warning).toBeNull();
      expect(split.body).toBe([PROSE[0], shape.paragraph, PROSE[1], MT].join("\n\n"));
      expect(occurrences(bodyText(split.body), WARNING_ID)).toBe(1);
      // The residual: body prose plus the frame-flag card.
      expect(occurrences(displayed(split, true), WARNING_ID)).toBe(2);
    });
  }
});

describe("splitAnswerBlocks — the A2 guard for a mid-answer copy (#303)", () => {
  it("leaves marker-prefixed prose that is not the copy whole in the body", () => {
    const prose = "[Peringatan] Sebagian ulama menilai riwayat ini lemah.";
    const split = splitAnswerBlocks([PROSE[0], prose, PROSE[1], MT].join("\n\n"));
    expect(split.warning).toBeNull();
    expect(split.body).toBe([PROSE[0], prose, PROSE[1], MT].join("\n\n"));
    expect(occurrences(bodyText(split.body), prose)).toBe(1);
  });

  it("leaves a paragraph mixing the copy with the model's words whole", () => {
    // The remainder is the model's marker-prefixed sentence, not product rule
    // copy, so the copy cannot be stripped without touching answer content: the
    // paragraph stays whole and the residual rows above pin the two renders.
    const mixed = `${WARNING_ID}\n[Peringatan] Sebagian ulama menilai riwayat ini lemah.`;
    const split = splitAnswerBlocks([PROSE[0], mixed, PROSE[1], MT].join("\n\n"));
    expect(split.warning).toBeNull();
    expect(split.body).toBe([PROSE[0], mixed, PROSE[1], MT].join("\n\n"));
  });

  it("does not card a reworded near-copy mid-answer", () => {
    const reworded = "[Peringatan] Hadits ini lemah, jangan dijadikan dalil.";
    const split = splitAnswerBlocks([PROSE[0], reworded, PROSE[1], MT].join("\n\n"));
    expect(split.warning).toBeNull();
    expect(split.body).toBe([PROSE[0], reworded, PROSE[1], MT].join("\n\n"));
  });
});
