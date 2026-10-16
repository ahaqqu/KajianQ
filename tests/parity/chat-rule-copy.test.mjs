import { describe, expect, it } from "vite-plus/test";
import {
  DISCLAIMER_MARKERS,
  MACHINE_TRANSLATION_LABEL,
  WARNING_MARKERS,
  splitAnswerBlocks,
} from "../../apps/web/src/lib/chat-render";
import { messages } from "../../apps/web/src/lib/i18n-messages";
import { MACHINE_TRANSLATION_LABEL as ASSEMBLER_LABEL } from "../../packages/kajianq-domain/src/chat-assembler";
import { dhaifWarning, ulamaDisclaimer } from "../../packages/kajianq-domain/src/chat-postprocess";

/**
 * Client↔server parity for the product's rule copy. The web peel classifies the
 * trailing rule run by the warning line, the marker vocabulary, and the ADR-0006
 * machine-translation label; the server writes those strings from
 * `packages/kajianq-domain`, so a server-side reword could silently stop the peel
 * and resurrect the duplicate with a green suite. Every assertion below reddens
 * when either side is reworded: a server-side reword reddens the equality row and
 * the behavioural peel row, and a client-side one reddens the equality row while
 * the peel row still peels the client's own string.
 *
 * It lives under `tests/` because neither app may import the other's copy:
 * `apps/web` has no `@app/kajianq-domain` dependency (apps/web/package.json),
 * and the domain pack pulls `effect` + `@app/infra` for server-side code that
 * has no business in the web bundle graph. Both sides are importable here, so
 * the guard asserts the real values instead of a third hand-copied literal.
 */
const WARNINGS = { id: dhaifWarning("id"), en: dhaifWarning("en") };

describe("the web rule copy matches the domain pack's canonical copy", () => {
  it("pins the warning line the card renders to dhaifWarning()", () => {
    expect(messages.id.dhaifWarningCard).toBe(WARNINGS.id);
    expect(messages.en.dhaifWarningCard).toBe(WARNINGS.en);
  });

  it("pins the ADR-0006 MT label to the assembler's constant", () => {
    expect(MACHINE_TRANSLATION_LABEL).toBe(ASSEMBLER_LABEL);
  });

  it("pins the marker vocabulary to the canonical copies' openings", () => {
    expect(WARNING_MARKERS).toEqual(["[Peringatan]", "[Warning]"]);
    expect(WARNINGS.id.startsWith(WARNING_MARKERS[0])).toBe(true);
    expect(WARNINGS.en.startsWith(WARNING_MARKERS[1])).toBe(true);
    for (const locale of ["id", "en"]) {
      const disclaimer = ulamaDisclaimer(locale);
      expect(DISCLAIMER_MARKERS.some((marker) => disclaimer.startsWith(marker))).toBe(true);
    }
  });

  it("peels the server's own strings in the delivered tail shape", () => {
    for (const [locale, warning] of Object.entries(WARNINGS)) {
      // The delivered tail shape: warning → MT label.
      const delivered = ["Jawaban.", warning, `[${ASSEMBLER_LABEL}]`].join("\n\n");
      const split = splitAnswerBlocks(delivered);
      expect(split.warning, `${locale}: the server's warning must peel`).toBe(warning);
      expect(split.body).not.toContain(warning);
      // warning → MT label → disclaimer, the full postprocess order.
      const full = ["Jawaban.", warning, `[${ASSEMBLER_LABEL}]`, ulamaDisclaimer(locale)].join(
        "\n\n",
      );
      const withFooter = splitAnswerBlocks(full);
      expect(withFooter.warning).toBe(warning);
      expect(withFooter.disclaimer).toBe(ulamaDisclaimer(locale));
      expect(withFooter.body).toBe(`Jawaban.\n\n[${ASSEMBLER_LABEL}]`);
    }
  });
});
