import { describe, expect, it } from "vite-plus/test";
import type { AssembledContext, Chunk } from "@app/rag-core";
import { splitAnswerBlocks } from "../../../apps/web/src/lib/chat-peel";
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
import { routedQuery } from "./test-utils/routed-query";

/**
 * The deterministic product rules: the dhaif warning and the
 * machine-translation label are appended when the model omitted them and never
 * duplicated when it did not; the ulama disclaimer is the rule's own close,
 * written whatever the draft carried and removed only when a unit is wholly the
 * disclaimer; none is applied to a refusal.
 *
 * The disclaimer cases run the client's real peel (`splitAnswerBlocks`) as well
 * as reading the server text, because the guarantee is about the answer a user
 * reads: the rule's copy lands in the footer, and no paraphrase survives in the
 * body in place of it.
 */

const context = (
  chunks: readonly Chunk[],
  withTranslation = false,
): AssembledContext<KajianQFilters> => ({
  query: routedQuery("q"),
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
    const { applied, draft } = applyProductRules(
      { text: "Hadits ini dhaif, jadi tidak dapat dijadikan dalil utama." },
      context([chunk({ grade: "dhaif" })]),
      "id",
    );
    expect(applied).toContain("dhaif_warning");
    expect(draft.text).toContain(dhaifWarning("id"));
  });

  it("still appends the warning when the answer merely contains the substring 'lemah'", () => {
    // Suppression requires the product's warning copy, not a shared substring.
    const { applied, draft } = applyProductRules(
      { text: "Angin malam ini terasa lemah, tetapi jawabannya tetap ini." },
      context([chunk({ sourceType: "hadith", grade: "dhaif" })]),
      "id",
    );
    expect(applied).toContain("dhaif_warning");
    expect(draft.text).toContain(dhaifWarning("id"));
  });

  it("still appends the warning when the answer contains a word embedding 'lemah'", () => {
    const { applied } = applyProductRules(
      { text: "Kondisi itu dapat memalemahkan semangat." },
      context([chunk({ sourceType: "hadith", grade: "dhaif" })]),
      "id",
    );
    expect(applied).toContain("dhaif_warning");
  });

  it("appends the canonical warning over an informal 'lemah' weakness claim", () => {
    // Suppression anchors to the product-owned warning copy, not to a proximity
    // window around the ordinary word "lemah".
    const { applied, draft } = applyProductRules(
      { text: "Riwayat ini lemah, sehingga tidak bisa dijadikan dalil." },
      context([chunk({ sourceType: "hadith", grade: "dhaif" })]),
      "id",
    );
    expect(applied).toContain("dhaif_warning");
    expect(draft.text).toContain(dhaifWarning("id"));
  });

  it("appends the canonical warning over a restatement of the copy's grade phrase (#278)", () => {
    // The copy's grade phrases are part of the COPY, not independent triggers: a
    // sentence using them without the warning statement still gains the line.
    const { applied, draft } = applyProductRules(
      { text: "Hadits ini berderajat lemah, sehingga tidak dapat dijadikan dalil utama." },
      context([chunk({ sourceType: "hadith", grade: "dhaif" })]),
      "id",
    );
    expect(applied).toContain("dhaif_warning");
    expect(draft.text).toContain(dhaifWarning("id"));
  });

  it("does not duplicate the canonical warning the answer already carries", () => {
    // The rule's own copy present in the text is not appended a second time.
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

/**
 * The ulama disclaimer has one owner: the rule. Four draft shapes pin the
 * contract — a paraphrase, the canonical copy, both, and a different promise —
 * plus the prefixed shapes answers actually carried. Each asserts the same
 * invariant from a different starting point: exactly one canonical copy, as the
 * last paragraph, never a weaker paraphrase of it.
 */
describe("the ulama disclaimer — one canonical close, whatever the draft says", () => {
  const canonical = ulamaDisclaimer("id");
  const closesWithCanonical = (text: string) => text.endsWith(canonical);
  const occurrences = (text: string, copy: string) => text.split(copy).length - 1;

  it("replaces a paraphrase with the canonical copy", () => {
    // The model's own wording of the claim: the predicate this rule used to
    // consult accepted it and left the canonical line out, so the control never
    // fired.
    const paraphrase =
      "Jawaban ini bukan fatwa; untuk keputusan hukum, silakan merujuk kepada ulama.";
    const { draft, applied } = applyProductRules(
      { text: `Jawaban.\n\n${paraphrase}` },
      context([]),
      "id",
    );
    expect(draft.text).not.toContain("silakan merujuk kepada ulama");
    expect(occurrences(draft.text, canonical)).toBe(1);
    expect(closesWithCanonical(draft.text)).toBe(true);
    expect(applied).toContain("ulama_disclaimer");
    // The delivered answer: the body the reader sees, and the footer the card
    // draws from the rule's copy.
    const delivered = splitAnswerBlocks(draft.text);
    expect(delivered.body).toBe("Jawaban.");
    expect(delivered.disclaimer).toBe(canonical);
  });

  it("leaves a draft that already closes with the canonical copy untouched", () => {
    const original = `Jawaban.\n\n${canonical}`;
    const { draft, applied } = applyProductRules({ text: original }, context([]), "id");
    expect(draft.text).toBe(original);
    expect(occurrences(draft.text, canonical)).toBe(1);
    // The rule ran and changed nothing: the event records a change, and its
    // presence already says the rules ran.
    expect(applied).not.toContain("ulama_disclaimer");
    const delivered = splitAnswerBlocks(draft.text);
    expect(delivered.body).toBe("Jawaban.");
    expect(delivered.disclaimer).toBe(canonical);
  });

  it("collapses a draft carrying both copies to one canonical close", () => {
    const paraphrase =
      "Jawaban ini bukan fatwa; untuk keputusan hukum, silakan merujuk kepada ulama.";
    for (const text of [
      `Jawaban.\n\n${canonical}\n\n${paraphrase}`,
      `Jawaban.\n\n${paraphrase}\n\n${canonical}`,
    ]) {
      const { draft, applied } = applyProductRules({ text }, context([]), "id");
      expect(occurrences(draft.text, canonical), text).toBe(1);
      expect(draft.text).not.toContain("silakan merujuk kepada ulama");
      expect(closesWithCanonical(draft.text)).toBe(true);
      expect(applied).toContain("ulama_disclaimer");
      const delivered = splitAnswerBlocks(draft.text);
      expect(delivered.body, text).toBe("Jawaban.");
      expect(delivered.disclaimer, text).toBe(canonical);
    }
  });

  it("does not mistake a different promise for the disclaimer", () => {
    // A consult-ulama instruction is not the claim "this is not a fatwa": the
    // model's sentence stays, and the canonical copy still closes the answer.
    const other = "Pastikan konsultasi dengan ulama sebelum mengamalkan.";
    const { draft, applied } = applyProductRules(
      { text: `Jawaban.\n\n${other}` },
      context([]),
      "id",
    );
    expect(draft.text).toContain(other);
    expect(occurrences(draft.text, canonical)).toBe(1);
    expect(closesWithCanonical(draft.text)).toBe(true);
    expect(applied).toContain("ulama_disclaimer");
    const delivered = splitAnswerBlocks(draft.text);
    expect(delivered.body).toBe(`Jawaban.\n\n${other}`);
    expect(delivered.disclaimer).toBe(canonical);
  });

  it("removes a disclaimer the model placed mid-answer and closes with the canonical copy", () => {
    const { draft } = applyProductRules(
      { text: `Jawaban pertama.\n\n${canonical}\n\nPenutup lain.` },
      context([]),
      "id",
    );
    expect(draft.text).toBe(`Jawaban pertama.\n\nPenutup lain.\n\n${canonical}`);
  });

  it("normalises the prefixed shapes answers actually carried", () => {
    // The paraphrase carries the same claim under a rule marker or a label
    // prefix; the footer peel cannot see either, so the old predicate's
    // suppression left the reader with no disclaimer at all.
    for (const preface of ["[Peringatan] ", "Peringatan: ", "[Warning] "]) {
      const { draft } = applyProductRules(
        {
          text:
            `Jawaban.\n\n${preface}` +
            "Jawaban ini bukan fatwa; untuk keputusan hukum, silakan merujuk kepada ulama.",
        },
        context([]),
        "id",
      );
      expect(draft.text, preface).toBe(`Jawaban.\n\n${canonical}`);
      expect(splitAnswerBlocks(draft.text).body, preface).toBe("Jawaban.");
    }
  });

  it("clears the qualifier and emphasis variants of the claim", () => {
    // Each of these delivered the paraphrase in the body beside the canonical
    // close when the claim was a fixed list of adjacent words: a qualifier may
    // sit between the negation and `fatwa`, and emphasis may wrap the noun.
    const drafts = [
      ["id", `Jawaban.\n\nJawaban ini bukan suatu fatwa; rujuk ulama.`],
      ["id", `Jawaban.\n\nJawaban ini bukan **fatwa**; rujuk ulama.`],
      ["en", `Answer.\n\nThis is not a legal fatwa; ask a scholar.`],
      ["en", `Answer.\n\nThis is not meant to be a fatwa; ask a scholar.`],
    ] as const;
    for (const [locale, text] of drafts) {
      const body = text.split("\n\n")[0]!;
      const copy = ulamaDisclaimer(locale);
      const { draft } = applyProductRules({ text }, context([]), locale);
      expect(draft.text, text).toBe(`${body}\n\n${copy}`);
      const delivered = splitAnswerBlocks(draft.text);
      expect(delivered.body, text).toBe(body);
      expect(delivered.disclaimer, text).toBe(copy);
    }
  });

  it("keeps the sentence that follows a quoted disclaimer", () => {
    // The closing quote rides the sentence boundary: a boundary that stopped
    // inside it merged the next sentence into the removed unit and deleted it.
    const text = 'Jawaban. Menurut kaidah: "Jawaban ini bukan fatwa." Itu sebabnya wajib bertanya.';
    const { draft } = applyProductRules({ text }, context([]), "id");
    expect(draft.text).toBe(`${text}\n\n${canonical}`);
    expect(splitAnswerBlocks(draft.text).body).toBe(text);
  });

  it("closes a quoted disclaimer at its quotation mark, keeping the next sentence", () => {
    // A quoted claim is its own unit: the unit ends at the period AND the closing
    // quote. A boundary that stopped at the period left the quote outside, merged
    // `Penutup.` into the unit, and deleted both.
    const { draft } = applyProductRules(
      { text: 'Jawaban. "Jawaban ini bukan fatwa." Penutup.' },
      context([]),
      "id",
    );
    expect(draft.text).toBe(`Jawaban. Penutup.\n\n${canonical}`);
  });

  it("keeps a dhaif note whose own sentence carries the claim", () => {
    // The claim in another sense — asserting something about the hadith, with
    // the citation in the same unit. Deleting the unit would delete the note
    // and leave the citation alone.
    const note = "Peringatan: hadits ini bukan fatwa tetapi tetap hujah. [HR. Malik no. 18]";
    const { draft, applied } = applyProductRules(
      { text: `Jawaban.\n\n${note}` },
      context([chunk({ sourceType: "hadith", grade: "dhaif", citation: "HR. Malik no. 18" })]),
      "id",
    );
    expect(draft.text).toContain(note);
    expect(draft.text).toContain(dhaifWarning("id"));
    expect(applied).toContain("dhaif_warning");
    expect(splitAnswerBlocks(draft.text).body).toContain(note);
  });

  it("keeps a table row that carries the claim, header and rule included", () => {
    // A table row is not a disclaimer sentence: removing the row's unit used to
    // take the header and the rule line with it and leave a dangling pipe.
    const table = ["| No | Keterangan |", "| --- | --- |", "| 1 | Jawaban ini bukan fatwa. |"].join(
      "\n",
    );
    const { draft } = applyProductRules({ text: `Jawaban.\n\n${table}` }, context([]), "id");
    expect(draft.text).toBe(`Jawaban.\n\n${table}\n\n${canonical}`);
  });

  it("keeps a sentence that uses the claim in its contrastive sense", () => {
    // `bukan fatwa melainkan …` asserts what the hadith is, not what the answer
    // is: the claim's presence alone must not delete the sentence.
    const sentence = "Hadits ini bukan fatwa melainkan kabar yang wajib diyakini.";
    const { draft } = applyProductRules({ text: `Jawaban.\n\n${sentence}` }, context([]), "id");
    expect(draft.text).toBe(`Jawaban.\n\n${sentence}\n\n${canonical}`);
    expect(splitAnswerBlocks(draft.text).body).toContain(sentence);
  });

  it("keeps a dhaif note that shared the model's disclaimer paragraph", () => {
    // A disclaimer sentence beside another sentence loses only its own
    // sentence: the warning rule has its own trigger and must not be starved by
    // the disclaimer's removal.
    const note = "Peringatan: hadits ini dhaif.";
    const { draft, applied } = applyProductRules(
      {
        text:
          `Jawaban.\n\nPeringatan: jawaban ini bukan fatwa; ruklah ulama. ${note} ` +
          "[HR. Malik no. 18].",
      },
      context([chunk({ sourceType: "hadith", grade: "dhaif", citation: "HR. Malik no. 18" })]),
      "id",
    );
    expect(draft.text).toContain(note);
    expect(draft.text).toContain(dhaifWarning("id"));
    expect(applied).toContain("dhaif_warning");
  });

  it("keeps the sentence after a bold-wrapped disclaimer", () => {
    // The closing delimiter rides the sentence boundary; it must not merge the
    // next sentence into the removed unit.
    const { draft } = applyProductRules(
      { text: "Jawaban. **Jawaban ini bukan fatwa; ruklah ulama.** Penutup." },
      context([]),
      "id",
    );
    expect(draft.text).toContain("Penutup.");
    expect(draft.text).not.toContain("ruklah ulama.**");
    expect(occurrences(draft.text, canonical)).toBe(1);
  });

  it("takes the orphaned wrap of a removed disclaimer with it", () => {
    // A wrap that enclosed the disclaimer and its consult sentence loses its
    // opening with the removed claim; its closing run is a delimiter, not text.
    const { draft } = applyProductRules(
      {
        text:
          "Jawaban.\n\n*Peringatan: jawaban ini bukan fatwa. " +
          "Untuk keputusan hukum, silakan merujuk kepada ulama.*",
      },
      context([]),
      "id",
    );
    expect(draft.text).not.toContain("*");
    expect(draft.text).not.toContain("bukan fatwa. Untuk");
  });

  it("uses the EN copy for an EN paraphrase", () => {
    const canonicalEn = ulamaDisclaimer("en");
    const { draft } = applyProductRules(
      {
        text: "Answer.\n\nThis answer is not a fatwa; for legal rulings, please consult a scholar.",
      },
      context([]),
      "en",
    );
    expect(draft.text).toBe(`Answer.\n\n${canonicalEn}`);
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
    // Every shape contains the grade token without carrying the warning copy.
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
    // The other half of the invariant: warning on a sound answer still requires
    // `hasWeakGradeChunk`, so an edit to either side cannot make "sound" warn.
    const { applied } = applyProductRules(
      { text: "Jawaban dengan [HR. Bukhari no. 5010 (Sahih)]." },
      context([chunk({ sourceType: "hadith", grade: "sahih" })]),
      "id",
    );
    expect(applied).not.toContain("dhaif_warning");
  });
});

describe("chatSystemPrompt — the grounding rules the model receives", () => {
  it("states the grounding, citation, dhaif, Arabic, and language rules (id)", () => {
    const prompt = chatSystemPrompt("id");
    expect(prompt).toMatch(/HANYA dari konteks/);
    expect(prompt).toMatch(/sitasi/i);
    expect(prompt).toMatch(/dhaif/);
    expect(prompt).toMatch(/teks Arab/i);
    expect(prompt).toMatch(/bahasa yang sama dengan pertanyaan/);
    // The disclaimer is the rule's copy, not an instruction: asking the model
    // for it would buy a sentence the rule strips and rewrites.
    expect(prompt).not.toMatch(/bukan fatwa/i);
  });

  it("states the same rules in English", () => {
    const prompt = chatSystemPrompt("en");
    expect(prompt).toMatch(/ONLY from the provided context/);
    expect(prompt).toMatch(/citation/i);
    expect(prompt).toMatch(/dhaif/);
    expect(prompt).toMatch(/Arabic text/i);
    expect(prompt).toMatch(/same language as the user's question/);
    expect(prompt).not.toMatch(/not a fatwa/i);
  });

  it("forbids naming a citation that is not in the context (the fabrication rule)", () => {
    expect(chatSystemPrompt("id")).toMatch(
      /Jangan pernah menyebut sitasi yang tidak tercetak di konteks/,
    );
    expect(chatSystemPrompt("en")).toMatch(
      /Never name a citation that is not printed in the context/,
    );
    // A verse the model knows but the retrieval did not return is a fabricated cite.
    expect(chatSystemPrompt("id")).toMatch(/hafal dari luar konteks/);
    expect(chatSystemPrompt("en")).toMatch(/know from memory/);
  });
});
