import { describe, expect, it } from "vitest";
import { formatWhen, t } from "./i18n";

describe("i18n", () => {
  it("returns en and id strings", () => {
    expect(t("en", "homeTitle")).toBe("Hello World");
    expect(t("id", "homeTitle")).toBe("Halo Dunia");
  });

  it("formats dates via Intl", () => {
    const s = formatWhen("en", new Date("2026-07-25T12:00:00Z"));
    expect(s.length).toBeGreaterThan(0);
  });
});
