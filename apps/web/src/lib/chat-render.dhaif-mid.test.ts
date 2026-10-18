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
 * both directions): the copy moves to the card wherever it sits — alone, out of
 * a paragraph whose remainder is product rule copy (the label, the disclaimer),
 * whose bytes stay in the body, or under wrap-only markup (`**`, `_`, `*`, `- `,
 * `* `, `> ` and their combinations), whose delimiters are not answer bytes and
 * go with the copy. A paragraph whose remainder is the model's words stays whole
 * (A2 and the pinned residual below).
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

/** The wrap-only markup a model puts around the copy: delimiters only, never an answer
 * byte. Each form is the whole line, so its lines carry no other content. */
const WRAP_FORMS: readonly { name: string; wrap: (copy: string) => string }[] = [
  { name: "bold", wrap: (copy) => `**${copy}**` },
  { name: "italic", wrap: (copy) => `*${copy}*` },
  { name: "underscore italic", wrap: (copy) => `_${copy}_` },
  { name: "bold italic", wrap: (copy) => `***${copy}***` },
  { name: "bold around underscore italic", wrap: (copy) => `**_${copy}_**` },
  { name: "bullet", wrap: (copy) => `- ${copy}` },
  { name: "asterisk bullet", wrap: (copy) => `* ${copy}` },
  { name: "ordered bullet", wrap: (copy) => `1. ${copy}` },
  { name: "ordered paren bullet", wrap: (copy) => `1) ${copy}` },
  { name: "blockquote", wrap: (copy) => `> ${copy}` },
  { name: "bullet + bold", wrap: (copy) => `- **${copy}**` },
  { name: "blockquote + bold", wrap: (copy) => `> **${copy}**` },
  { name: "blockquote + bullet + bold", wrap: (copy) => `> - **${copy}**` },
  { name: "blockquote + ordered bullet + bold", wrap: (copy) => `> 1. **${copy}**` },
  { name: "indented bullet + underscore italic", wrap: (copy) => `  - _${copy}_` },
];

/** The delivered shape `[prose][copy…][prose][MT label][disclaimer]`, varied. */
function deliveredShape(input: {
  /** Where among the prose paragraphs the copy paragraph sits (0..PROSE.length). */
  warningAt: number;
  /** How many copies the one paragraph carries, newline-separated. */
  copies: number;
  /** Where the disclaimer sits: the footer after the label, the body, or absent. */
  disclaimer: "footer" | "body" | "none";
  /** The wrap-only markup around each copy line, or none. */
  wrap?: (copy: string) => string;
}): string {
  const line = input.wrap?.(WARNING_ID) ?? WARNING_ID;
  const warning = Array.from({ length: input.copies }, () => line).join("\n");
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
 * Wrap-only markup around the canonical copy — `**<copy>**`, `_<copy>_`,
 * `- <copy>`, `1. <copy>`, `> <copy>`, their combinations, and one wrap per
 * line. The delimiters are not answer bytes: stripping them with the copy loses
 * nothing the model wrote, so the paragraph goes whole and the card draws the
 * line once. Every row asserts the body bytes that stay are exactly the prose
 * and product rule copy around the peeled paragraph, so a peel that eats one
 * byte of prose reddens here.
 */
describe("splitAnswerBlocks — the canonical line under wrap-only markup (#548)", () => {
  // The reachable shape's own row, with the mutation named: the pre-change
  // peel accepts a paragraph only when the bytes remaining after the copy are
  // blank or product rule copy, and the bold pair's `****` is neither — so the
  // wrapped copy stays in `body` and the frame-flag card draws it a second time.
  it("peels the delivered `[prose][**copy**][prose][MT][disclaimer]` shape — mutation: the remainder must be blank or product rule copy", () => {
    const split = splitAnswerBlocks(
      [PROSE[0], `**${WARNING_ID}**`, PROSE[1], MT, DISCLAIMER].join("\n\n"),
    );
    expect(split.warning).toBe(WARNING_ID);
    expect(split.disclaimer).toBe(DISCLAIMER);
    expect(split.body).toBe([PROSE[0], PROSE[1], MT].join("\n\n"));
    expect(occurrences(bodyText(split.body), WARNING_ID)).toBe(0);
    expect(occurrences(displayed(split, true), WARNING_ID)).toBe(1);
  });

  it.each(WRAP_FORMS)("peels $name at every body position, at one render", ({ wrap }) => {
    for (const warningAt of [0, 1, 2, 3]) {
      const paragraphs: string[] = [...PROSE];
      paragraphs.splice(warningAt, 0, wrap(WARNING_ID));
      paragraphs.push(MT, DISCLAIMER);
      const split = splitAnswerBlocks(paragraphs.join("\n\n"));
      expect(split.warning).toBe(WARNING_ID);
      // No other byte changed: every prose paragraph and the label render as
      // written, and no delimiter survives anywhere in the body.
      expect(split.body).toBe([...PROSE, MT].join("\n\n"));
      expect(occurrences(bodyText(split.body), WARNING_ID)).toBe(0);
      expect(occurrences(displayed(split, true), WARNING_ID)).toBe(1);
    }
  });

  it.each([
    ["two bold copies", [`**${WARNING_ID}**`, `**${WARNING_ID}**`]],
    ["a bold and a bare copy", [`**${WARNING_ID}**`, WARNING_ID]],
    ["two blockquote copies", [`> ${WARNING_ID}`, `> ${WARNING_ID}`]],
    ["two bullet copies", [`- ${WARNING_ID}`, `- ${WARNING_ID}`]],
    ["a bullet and a blockquote copy", [`> ${WARNING_ID}`, `- ${WARNING_ID}`]],
    ["a blockquote bold copy and a bare copy", [`> **${WARNING_ID}**`, WARNING_ID]],
  ])("peels %s in one paragraph, at one render", (_name, lines) => {
    const split = splitAnswerBlocks([PROSE[0], lines.join("\n"), PROSE[1], MT].join("\n\n"));
    expect(split.warning).toBe(WARNING_ID);
    expect(split.body).toBe([PROSE[0], PROSE[1], MT].join("\n\n"));
    expect(occurrences(bodyText(split.body), WARNING_ID)).toBe(0);
    expect(occurrences(displayed(split, true), WARNING_ID)).toBe(1);
  });

  it("peels the EN copy under wrap-only markup", () => {
    const split = splitAnswerBlocks([PROSE[0], `> _${WARNING_EN}_`, PROSE[1], MT].join("\n\n"));
    expect(split.warning).toBe(WARNING_EN);
    expect(split.body).toBe([PROSE[0], PROSE[1], MT].join("\n\n"));
    expect(occurrences(bodyText(split.body), WARNING_EN)).toBe(0);
    expect(occurrences(displayed(split, true), WARNING_EN)).toBe(1);
  });

  it("keeps the MT label byte-identical when it shares the wrapped copy's paragraph", () => {
    // The label line is product copy, not a wrapper: stripping the copy takes
    // the delimiters with it and leaves the label's bytes in their own place.
    const split = splitAnswerBlocks(
      [PROSE[0], `**${WARNING_ID}**\n${MT}`, PROSE[1], DISCLAIMER].join("\n\n"),
    );
    expect(split.warning).toBe(WARNING_ID);
    expect(split.disclaimer).toBe(DISCLAIMER);
    expect(split.body).toBe([PROSE[0], MT, PROSE[1]].join("\n\n"));
    expect(occurrences(bodyText(split.body), WARNING_ID)).toBe(0);
    expect(occurrences(bodyText(split.body), MT)).toBe(1);
    expect(occurrences(displayed(split, true), WARNING_ID)).toBe(1);
  });

  it("keeps the disclaimer in place when it shares the wrapped copy's paragraph", () => {
    const split = splitAnswerBlocks(
      [PROSE[0], `- ${WARNING_ID}\n${DISCLAIMER}`, PROSE[1], MT].join("\n\n"),
    );
    expect(split.warning).toBe(WARNING_ID);
    expect(split.disclaimer).toBeNull();
    expect(split.body).toBe([PROSE[0], DISCLAIMER, PROSE[1], MT].join("\n\n"));
    expect(occurrences(displayed(split, true), WARNING_ID)).toBe(1);
  });

  it("keeps a product rule line's blockquote marker in place", () => {
    // The label sits behind a blockquote marker, which the renderer does not
    // draw as structure: the peel reads the line through the marker and keeps
    // the line's own bytes, so the copy and the label each render once.
    const split = splitAnswerBlocks(
      [PROSE[0], `**${WARNING_ID}**\n> ${MT}`, PROSE[1], DISCLAIMER].join("\n\n"),
    );
    expect(split.warning).toBe(WARNING_ID);
    expect(split.disclaimer).toBe(DISCLAIMER);
    expect(split.body).toBe([PROSE[0], `> ${MT}`, PROSE[1]].join("\n\n"));
    expect(occurrences(bodyText(split.body), WARNING_ID)).toBe(0);
    expect(occurrences(bodyText(split.body), MT)).toBe(1);
    expect(occurrences(displayed(split, true), WARNING_ID)).toBe(1);
  });

  it("keeps a product rule line's indentation in place", () => {
    const split = splitAnswerBlocks([PROSE[0], `- ${WARNING_ID}\n  ${MT}`, PROSE[1]].join("\n\n"));
    expect(split.warning).toBe(WARNING_ID);
    expect(split.body).toBe([PROSE[0], `  ${MT}`, PROSE[1]].join("\n\n"));
    expect(occurrences(bodyText(split.body), MT)).toBe(1);
    expect(occurrences(displayed(split, true), WARNING_ID)).toBe(1);
  });

  it.each([
    ["a bold repeat", `**${WARNING_ID} ${WARNING_ID}**`],
    ["a bullet repeat", `- ${WARNING_ID} ${WARNING_ID}`],
    ["a blockquote repeat", `> ${WARNING_ID} ${WARNING_ID}`],
    ["an ordered-bullet repeat", `1. ${WARNING_ID} ${WARNING_ID}`],
  ])("peels %s on one wrapped line like a bare repeat", (_name, paragraph) => {
    const split = splitAnswerBlocks([PROSE[0], paragraph, PROSE[1], MT].join("\n\n"));
    expect(split.warning).toBe(WARNING_ID);
    expect(split.body).toBe([PROSE[0], PROSE[1], MT].join("\n\n"));
    expect(occurrences(bodyText(split.body), WARNING_ID)).toBe(0);
    expect(occurrences(displayed(split, true), WARNING_ID)).toBe(1);
  });

  /**
   * The enumeration over the wrap kinds: every form × body position × disclaimer
   * position asserts one render of the canonical line, the body bytes exactly
   * the prose and label that surrounded the peeled paragraph, and the disclaimer
   * on the surface that owns it.
   */
  describe("enumeration: wrap kind × body position × disclaimer position", () => {
    const rows = WRAP_FORMS.flatMap(({ name, wrap }) =>
      [0, 1, 2, 3].flatMap((warningAt) =>
        (["footer", "body", "none"] as const).map((disclaimer) => ({
          name,
          wrap,
          warningAt,
          disclaimer,
        })),
      ),
    );

    it.each(rows)(
      "exactly one render for $name at $warningAt × disclaimer in $disclaimer",
      (row) => {
        const split = splitAnswerBlocks(
          deliveredShape({
            warningAt: row.warningAt,
            copies: 1,
            disclaimer: row.disclaimer,
            wrap: row.wrap,
          }),
        );
        expect(split.warning).toBe(WARNING_ID);
        expect(occurrences(bodyText(split.body), WARNING_ID)).toBe(0);
        expect(occurrences(displayed(split, true), WARNING_ID)).toBe(1);
        // No other byte changed: the prose and the label render exactly as
        // delivered, with the wrapped copy paragraph gone whole.
        expect(split.body).toBe(
          [...(row.disclaimer === "body" ? [DISCLAIMER] : []), ...PROSE, MT].join("\n\n"),
        );
        if (row.disclaimer === "footer") {
          expect(split.disclaimer).toBe(DISCLAIMER);
        } else if (row.disclaimer === "body") {
          expect(split.disclaimer).toBeNull();
          expect(occurrences(bodyText(split.body), DISCLAIMER)).toBe(1);
        } else {
          expect(split.disclaimer).toBeNull();
          expect(occurrences(displayed(split, true), DISCLAIMER)).toBe(0);
        }
      },
    );
  });

  it("holds for any wrap form, position and copy count (property)", () => {
    const segment = fc.constantFrom<string>(...PROSE, MT, "Kalimat model lain.");
    const wrapForm = fc.constantFrom<(copy: string) => string>(...WRAP_FORMS.map((f) => f.wrap));
    fc.assert(
      fc.property(
        fc.array(segment, { maxLength: 6 }),
        fc.nat({ max: 7 }),
        fc.integer({ min: 1, max: 4 }),
        wrapForm,
        (others, rawAt, copies, wrap) => {
          const at = Math.min(rawAt, others.length);
          const wrapped = Array.from({ length: copies }, () => wrap(WARNING_ID)).join("\n");
          const paragraphs = [...others];
          paragraphs.splice(at, 0, wrapped);
          const split = splitAnswerBlocks(paragraphs.join("\n\n"));
          expect(split.warning).toBe(WARNING_ID);
          expect(occurrences(bodyText(split.body), WARNING_ID)).toBe(0);
          expect(occurrences(displayed(split, true), WARNING_ID)).toBe(1);
          // Every other paragraph survives byte-identical, in order.
          expect(bodyText(split.body)).toBe(others.join("\n\n"));
        },
      ),
      { numRuns: 200 },
    );
  });
});

/**
 * Both canonical locales in one answer: the card draws one literal, so a peel
 * that dropped the other would render that delivered sentence **zero** times —
 * worse than the two renders this ticket removes. A paragraph carrying both
 * locales is prose and keeps every byte; a paragraph carrying a different
 * single literal than the card's stays whole too. Every row asserts each
 * delivered literal renders at least once.
 */
describe("splitAnswerBlocks — both canonical locales in one answer (#548)", () => {
  it("keeps a paragraph carrying both locales whole — no zero render", () => {
    const paragraph = `**${WARNING_EN}**\n${WARNING_ID}`;
    const split = splitAnswerBlocks([PROSE[0], paragraph, PROSE[1], MT].join("\n\n"));
    expect(split.warning).toBeNull();
    expect(split.body).toBe([PROSE[0], paragraph, PROSE[1], MT].join("\n\n"));
    expect(occurrences(bodyText(split.body), WARNING_EN)).toBe(1);
    expect(occurrences(bodyText(split.body), WARNING_ID)).toBe(1);
    // The frame-flag card draws the UI locale over the prose; neither literal is lost.
    expect(occurrences(displayed(split, true), WARNING_EN)).toBe(1);
    expect(occurrences(displayed(split, true), WARNING_ID)).toBe(2);
  });

  it("cards the first locale and keeps the other one in the body", () => {
    const split = splitAnswerBlocks(
      [PROSE[0], `**${WARNING_EN}**`, WARNING_ID, PROSE[1], MT].join("\n\n"),
    );
    expect(split.warning).toBe(WARNING_EN);
    expect(split.body).toBe([PROSE[0], WARNING_ID, PROSE[1], MT].join("\n\n"));
    expect(occurrences(displayed(split, true), WARNING_EN)).toBe(1);
    expect(occurrences(displayed(split, true), WARNING_ID)).toBe(1);
  });

  it("keeps a different second locale whole in the body", () => {
    const split = splitAnswerBlocks(
      [PROSE[0], WARNING_ID, `**${WARNING_EN}**`, PROSE[1], MT].join("\n\n"),
    );
    expect(split.warning).toBe(WARNING_ID);
    expect(split.body).toBe([PROSE[0], `**${WARNING_EN}**`, PROSE[1], MT].join("\n\n"));
    expect(occurrences(displayed(split, true), WARNING_EN)).toBe(1);
    expect(occurrences(displayed(split, true), WARNING_ID)).toBe(1);
  });

  it("keeps the other locale in a footer line when the card already draws one", () => {
    // The walk takes the trailing copy first (warning = ID); the footer line
    // carries the EN copy. Stripping it there would render EN zero times, so the
    // footer keeps its own line whole.
    const footer = `${DISCLAIMER} ${WARNING_EN}`;
    const split = splitAnswerBlocks([PROSE[0], footer, WARNING_ID, MT].join("\n\n"));
    expect(split.warning).toBe(WARNING_ID);
    expect(split.disclaimer).toBe(footer);
    expect(occurrences(displayed(split, true), WARNING_EN)).toBe(1);
    expect(occurrences(displayed(split, true), WARNING_ID)).toBe(1);
  });

  it("never drops a delivered canonical literal (property)", () => {
    const segment = fc.constantFrom<string>(
      WARNING_ID,
      WARNING_EN,
      `**${WARNING_ID}**`,
      `**${WARNING_EN}**`,
      `- ${WARNING_ID}`,
      `> ${WARNING_EN}`,
      `1. ${WARNING_ID}`,
      PROSE[0],
      PROSE[1],
      MT,
    );
    fc.assert(
      fc.property(fc.array(segment, { maxLength: 5 }), (paragraphs) => {
        const delivered = paragraphs.join("\n\n");
        const drawn = displayed(splitAnswerBlocks(delivered), true);
        for (const copy of [WARNING_ID, WARNING_EN]) {
          if (delivered.includes(copy)) expect(occurrences(drawn, copy)).toBeGreaterThanOrEqual(1);
        }
      }),
      { numRuns: 200 },
    );
  });
});

/**
 * The residual the owner deliberately leaves: a copy the paragraph does not stop
 * at — embedded in the model's own sentence, under a marker prefix, or carried
 * beside the model's words even when wrapped. Stripping those would rewrite the
 * model's words, which the no-drop constraint forbids; the frame flag still
 * draws the card, so the sentence renders twice. These rows pin that residual so
 * a widening that eats the model's words reddens here.
 */
describe("splitAnswerBlocks — the copy's residual shapes (#303)", () => {
  const RESIDUAL_SHAPES: readonly { name: string; paragraph: string }[] = [
    {
      name: "copy embedded in the model's words",
      paragraph: `${WARNING_ID} Sebagian ulama menilai riwayat ini lemah.`,
    },
    {
      name: "copy inside the model's sentence",
      paragraph: `Hadits ini dinilai lemah karena ${WARNING_ID} sehingga tidak dijadikan dalil.`,
    },
    {
      name: "copy under a marker prefix",
      paragraph: `[Peringatan] ${WARNING_ID}`,
    },
    {
      name: "copy above marker-prefixed prose",
      paragraph: `${WARNING_ID}\n[Peringatan] Sebagian ulama menilai riwayat ini lemah.`,
    },
    {
      name: "bold copy carrying the model's words",
      paragraph: `**${WARNING_ID} Sebagian ulama menilai riwayat ini lemah.**`,
    },
    {
      name: "list item copy carrying the model's words",
      paragraph: `- ${WARNING_ID} — riwayat ini dinilai lemah.`,
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
