import { describe, expect, it } from "vite-plus/test";
import {
  INLINE_DELIMITERS,
  LINE_MARKERS,
  LIST_LINE,
  peelMarkupLayer,
  STYLED_SPAN,
} from "./chat-markup";

/**
 * The one markdown grammar both halves of the answer renderer read. These rows pin
 * what the peel may treat as wrap-only markup and what the renderer draws from the
 * same vocabulary, so a delimiter the card renders can never be left in the body
 * (or stripped where the card would not render it).
 */

/** Every layer peeled, the loop the rule peel runs over a line. */
const peelAll = (text: string): string => {
  let current = text;
  for (;;) {
    const next = peelMarkupLayer(current);
    if (next === null) return current;
    current = next;
  }
};

describe("peelMarkupLayer — wrap-only markup around a line's content", () => {
  it.each([
    ["bold", "**x**", "x"],
    ["italic", "*x*", "x"],
    ["underscore italic", "_x_", "x"],
    ["bold italic", "***x***", "x"],
    ["repeated underscore", "__x__", "x"],
    ["bold around underscore italic", "**_x_**", "x"],
    ["bullet", "- x", "x"],
    ["asterisk bullet", "* x", "x"],
    ["ordered bullet", "1. x", "x"],
    ["ordered paren bullet", "1) x", "x"],
    ["blockquote", "> x", "x"],
    ["nested blockquote + bullet", "> - x", "x"],
    ["nested blockquote + ordered + bold", "> 1. **x**", "x"],
    ["indented bullet", "  - x", "x"],
  ])("peels %s down to its content", (_name, line, content) => {
    expect(peelAll(line)).toBe(content);
    // The peel loop stops as soon as a layer yields nothing.
    expect(peelMarkupLayer(content)).toBeNull();
  });

  it.each([
    ["plain prose", "Sebagian ulama menilai riwayat ini lemah."],
    ["an unpaired asterisk", "*"],
    ["an unclosed pair", "**x"],
    ["an unopened pair", "x**"],
    ["a list marker with no space", "-x"],
  ])("leaves %s unpeeled", (_name, text) => {
    expect(peelMarkupLayer(text)).toBeNull();
  });
});

describe("LIST_LINE / LINE_MARKERS — the renderer's own line markers", () => {
  it.each([
    ["- item", "-", undefined, "item"],
    ["* item", "*", undefined, "item"],
    ["1. item", undefined, "1.", "item"],
    ["1) item", undefined, "1)", "item"],
    ["  - item", "-", undefined, "item"],
  ])("reads %s into its marker and item", (line, bullet, ordered, item) => {
    const match = LIST_LINE.exec(line)!;
    expect(match[1]).toBe(bullet);
    expect(match[2]).toBe(ordered);
    expect(match[3]).toBe(item);
  });

  it("reads a nested marker chain, the shape the peel strips", () => {
    expect(LINE_MARKERS.test("> 1. **x**")).toBe(true);
    expect(LINE_MARKERS.test("plain prose")).toBe(false);
  });
});

describe("STYLED_SPAN — the inline delimiter set", () => {
  it("exposes the delimiter vocabulary the span regex is built from", () => {
    expect([...INLINE_DELIMITERS]).toEqual(["***", "**", "*", "_"]);
  });

  it.each([
    ["***x***", "x"],
    ["**x**", "x"],
    ["*x*", "x"],
    ["_x_", "x"],
  ])("matches %s with the content captured", (text, content) => {
    const match = STYLED_SPAN.exec(text)!;
    expect(match.slice(1).filter((group) => group !== undefined)).toEqual([content]);
  });

  it("keeps arithmetic and snake_case verbatim", () => {
    expect(STYLED_SPAN.test("2 * 3 = 6")).toBe(false);
    expect(STYLED_SPAN.test("snake_case")).toBe(false);
  });
});
