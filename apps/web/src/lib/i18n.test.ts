import { describe, expect, it } from "vitest";
import { formatMessage, formatNumber, formatWhen, messages, t } from "./i18n";

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

  /**
   * The `{name}` substitution convention (thermo-review B2, #256): the syntax
   * is the i18n layer's, so the next templated message substitutes through
   * `formatMessage` instead of inventing its own at the call site.
   */
  describe("formatMessage", () => {
    it("substitutes {name} placeholders in both locales", () => {
      const en = formatMessage("en", "composerLimit", { max: formatNumber("en", 2000) });
      expect(en).toContain("2,000");
      expect(en).not.toContain("{max}");
      const id = formatMessage("id", "composerLimit", { max: formatNumber("id", 2000) });
      expect(id).toContain("2.000");
      expect(id).not.toContain("{max}");
    });

    it("formats numbers per locale through the same helper the messages use", () => {
      expect(formatNumber("en", 2000)).toBe("2,000");
      expect(formatNumber("id", 2000)).toBe("2.000");
    });

    it("leaves a placeholder with no supplied value verbatim (never an empty guess)", () => {
      expect(formatMessage("en", "composerLimit", {})).toContain("{max}");
    });

    it("keeps the templated message's placeholder in both locales", () => {
      for (const locale of ["en", "id"] as const) {
        expect(messages[locale].composerLimit).toContain("{max}");
      }
    });
  });
});
