import { describe, expect, it } from "vite-plus/test";
import { QUOTE_EQUIVALENCES } from "./chat-quote-equivalences";

/** The eval harness applies an equivalence to the generically folded (lower-cased) text. */
const apply = (text: string): string =>
  QUOTE_EQUIVALENCES.reduce(
    (folded, { pattern, replacement }) => folded.replace(pattern, replacement),
    text.toLowerCase(),
  );

describe("QUOTE_EQUIVALENCES", () => {
  it("makes the spaced and joined spellings of a divine epithet equal", () => {
    expect(apply("Maha Perkasa")).toBe(apply("Mahaperkasa"));
  });

  it("leaves text that does not carry the epithet untouched", () => {
    expect(apply("kata pengantar")).toBe("kata pengantar");
  });
});
