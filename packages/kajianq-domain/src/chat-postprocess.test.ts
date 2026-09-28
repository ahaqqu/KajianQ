import { describe, expect, it } from "vitest";
import type { AssembledContext, Chunk } from "@app/rag-core";
import { MACHINE_TRANSLATION_LABEL } from "./chat-assembler";
import {
  applyProductRules,
  dhaifWarning,
  hasWeakGradeChunk,
  hasWeakWarning,
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

  it("appends the canonical warning over the model's own informal weakness note (#278)", () => {
    // #278 reversed this expectation. It used to assert that a bare
    // "Hadits ini dhaif" suppressed the canonical line — but the model's
    // paraphrase is not the deterministic warning spec §2.2 makes an "Always"
    // control, and the live path proved the cost: the answers that mention
    // `dhaif` are exactly the ones whose context carries a dhaif chunk (the
    // evidence label itself reads "(Dhaif)"), so the token check switched the
    // control off on its whole target set. The user saw a dhaif citation with
    // no warning and read it as sound proof.
    const { applied, draft } = applyProductRules(
      { text: "Hadits ini dhaif, jadi tidak dapat dijadikan dalil utama." },
      context([chunk({ grade: "dhaif" })]),
      "id",
    );
    expect(applied).toContain("dhaif_warning");
    expect(draft.text).toContain(dhaifWarning("id"));
  });

  it("still appends the warning when the answer merely contains the substring 'lemah'", () => {
    // Thermo-review A6: the old `/dhaif|lemah/i` suppressed the warning on any
    // occurrence — including an unrelated sentence — so a genuinely weak
    // hadith shipped with the grade hidden. Suppression must require the
    // product's warning copy, not a shared substring.
    const { applied, draft } = applyProductRules(
      { text: "Angin malam ini terasa lemah, tetapi jawabannya tetap ini." },
      context([chunk({ sourceType: "hadith", grade: "dhaif" })]),
      "id",
    );
    expect(applied).toContain("dhaif_warning");
    expect(draft.text).toContain(dhaifWarning("id"));
  });

  it("still appends the warning when the answer contains a word embedding 'lemah'", () => {
    // "memalemahkan" contains the substring but is not a weakness claim.
    const { applied } = applyProductRules(
      { text: "Kondisi itu dapat memalemahkan semangat." },
      context([chunk({ sourceType: "hadith", grade: "dhaif" })]),
      "id",
    );
    expect(applied).toContain("dhaif_warning");
  });

  it("appends the canonical warning over an informal 'lemah' weakness claim", () => {
    // Round-3 B4: suppression anchors to the product-owned warning copy, not
    // to a ±40-char proximity window around the ordinary word "lemah" — the
    // window was brittle in both directions. An informal claim gains the
    // canonical line: the deterministic rule doing its job, not a duplicate
    // of the model's phrasing.
    const { applied, draft } = applyProductRules(
      { text: "Riwayat ini lemah, sehingga tidak bisa dijadikan dalil." },
      context([chunk({ sourceType: "hadith", grade: "dhaif" })]),
      "id",
    );
    expect(applied).toContain("dhaif_warning");
    expect(draft.text).toContain(dhaifWarning("id"));
  });

  it("appends the canonical warning over a restatement of the copy's grade phrase (#278)", () => {
    // The copy's grade phrases ("berderajat lemah" / "graded weak") are part of
    // the COPY, not independent triggers: a sentence that uses the phrase
    // without the warning statement is still a paraphrase, so it gains the
    // canonical line rather than suppressing it.
    const { applied, draft } = applyProductRules(
      { text: "Hadits ini berderajat lemah, sehingga tidak dapat dijadikan dalil utama." },
      context([chunk({ sourceType: "hadith", grade: "dhaif" })]),
      "id",
    );
    expect(applied).toContain("dhaif_warning");
    expect(draft.text).toContain(dhaifWarning("id"));
  });

  it("does not duplicate the canonical warning the answer already carries", () => {
    // The anti-duplication property that remains: the rule's own copy present
    // in the text is not appended a second time (a double warning is the
    // visible defect the module exists to avoid).
    const { applied, draft } = applyProductRules(
      { text: `Jawaban.\n\n${dhaifWarning("id")}` },
      context([chunk({ sourceType: "hadith", grade: "dhaif" })]),
      "id",
    );
    expect(applied).not.toContain("dhaif_warning");
    expect(draft.text.split(dhaifWarning("id")).length - 1).toBe(1);
  });

  it("does not suppress on the copy of the OTHER language", () => {
    // A bilingual answer that carries the EN copy suppresses the EN rule text
    // too: the predicate is "the warning is present", not "the ID one is".
    const { applied } = applyProductRules(
      { text: `Answer.\n\n${dhaifWarning("en")}` },
      context([chunk({ sourceType: "hadith", grade: "dhaif" })]),
      "en",
    );
    expect(applied).not.toContain("dhaif_warning");
  });

  it("appends the warning for the live failing trace's shape (#278)", () => {
    // The shape of the readable failing case (staging trace
    // dfd9d801-c3bc-42b9-9e09-39a5df785c94, message
    // 92853ab6-5626-40cc-a098-a7d7463832b0, 2026-09-27): 28 assembled chunks,
    // 3 of them dhaif-graded, and a draft that reproduces the evidence labels
    // verbatim — including the "(Dhaif)" the assembler renders from the store
    // grade — plus the model's own note. The delivered answer carried no
    // canonical line.
    const { applied, draft } = applyProductRules(
      {
        text: [
          'Hadits dari Abu Hurairah: "Setiap sesuatu memiliki puncak…"',
          "**Catatan: hadits ini berlabel Dhaif** [HR. Tirmidhi no. 2878 (Dhaif)].",
          "Hadits lain: [HR. Tirmidhi no. 2884 (Sahih)].",
        ].join("\n\n"),
      },
      context([
        chunk({ sourceType: "hadith", grade: "sahih" }),
        chunk({ sourceType: "hadith", grade: "dhaif", citation: "HR. Tirmidhi no. 2878 (Dhaif)" }),
      ]),
      "id",
    );
    expect(applied).toContain("dhaif_warning");
    expect(draft.text).toContain(dhaifWarning("id"));
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

describe("hasWeakWarning — the one predicate the frame and the postprocess share", () => {
  it("is true only for the product's own warning copy", () => {
    expect(hasWeakWarning(dhaifWarning("id"))).toBe(true);
    expect(hasWeakWarning(dhaifWarning("en"))).toBe(true);
    expect(hasWeakWarning(`Jawaban.\n\n${dhaifWarning("en")}`)).toBe(true);
  });

  it("is false for every grade mention that is not the copy (#278)", () => {
    // These are the shapes the live path actually produced. Every one of them
    // is a reason an answer CONTAINS the token without carrying the warning.
    for (const text of [
      "[HR. Tirmidhi no. 2878 (Dhaif)]",
      "Catatan: hadits ini berlabel Dhaif.",
      "Hadits ini dhaif, jadi tidak dapat dijadikan dalil utama.",
      "The hadith is graded weak (dhaif).",
      "Riwayat ini berderajat lemah.",
      "",
    ]) {
      expect(hasWeakWarning(text), text).toBe(false);
    }
  });

  it("never matches a sound hadith's context (the rule cannot warn on sahih)", () => {
    // The other half of the invariant: the predicate only gates whether the
    // copy is duplicated. Warning on a sound answer still requires
    // `hasWeakGradeChunk` — pinned here so a future edit to either side cannot
    // make "sound" emit the warning.
    const { applied } = applyProductRules(
      { text: "Jawaban dengan [HR. Bukhari no. 5010 (Sahih)]." },
      context([chunk({ sourceType: "hadith", grade: "sahih" })]),
      "id",
    );
    expect(applied).not.toContain("dhaif_warning");
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
    expect(chatSystemPrompt("id")).toMatch(
      /Jangan pernah menyebut sitasi yang tidak tercetak di konteks/,
    );
    expect(chatSystemPrompt("en")).toMatch(
      /Never name a citation that is not printed in the context/,
    );
    // The memory-citation case that refused gs-v0-015: a well-known verse the
    // model knows but the retrieval did not return is still a fabricated cite.
    expect(chatSystemPrompt("id")).toMatch(/hafal dari luar konteks/);
    expect(chatSystemPrompt("en")).toMatch(/know from memory/);
  });
});
