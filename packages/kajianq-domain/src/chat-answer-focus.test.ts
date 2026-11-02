import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import type { Chunk } from "@app/rag-core";
import { createKajianQAssembler } from "./chat-assembler";
import { chatSystemPrompt, chatUserPrompt } from "./chat-prompts";
import { routedQuery } from "./test-utils/routed-query";

/**
 * The answer-focus contract (ADR-0067): an answer quotes the primary matn once,
 * quotes a different hadith in full, and names parallel narrations of the same
 * hadith compactly — without dropping any chain or grade the evidence rules
 * require. The prompt asks the answer to lead with the primary/strongest
 * evidence; whether a model does so is measured on live answers.
 *
 * These are text-level assertions on the instruction, not a claim about model
 * behaviour: whether a model obeys the rule is measured on live answers, not by
 * a unit test. What they pin is that the instruction exists, scopes the single
 * quotation to parallels of the same hadith while keeping each different hadith
 * fully quoted, sits after the chain rules, and states that it does not relax
 * them — plus that the assembled context still carries every parallel and every
 * matn the answer must disclose, and that assembly orders a slot by
 * retrieval/rerank score rather than by grade.
 */

type Language = "id" | "en";

/** One numbered rule of the system prompt. */
const ruleOf = (language: Language, number: number): string | undefined =>
  chatSystemPrompt(language)
    .split("\n")
    .find((line) => line.startsWith(`${number}.`));

const FOCUS_RULE = 10;

/** The intention hadith, as the assembler renders one evidence chunk. */
const MATN = "إنما الأعمال بالنيات";
const MATN_ID = "Sesungguhnya amal bergantung pada niat.";
/** A genuinely different hadith — not another route of the intention report. */
const SECOND_MATN = "الدين النصيحة";
const SECOND_MATN_ID = "Agama adalah nasihat.";

function hadithChunk(
  id: string,
  citation: string,
  score: number,
  matn = MATN,
  translation = MATN_ID,
): Chunk {
  return {
    id,
    text: matn,
    metadata: {
      sourceType: "hadith",
      citation,
      grade: "sahih",
      textAr: matn,
      textId: translation,
    },
    score,
  };
}

/** Two routes of ONE report: the intention hadith in Bukhari and in Muslim. */
const PRIMARY = hadithChunk("hadith-bukhari-1", "HR. Bukhari no. 1", 0.9);
const PARALLEL = hadithChunk("hadith-muslim-1907", "HR. Muslim no. 1907", 0.5);
/** A second, different hadith the same answer may have to quote. */
const SECOND = hadithChunk(
  "hadith-muslim-55",
  "HR. Muslim no. 55",
  0.7,
  SECOND_MATN,
  SECOND_MATN_ID,
);

/** The evidence turn the generator receives for these chunks. */
function assembleEvidence(chunks: readonly Chunk[]): string {
  const stage = createKajianQAssembler();
  const routed = routedQuery("Hadits apa tentang niat?");
  const assembled = Effect.runSync(stage.assemble(routed, chunks) as never) as {
    turns: readonly { role: string; content: string }[];
  };
  return assembled.turns.at(-1)?.content ?? "";
}

describe("the answer-focus rule", () => {
  it.each([["id"], ["en"]] as const)(
    "answers the question directly and puts the primary evidence first (%s)",
    (language) => {
      const rule = ruleOf(language, FOCUS_RULE);
      expect(rule).toBeDefined();
      if (language === "id") {
        expect(rule).toMatch(/jawab pertanyaan pengguna secara langsung lebih dahulu/);
        expect(rule).toMatch(/bukti primer\/terkuat di depan, mendahului paralelnya/);
      } else {
        expect(rule).toMatch(/answer the user's question directly first/);
        expect(rule).toMatch(/lead with the primary\/strongest evidence ahead of its parallels/);
      }
    },
  );

  it.each([["id"], ["en"]] as const)(
    "requires the full matn once per hadith and compact same-hadith naming (%s)",
    (language) => {
      const rule = ruleOf(language, FOCUS_RULE)!;
      if (language === "id") {
        // The single full quotation is the compression, and it stops at the same
        // hadith: a different hadith is quoted in full beside it.
        expect(rule).toMatch(
          /sekali pada riwayat primer\/terkuat, dan secara lengkap untuk setiap hadits yang berbeda/,
        );
        // A parallel is named by address and grade, not re-quoted.
        expect(rule).toMatch(
          /sebutkan kitab \+ nomor \+ derajat \(beserta penilainya\) secara ringkas/,
        );
        expect(rule).toMatch(/JANGAN mengulang matn Arab lengkap dan isnad untuk setiap paralel/);
      } else {
        expect(rule).toMatch(
          /once for the primary\/strongest narration, and in full for every different hadith/,
        );
        expect(rule).toMatch(/name the collection \+ number \+ grade \(and its grader\) compactly/);
        expect(rule).toMatch(/do NOT repeat the full Arabic matn and isnad for every parallel/);
      }
    },
  );

  it("scopes the compression to parallel narrations of the SAME hadith", () => {
    // The fixture above is one report — Bukhari no. 1 and Muslim no. 1907 are
    // two routes of the intention hadith — so the compact naming applies to it.
    // That a different hadith keeps its full matn is asserted by the
    // multi-hadith case below, whose second chunk is a distinct report.
    expect(ruleOf("id", FOCUS_RULE)).toMatch(
      /pemadatan satu kutipan hanya berlaku untuk riwayat paralel dari hadits yang SAMA, tidak pernah lintas hadits/,
    );
    expect(ruleOf("en", FOCUS_RULE)).toMatch(
      /the once-only compression applies to parallel narrations of the SAME hadith, never across different hadiths/,
    );
  });

  it.each([["id"], ["en"]] as const)(
    "is an answer shape, not permission to omit chains (%s)",
    (language) => {
      const rule = ruleOf(language, FOCUS_RULE)!;
      if (language === "id") {
        expect(rule).toMatch(/mengatur bentuk jawaban, bukan kelengkapan bukti/);
        // Rule 4 is in the preservation list, so "once" cannot drop a different
        // hadith's Arabic: it still accompanies every quoted hadith.
        expect(rule).toMatch(
          /teks Arab dan terjemahan menurut aturan 4 tetap menyertai setiap hadits yang dikutip/,
        );
        expect(rule).toMatch(
          /semua sanad dan derajat yang wajib menurut aturan 3 dan 8 tetap disebut/,
        );
        expect(rule).toMatch(/takhrij menurut aturan 9 tetap diberikan/);
        expect(rule).toMatch(/derajat tidak pernah dinaikkan/);
      } else {
        expect(rule).toMatch(/governs the answer's shape, not the evidence's completeness/);
        expect(rule).toMatch(
          /rule 4's Arabic and translation still accompany every hadith the answer quotes/,
        );
        expect(rule).toMatch(/every chain and grade rules 3 and 8 require is still named/);
        expect(rule).toMatch(/the takhrij rule 9 requires is still given/);
        expect(rule).toMatch(/no grade is ever raised/);
      }
    },
  );

  it.each([["id"], ["en"]] as const)(
    "sits after the chain rules so it reads as presentation (%s)",
    (language) => {
      const prompt = chatSystemPrompt(language);
      const focus = prompt.indexOf(`\n${FOCUS_RULE}.`);
      expect(focus).toBeGreaterThan(prompt.indexOf("\n8."));
      expect(focus).toBeGreaterThan(prompt.indexOf("\n9."));
      // The rules the focus rule subordinates itself to are still present, whole.
      expect(ruleOf(language, 8)).toMatch(/SEMUA|ALL/);
      expect(ruleOf(language, 9)).toMatch(/takhrij/);
      expect(ruleOf(language, 3)).toMatch(/dhaif/);
    },
  );
});

/**
 * A different hadith is different evidence (ADR-0067 decision 2): the once-only
 * compression is scoped to parallels of the SAME hadith, so an answer covering
 * two hadiths quotes both matns in full. The fixture pairs the intention hadith
 * with "religion is sincere counsel" — two distinct reports, not two routes of
 * one — so both the assembled context and the instruction are load-bearing.
 */
describe("a multi-hadith answer", () => {
  it("keeps both distinct hadiths fully quoted, matn and translation", () => {
    const context = assembleEvidence([SECOND, PARALLEL, PRIMARY]);
    // Both hadiths reach the generator complete. If the rule were read as one
    // matn per answer, this is the second matn it would license dropping.
    expect(context).toContain(MATN);
    expect(context).toContain(MATN_ID);
    expect(context).toContain(SECOND_MATN);
    expect(context).toContain(SECOND_MATN_ID);
    // The instruction requires both in full, and rule 4 — which the preservation
    // list names — still requires the Arabic of every quoted hadith, so "in
    // full" is not limited to the primary narration.
    expect(ruleOf("id", FOCUS_RULE)).toMatch(/secara lengkap untuk setiap hadits yang berbeda/);
    expect(ruleOf("en", FOCUS_RULE)).toMatch(/in full for every different hadith/);
    expect(ruleOf("id", 4)).toMatch(/Tampilkan teks Arab untuk setiap ayat\/hadits yang dikutip/);
    expect(ruleOf("en", 4)).toMatch(/Show the Arabic text for every quoted ayah\/hadith/);
  });
});

describe("the assembled prompt with parallel narrations", () => {
  it("orders the higher-scored narration first and keeps every parallel in context", () => {
    const context = assembleEvidence([PARALLEL, PRIMARY]);
    // A presentation slot is ordered by retrieval/rerank score — the assembler's
    // `orderScore` is `rerankScore ?? score ?? 0` — so the higher-scored
    // narration leads. This pins assembly order, not grade-based primacy: a
    // per-matn identity that could order by grade is ADR-0067's revisit
    // condition.
    expect(context.indexOf("HR. Bukhari no. 1")).toBeGreaterThan(-1);
    expect(context.indexOf("HR. Bukhari no. 1")).toBeLessThan(
      context.indexOf("HR. Muslim no. 1907"),
    );
    // ...and no parallel is dropped: every address and grade the answer must
    // disclose reaches the prompt (rules 8–9 still have their evidence).
    expect(context).toContain("[HR. Bukhari no. 1 (sahih)]");
    expect(context).toContain("[HR. Muslim no. 1907 (sahih)]");
    // The context keeps each parallel's full matn, so the focus rule compresses
    // the ANSWER's repetition, never the evidence the model (and reviewer) see.
    expect(context.split(MATN)).toHaveLength(3);
  });

  it("carries the focus instruction and every parallel into the generator's turn", () => {
    const context = assembleEvidence([PARALLEL, PRIMARY]);
    const prompt = [
      chatSystemPrompt("id"),
      chatUserPrompt("Hadits apa tentang niat?", context),
    ].join("\n");
    // The instruction the model reads, and the completeness it must preserve.
    expect(prompt).toMatch(/Fokus jawaban/);
    expect(prompt).toContain("HR. Bukhari no. 1");
    expect(prompt).toContain("HR. Muslim no. 1907");
    expect(prompt).toContain("sahih");
    // The prompt states the single full quotation, its same-hadith scope, and
    // the compact naming, so the answer shape is derivable from the prompt alone.
    expect(prompt).toMatch(/sekali pada riwayat primer\/terkuat/);
    expect(prompt).toMatch(/untuk setiap hadits yang berbeda/);
    expect(prompt).toMatch(/JANGAN mengulang matn Arab lengkap dan isnad/);
  });
});
