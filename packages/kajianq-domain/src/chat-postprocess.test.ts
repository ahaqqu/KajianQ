import { describe, expect, it } from "vitest";
import type { AssembledContext, Chunk } from "@app/rag-core";
import { MACHINE_TRANSLATION_LABEL } from "./chat-assembler";
import {
  applyProductRules,
  dhaifWarning,
  hasWeakGradeChunk,
  ulamaDisclaimer,
} from "./chat-postprocess";
import { chatSystemPrompt } from "./chat-prompts";
import type { KajianQFilters } from "./filters";

/**
 * The deterministic product rules (spec §2.2, ticket #10 ACs): dhaif warning,
 * machine-translation label, and the ulama disclaimer are appended when the
 * model omitted them, never duplicated when it did not, and never applied to
 * a refusal. These are the rules the answer cannot be trusted to remember.
 */

const context = (
  chunks: readonly Chunk[],
  withTranslation = false,
): AssembledContext<KajianQFilters> => ({
  query: { intent: "q", subQueries: [{ text: "q" }], filters: {} },
  chunks,
  turns: [
    {
      role: "user",
      content: withTranslation
        ? `evidence\n(${MACHINE_TRANSLATION_LABEL})\ntranslation`
        : "evidence",
    },
  ],
});

const chunk = (metadata: Record<string, unknown> = {}): Chunk => ({
  id: "c1",
  text: "evidence",
  metadata: { citation: "QS. 2:255", ...metadata },
});

describe("applyProductRules", () => {
  it("appends the ulama disclaimer when the answer omits it", () => {
    const { draft, applied } = applyProductRules({ text: "Jawaban." }, context([]), "id");
    expect(draft.text).toContain(ulamaDisclaimer("id"));
    expect(applied).toContain("ulama_disclaimer");
  });

  it("does not duplicate a disclaimer the answer already carries", () => {
    const { draft, applied } = applyProductRules(
      { text: `Jawaban.\n\n${ulamaDisclaimer("id")}` },
      context([]),
      "id",
    );
    const occurrences = draft.text.split("bukan fatwa").length - 1;
    expect(occurrences).toBe(1);
    expect(applied).not.toContain("ulama_disclaimer");
  });

  it("appends the dhaif warning when the context carries a weak-grade hadith", () => {
    const { draft, applied } = applyProductRules(
      { text: "Jawaban." },
      context([chunk({ sourceType: "hadith", grade: "dhaif" })]),
      "id",
    );
    expect(draft.text).toContain(dhaifWarning("id"));
    expect(applied).toContain("dhaif_warning");
  });

  it("does not append a dhaif warning when the answer already mentions the weakness", () => {
    const { applied } = applyProductRules(
      { text: "Hadits ini dhaif, jadi tidak dapat dijadikan dalil utama." },
      context([chunk({ grade: "dhaif" })]),
      "id",
    );
    expect(applied).not.toContain("dhaif_warning");
  });

  it("appends no dhaif warning when every retrieved hadith is strong", () => {
    const { applied, draft } = applyProductRules(
      { text: "Jawaban." },
      context([chunk({ sourceType: "hadith", grade: "sahih" })]),
      "id",
    );
    expect(applied).not.toContain("dhaif_warning");
    expect(draft.text).not.toContain("dhaif");
  });

  it("appends the machine-translation label when the answer quotes a translation without it", () => {
    const { draft, applied } = applyProductRules(
      { text: "Terjemahannya: Allah Mahahidup." },
      context([chunk()], true),
      "id",
    );
    expect(draft.text).toContain(MACHINE_TRANSLATION_LABEL);
    expect(applied).toContain("machine_translation_label");
  });

  it("does not re-append the translation label when the answer kept it", () => {
    const { applied } = applyProductRules(
      { text: `Teks Arab…\n(${MACHINE_TRANSLATION_LABEL})\nTerjemahan.` },
      context([chunk()], true),
      "id",
    );
    expect(applied).not.toContain("machine_translation_label");
  });

  it("appends no translation label when the context had no translation", () => {
    const { applied } = applyProductRules({ text: "Jawaban." }, context([chunk()], false), "id");
    expect(applied).not.toContain("machine_translation_label");
  });

  it("emits English rule text for an English answer", () => {
    const { draft } = applyProductRules(
      { text: "Answer." },
      context([chunk({ grade: "dhaif" })], true),
      "en",
    );
    expect(draft.text).toContain(ulamaDisclaimer("en"));
    expect(draft.text).toContain(dhaifWarning("en"));
    expect(draft.text).toContain(MACHINE_TRANSLATION_LABEL);
  });

  it("preserves the model's own text untouched ahead of the appended rules", () => {
    const original = "Jawaban asli dari model. QS. 2:255";
    const { draft } = applyProductRules({ text: original }, context([]), "id");
    expect(draft.text.startsWith(original)).toBe(true);
  });

  it("applies all three rules at once, in one deterministic order", () => {
    const { draft, applied } = applyProductRules(
      { text: "Jawaban." },
      context([chunk({ grade: "dhaif" })], true),
      "id",
    );
    expect(applied).toEqual(["dhaif_warning", "machine_translation_label", "ulama_disclaimer"]);
    const lines = draft.text.split("\n\n");
    expect(lines[0]).toBe("Jawaban.");
    expect(lines[1]).toContain(dhaifWarning("id"));
    expect(lines[2]).toContain(MACHINE_TRANSLATION_LABEL);
    expect(lines[3]).toContain(ulamaDisclaimer("id"));
  });
});

describe("hasWeakGradeChunk", () => {
  it("is true only for the weak grade", () => {
    expect(hasWeakGradeChunk([chunk({ grade: "dhaif" })])).toBe(true);
    expect(hasWeakGradeChunk([chunk({ grade: "sahih" })])).toBe(false);
    expect(hasWeakGradeChunk([chunk({})])).toBe(false);
    expect(hasWeakGradeChunk([])).toBe(false);
  });
});

describe("chatSystemPrompt — the grounding rules the model receives", () => {
  it("states the grounding, citation, dhaif, disclaimer, Arabic, and language rules (id)", () => {
    const prompt = chatSystemPrompt("id");
    expect(prompt).toMatch(/HANYA dari konteks/);
    expect(prompt).toMatch(/sitasi/i);
    expect(prompt).toMatch(/dhaif/);
    expect(prompt).toMatch(/bukan fatwa/);
    expect(prompt).toMatch(/teks Arab/i);
    expect(prompt).toMatch(/bahasa yang sama dengan pertanyaan/);
  });

  it("states the same rules in English", () => {
    const prompt = chatSystemPrompt("en");
    expect(prompt).toMatch(/ONLY from the provided context/);
    expect(prompt).toMatch(/citation/i);
    expect(prompt).toMatch(/dhaif/);
    expect(prompt).toMatch(/not a fatwa/);
    expect(prompt).toMatch(/Arabic text/i);
    expect(prompt).toMatch(/same language as the user's question/);
  });

  it("forbids naming a citation that is not in the context (the fabrication rule)", () => {
    expect(chatSystemPrompt("id")).toMatch(/Jangan pernah menyebut sitasi yang tidak ada/);
    expect(chatSystemPrompt("en")).toMatch(/Never name a citation that is not in the context/);
  });
});
