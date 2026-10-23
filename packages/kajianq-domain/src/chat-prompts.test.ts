import { describe, expect, it } from "vite-plus/test";
import type { Chunk } from "@app/rag-core";
import {
  ADDRESSED_EVIDENCE_PROMPT,
  ADDRESSED_REREAD_PURPOSE,
  addressedReread,
  chatSystemPrompt,
  chatUserPrompt,
} from "./chat-prompts";
import { DEFAULT_REFUSALS } from "./chat-reviewer";

/**
 * The refusal contract between the generator and the detector.
 *
 * The refusal detector (and therefore the eval harness's refusal marker check)
 * decides "did the model refuse?" by looking for the canonical refusal string on
 * the answer. A model that refuses in its own words — "tidak ada satu pun hadits
 * yang disebutkan dalam konteks…" — is scored as having ANSWERED, which is how the
 * fabricated-attribution trap failed its first live run even though the stored
 * answer refused correctly.
 *
 * `chat-prompts` therefore interpolates the very constant the detector matches
 * (`DEFAULT_REFUSALS`) instead of restating it, and the rule is an exact-output
 * instruction rather than advice. These tests pin both halves.
 */
describe("the canonical refusal contract", () => {
  it("tells the generator to emit the exact sentence the detector matches, per language", () => {
    expect(chatSystemPrompt("id")).toContain(`"${DEFAULT_REFUSALS.id}"`);
    expect(chatSystemPrompt("en")).toContain(`"${DEFAULT_REFUSALS.en}"`);
    // The wording that makes it a contract rather than a suggestion.
    expect(chatSystemPrompt("id")).toMatch(/PERSIS/);
    expect(chatSystemPrompt("en")).toMatch(/EXACTLY/);
  });

  it("no longer leaves the insufficiency rule as free-form advice", () => {
    // The regression itself: the old rule said "say plainly that you could not
    // find adequate evidence", which the generator paraphrased.
    expect(chatSystemPrompt("id")).not.toMatch(/katakan terus terang/);
    expect(chatSystemPrompt("en")).not.toMatch(/say plainly/);
  });
});

/**
 * The grounding discipline is stronger than "answer only from context".
 *
 * Live staging (gs-v0-001): asked for the meaning of Ayat al-Kursi, the
 * generator glossed "Kursi = (ilmu dan kekuasaan-Nya)" from memory. The
 * reviewer correctly failed it — the gloss is absent from the retrieved
 * evidence — and the answer became a refusal. Rule 1 alone did not stop it,
 * so the ban on out-of-context interpretation is now explicit: a recognised
 * classical opinion the evidence does not carry is still an ungrounded claim,
 * and the trace cannot show where it came from.
 */
describe("the no-gloss rule", () => {
  it("forbids interpretations and glosses the context does not contain", () => {
    expect(chatSystemPrompt("id")).toMatch(/tafsir|takwil/);
    expect(chatSystemPrompt("en")).toMatch(/tafsir|interpretation/);
    expect(chatSystemPrompt("id")).toMatch(/glosarium/);
    expect(chatSystemPrompt("en")).toMatch(/glosses/);
  });

  it("forbids asserting links between evidence items the context does not state", () => {
    // Live smoke gs-v0-015: the reviewer failed a draft for claiming
    // "HR. Malik no. 185 corresponds to QS. 15:87" — a relationship neither
    // block states. An inferred link is an interpretation like any other.
    expect(chatSystemPrompt("id")).toMatch(/hubungan antar-bukti/);
    expect(chatSystemPrompt("en")).toMatch(/relationships between evidence items/);
  });
});

/**
 * A refusal must be the canonical sentence, not a grounded lecture.
 *
 * Live staging (gs-v0-019, "Kapan kiamat akan terjadi? Sebutkan tahun
 * pastinya!"): with the grounding rules tightened, the generator produced a
 * well-cited answer explaining that no year is known. The reviewer passed it
 * — correctly, it was grounded — so no `refusal` event was recorded and the
 * refusal case failed. A separate rule saying the same thing was ignored;
 * the model kept explaining the gap. The condition now lives INSIDE rule 1,
 * where the canonical refusal is specified, and it closes the "the context
 * says the fact is unknown" loophole explicitly.
 */
describe("the specific-fact refusal rule", () => {
  it("makes an absent specific item count as a missing answer, per language", () => {
    expect(chatSystemPrompt("id")).toMatch(/ayat, hadits, angka, tahun, atau nama tertentu/);
    expect(chatSystemPrompt("en")).toMatch(/a particular verse, hadith, number, year, or name/);
    // The loophole that gs-v0-019 exploited: the context says "no one knows".
    expect(chatSystemPrompt("id")).toMatch(/hanya menyatakan bahwa hal itu tidak diketahui/);
    expect(chatSystemPrompt("en")).toMatch(/only says that it is unknown/);
    // And it must still route to the exact sentence the detector matches.
    expect(chatSystemPrompt("id")).toContain(`"${DEFAULT_REFUSALS.id}"`);
    expect(chatSystemPrompt("en")).toContain(`"${DEFAULT_REFUSALS.en}"`);
  });

  it("guards the answer cases: present-subject questions must be answered", () => {
    // Without this guard the refusal condition swallowed gs-v0-015 ("what does
    // Surah Al-Fatihah mean…"), which is answerable from its evidence.
    expect(chatSystemPrompt("id")).toMatch(/WAJIB dijawab dari konteks/);
    expect(chatSystemPrompt("en")).toMatch(/MUST be answered from the context/);
  });
});

/**
 * **The authority order** (spec §2.2, per _kaidah usul_): Quran → Hadith
 * (mutawatir > sahih > hasan; dhaif flagged) → Tafsir → Kitab.
 *
 * It is enforced by the *system prompt*, while the *presentation* order
 * (Principles → Quran → Hadith → Kitab → concept links) is how the assembler
 * lays out the turn. The two orderings are deliberately distinct, and the
 * silent failure this suite guards against is their conflation: a prompt that
 * carried the presentation order would tell the model the lens *governs* the
 * evidence rather than framing it — a claim about authority the product does
 * not make — and the assembler's ordering would then look like a legal
 * ranking. So this asserts the authority sequence is present, in order, in
 * both languages, AND that the presentation order is not restated here as
 * authority.
 */
describe("the usul authority order", () => {
  // Each language names the sources in its own copy (the Indonesian text says
  // "Hadits", as the product's Indonesian copy does everywhere else).
  it.each([
    ["id", ["Quran", "Hadits", "Tafsir", "Kitab"]],
    ["en", ["Quran", "Hadith", "Tafsir", "Kitab"]],
  ] as const)("states the authority order in order (%s)", (language, sources) => {
    const rule = chatSystemPrompt(language)
      .split("\n")
      .find((line) => line.startsWith("7."));
    expect(rule).toBeDefined();
    // Every source of the authority order is named, and named in that order —
    // the sequence is the content, so its absence is the defect.
    const positions = sources.map((source) => rule!.indexOf(source));
    for (const position of positions) expect(position).toBeGreaterThan(-1);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it.each([["id"], ["en"]] as const)("carries the hadith grade precedence (%s)", (language) => {
    // mutawatir > sahih > hasan, with dhaif flagged: the grade order is part of
    // the authority rule, not a separate hint.
    const rule = chatSystemPrompt(language)
      .split("\n")
      .find((line) => line.startsWith("7."))!;
    const grades = ["mutawatir", "sahih", "hasan"].map((grade) => rule.indexOf(grade));
    for (const grade of grades) expect(grade).toBeGreaterThan(-1);
    expect(grades).toEqual([...grades].sort((a, b) => a - b));
    expect(rule).toMatch(/dhaif/i);
  });

  it("scopes the rule to the context so it cannot license outside knowledge", () => {
    // The authority order must never become a second source of evidence: rule 2
    // forbids any citation the context does not print, and rule 7 may only order
    // what is already there.
    expect(chatSystemPrompt("id")).toMatch(/Bila konteks memuat lebih dari satu jenis sumber/);
    expect(chatSystemPrompt("en")).toMatch(/When the context carries more than one kind of source/);
  });

  it("keeps the lens out of the authority order — the two orderings are distinct", () => {
    // The presentation order's first slot must NOT be the prompt's first
    // authority, and the prompt must not present the lens as governing
    // evidence; it frames the reading of it.
    expect(chatSystemPrompt("id")).toMatch(/bukan dalil yang berdiri sendiri/);
    expect(chatSystemPrompt("en")).toMatch(/not evidence standing on their own/);
  });
});

/**
 * The evidence-present rule: a question is answered when the context carries
 * the fact it asks about — even where the question's own term or name for it
 * is not printed in the context — and a request for a comparison or "the most
 * excellent" is answered from what the context states about the things
 * compared. Without it the refusal condition could swallow such a question:
 * rule 1 listed an absent "name" among the things that make an answer missing,
 * and rule 6's ban on added interpretation left no stated permission to reuse
 * the question's own term for a passage the context contains. The duty lives
 * INSIDE rule 1, beside the refusal it qualifies, because a separate rule was
 * ignored (see the specific-fact block above).
 */
describe("the evidence-present answer rule", () => {
  /** Rule 1's line — the refusal and the duty that qualifies it share it. */
  const ruleOne = (language: "id" | "en"): string =>
    chatSystemPrompt(language)
      .split("\n")
      .find((line) => line.startsWith("1."))!;

  it("answers from the context under the question's own term, per language", () => {
    // The licence is scoped to evidence that describes the asked thing under
    // another name — ADR-0015's condition, not a general "the term is absent,
    // so answer anyway".
    expect(ruleOne("id")).toMatch(
      /Bila konteks memuat jawaban atas hal yang ditanyakan, sekalipun konteks menyebut hal itu dengan nama lain/,
    );
    expect(ruleOne("en")).toMatch(
      /When the context contains the answer to the thing the question asks about, even where the context describes that thing under another name/,
    );
    // Using the question's own term is not itself grounds for refusal.
    expect(ruleOne("id")).toMatch(
      /memakai istilah pertanyaan bukan menambah tafsir dan bukan alasan menolak/,
    );
    expect(ruleOne("en")).toMatch(
      /using the question's own term is not adding interpretation and is not a reason to refuse/,
    );
  });

  it("answers a comparison from what the context states, without inventing a ranking", () => {
    expect(ruleOne("id")).toMatch(/meminta perbandingan atau mana yang paling utama/);
    expect(ruleOne("en")).toMatch(/asks for a comparison or which option is most excellent/);
    // The negative half is the product's boundary: the ranking is the evidence's
    // to state, never the model's to supply.
    expect(ruleOne("id")).toMatch(/jangan menetapkan peringkat yang tidak dinyatakan konteks/);
    expect(ruleOne("en")).toMatch(/do not set out a ranking the context does not state/);
  });

  it("leaves the absent-fact refusal and the no-gloss ban intact", () => {
    // The permission must not read as "answer anything topical": the same rule
    // still routes a demanded-but-absent fact to the exact sentence, and rule 6
    // still forbids interpretation the context does not carry.
    expect(ruleOne("id")).toContain(`"${DEFAULT_REFUSALS.id}"`);
    expect(ruleOne("en")).toContain(`"${DEFAULT_REFUSALS.en}"`);
    expect(ruleOne("id")).toMatch(/tidak ada di konteks/);
    expect(ruleOne("en")).toMatch(/is absent from the context/);
    expect(chatSystemPrompt("id")).toMatch(/Jangan menambahkan tafsir/);
    expect(chatSystemPrompt("en")).toMatch(/Do not add tafsir/);
  });
});

/**
 * The addressed-evidence line a second reading carries (ADR-0055): the question
 * names a citation address the assembled context carries, so the reading is
 * pointed at that passage and ordered to answer from what it says. The
 * canonical insufficiency sentence stays the answer for whatever the context
 * does not state, so the reread can still decline and never explains the gap.
 */
describe("the addressed-evidence reread instruction", () => {
  const question = "Jelaskan perbedaan niat dan ikhlas berdasarkan QS. 98:5!";
  const evidence = "QS. 98:5 — wahyu";

  it("names the carried passage and keeps the canonical refusal for what the context does not state", () => {
    const prompt = chatUserPrompt(question, evidence, {
      language: "id",
      addressed: ["QS. 98:5"],
    });
    expect(prompt).toContain("QS. 98:5");
    // The sentence survives: it still applies where the context does not state
    // the asked thing, so a reread pointed at the evidence can still decline.
    expect(prompt).toContain(`"${DEFAULT_REFUSALS.id}" tetap berlaku`);
    expect(prompt).toMatch(/bila konteks tidak menyatakan hal yang ditanyakan/);
    // The instruction points the reading at the passage, orders no gap
    // explanation, and conditions the sentence on the context, not the question.
    expect(prompt).toMatch(/Bila bagian itu menjawab hal yang ditanyakan/);
    expect(prompt).toMatch(/jangan menyatakan apa yang tidak dinyatakan bagian itu/);
    expect(prompt).not.toMatch(/tidak berlaku untuk pertanyaan ini/);
    expect(prompt).not.toMatch(/nyatakan itu terus terang/);
    // The question and the assembled context stay in the same turn.
    expect(prompt).toContain(`Pertanyaan / Question: ${question}`);
    expect(prompt).toContain(`Konteks / Context:\n${evidence}`);
  });

  it("uses the answer language's copy with the same context condition", () => {
    const prompt = chatUserPrompt(question, evidence, {
      language: "en",
      addressed: ["QS. 98:5"],
    });
    expect(prompt).toContain(`"${DEFAULT_REFUSALS.en}" sentence still applies`);
    expect(prompt).toMatch(/where the context does not state the thing asked/);
    expect(prompt).toMatch(/do not state what the passage does not say/);
    expect(prompt).not.toMatch(/does not apply to this question/);
  });

  it("is absent when the question named no carried evidence — every trap shape", () => {
    // The plain user turn is byte-identical to the pre-existing form: a trap
    // question and a missing label carry no instruction and no new licence.
    expect(chatUserPrompt(question, evidence)).toBe(
      `Pertanyaan / Question: ${question}\n\nKonteks / Context:\n${evidence}`,
    );
    expect(chatUserPrompt(question, evidence, { addressed: [] })).toBe(
      chatUserPrompt(question, evidence),
    );
    expect(chatUserPrompt(question, evidence)).not.toContain(DEFAULT_REFUSALS.id);
  });

  it("keeps the instruction per language, both pinned by the exported owner", () => {
    expect(ADDRESSED_EVIDENCE_PROMPT.id("QS. 98:5")).toContain(DEFAULT_REFUSALS.id);
    expect(ADDRESSED_EVIDENCE_PROMPT.en("QS. 98:5")).toContain(DEFAULT_REFUSALS.en);
    expect(ADDRESSED_EVIDENCE_PROMPT.id("QS. 98:5")).toMatch(/tetap berlaku/);
    expect(ADDRESSED_EVIDENCE_PROMPT.en("QS. 98:5")).toMatch(/still applies/);
  });
});

/**
 * The directed reread decision (ADR-0055): one helper owns the
 * trigger, the prompt and the trace purpose, so the generator cannot send a
 * directed prompt under the plain reading's label. `null` is the plain reread:
 * the question names no address, or names one the assembled context does not
 * carry.
 */
describe("the directed reread decision", () => {
  const verse: Chunk = {
    id: "c-qs-98-5",
    text: "QS. 98:5 — wahyu",
    metadata: { citation: "QS. 98:5", sourceType: "quran", surah: 98, ayah: 5 },
  };

  it("returns the directed turns, purpose and labels for a carried address", () => {
    const reread = addressedReread({
      question: "Apa makna QS. 98:5?",
      context: verse.text,
      chunks: [verse],
      language: "id",
    });
    expect(reread?.purpose).toBe(ADDRESSED_REREAD_PURPOSE);
    expect(reread?.addressed).toEqual(["QS. 98:5"]);
    expect(reread?.turns.at(-1)?.content).toContain(`"${DEFAULT_REFUSALS.id}" tetap berlaku`);
  });

  it("returns null for the trap shape and for an address the context does not carry", () => {
    const noAddress = addressedReread({
      question: "Kapan kiamat akan terjadi? Sebutkan tahun pastinya!",
      context: verse.text,
      chunks: [verse],
      language: "id",
    });
    const absentAddress = addressedReread({
      question: "Apa makna QS. 2:255?",
      context: verse.text,
      chunks: [verse],
      language: "id",
    });
    expect(noAddress).toBeNull();
    expect(absentAddress).toBeNull();
  });
});
