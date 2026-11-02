import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import type { Chunk } from "@app/rag-core";
import { createKajianQAssembler } from "./chat-assembler";
import { chatSystemPrompt, chatUserPrompt } from "./chat-prompts";
import { routedQuery } from "./test-utils/routed-query";

/**
 * The answer-focus contract (ADR-0067): an answer quotes the primary matn once,
 * names parallel narrations of the same hadith compactly, and leads with the
 * primary evidence — without dropping any chain or grade the evidence rules
 * require.
 *
 * These are text-level assertions on the instruction, not a claim about model
 * behaviour: whether a model obeys the rule is measured on live answers, not by
 * a unit test. What they pin is that the instruction exists, is scoped to the
 * same hadith's parallels (a different hadith is still quoted in full), sits
 * after the chain rules, and states that it does not relax them — plus that the
 * assembled context still carries every parallel the answer must disclose.
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

function hadithChunk(id: string, citation: string, score: number): Chunk {
  return {
    id,
    text: MATN,
    metadata: {
      sourceType: "hadith",
      citation,
      grade: "sahih",
      textAr: MATN,
      textId: MATN_ID,
    },
    score,
  };
}

const PRIMARY = hadithChunk("hadith-bukhari-1", "HR. Bukhari no. 1", 0.9);
const PARALLEL = hadithChunk("hadith-muslim-1907", "HR. Muslim no. 1907", 0.5);

/** The evidence turn the generator receives for these parallel narrations. */
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
    "requires the full matn once and compact parallel naming (%s)",
    (language) => {
      const rule = ruleOf(language, FOCUS_RULE)!;
      if (language === "id") {
        // The single full quotation is the compression: one matn, once.
        expect(rule).toMatch(/cukup SEKALI, pada riwayat primer\/terkuat/);
        // A parallel is named by address and grade, not re-quoted.
        expect(rule).toMatch(
          /sebutkan kitab \+ nomor \+ derajat \(beserta penilainya\) secara ringkas/,
        );
        expect(rule).toMatch(/JANGAN mengulang matn Arab lengkap dan isnad untuk setiap paralel/);
      } else {
        expect(rule).toMatch(/only ONCE, for the primary\/strongest narration/);
        expect(rule).toMatch(/name the collection \+ number \+ grade \(and its grader\) compactly/);
        expect(rule).toMatch(/do NOT repeat the full Arabic matn and isnad for every parallel/);
      }
    },
  );

  it("scopes the compression to parallel narrations of the SAME hadith", () => {
    // A different hadith is different evidence: its matn is still quoted. The
    // rule is not "quote one passage per answer".
    expect(ruleOf("id", FOCUS_RULE)).toMatch(/riwayat paralel dari hadits yang sama/);
    expect(ruleOf("en", FOCUS_RULE)).toMatch(/parallel narrations of the same hadith/);
    // Rule 4's Arabic-for-every-quotation duty still applies to what is quoted.
    expect(ruleOf("id", 4)).toMatch(/Tampilkan teks Arab untuk setiap ayat\/hadits yang dikutip/);
    expect(ruleOf("en", 4)).toMatch(/Show the Arabic text for every quoted ayah\/hadith/);
  });

  it.each([["id"], ["en"]] as const)(
    "is an answer shape, not permission to omit chains (%s)",
    (language) => {
      const rule = ruleOf(language, FOCUS_RULE)!;
      if (language === "id") {
        expect(rule).toMatch(/mengatur bentuk jawaban, bukan kelengkapan bukti/);
        expect(rule).toMatch(
          /semua sanad dan derajat yang wajib menurut aturan 3, 8, dan 9 tetap disebut/,
        );
        expect(rule).toMatch(/takhrij tetap diberikan/);
        expect(rule).toMatch(/derajat tidak pernah dinaikkan/);
      } else {
        expect(rule).toMatch(/governs the answer's shape, not the evidence's completeness/);
        expect(rule).toMatch(/every chain and grade rules 3, 8 and 9 require is still named/);
        expect(rule).toMatch(/the takhrij is still given/);
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

describe("the assembled prompt with parallel narrations", () => {
  it("leads with the primary evidence and keeps every parallel in context", () => {
    const context = assembleEvidence([PARALLEL, PRIMARY]);
    // The primary/strongest narration is presented first...
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
    // The prompt states the single full quotation and the compact naming, so the
    // answer shape is derivable from the prompt alone.
    expect(prompt).toMatch(/cukup SEKALI/);
    expect(prompt).toMatch(/JANGAN mengulang matn Arab lengkap dan isnad/);
  });
});
