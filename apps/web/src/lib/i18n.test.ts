import { describe, expect, it } from "vitest";
import { formatWhen, messages, t } from "./i18n";

describe("i18n", () => {
  it("returns en and id strings", () => {
    expect(t("en", "homeTitle")).toBe("KajianQ");
    expect(t("id", "appTitle")).toBe("KajianQ");
    expect(t("id", "health")).toBe("Kesehatan API");
  });

  it("keeps the product name KajianQ everywhere (wordmark, assistant name)", () => {
    expect(t("en", "appTitle")).toBe("KajianQ");
    expect(t("id", "appTitle")).toBe("KajianQ");
  });

  it("externalizes the reference-layout copy in both locales", () => {
    for (const key of [
      "tagline",
      "themeToggle",
      "conversationLabel",
      "savedLocally",
      "greeting",
      "emptyLine1",
      "emptyLine2",
      "suggestion1",
      "suggestion2",
      "suggestion3",
      "footerMeta",
      "warningLabel",
    ] as const) {
      expect(messages.en[key].length).toBeGreaterThan(0);
      expect(messages.id[key].length).toBeGreaterThan(0);
    }
  });

  it("keeps en and id key sets in parity", () => {
    expect(Object.keys(messages.id).sort()).toEqual(Object.keys(messages.en).sort());
  });

  it("formats dates via Intl", () => {
    const s = formatWhen("en", new Date("2026-07-25T12:00:00Z"));
    expect(s.length).toBeGreaterThan(0);
  });
});
