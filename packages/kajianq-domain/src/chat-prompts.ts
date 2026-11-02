/**
 * Chat prompt templates (ID/EN) — KajianQ's grounding discipline for the
 * generator stage (spec §3.3 step 6). The templates never name a model or
 * vendor; they encode the product rules: answer only from context, cite,
 * flag weak grades, add no interpretation the context lacks, and refuse when a
 * demanded fact is absent rather than explaining the gap. The disclaimer is not
 * an instruction: the Product rules own that copy, so asking the model for it
 * would only buy a sentence the rule strips and rewrites.
 */

import type { Chunk } from "@app/rag-core";
import { addressedEvidenceIn } from "./chat-citation-reference";
import { DEFAULT_REFUSALS } from "./chat-refusal";

export type ChatLanguage = "id" | "en";

/**
 * The canonical refusal sentences live in `chat-refusal` (with `refusalTextFor`,
 * the resolver the detector and the harness use). They are imported here so the
 * generator can be told to emit them **verbatim** — the refusal detector matches
 * those exact strings, so a well-meant paraphrase ("tidak ada hadits yang
 * disebutkan dalam konteks…") is indistinguishable from an answer and scores as
 * one. One source of truth: the instruction and the detector cannot drift.
 *
 * No runtime cycle: the refusal module's only reference back to this one is a
 * type-only `ChatLanguage` import, which is erased.
 */

/**
 * The system prompt for the generator. Parameterized by language; the
 * grounding, citation, grade-flag, and formatting rules are identical in
 * both.
 *
 * Rule 7 is the **authority order** (spec §2.2, per _kaidah usul_): Quran →
 * Hadith (mutawatir > sahih > hasan; dhaif flagged) → Tafsir → Kitab. It is
 * deliberately NOT the order the context is laid out in — the assembler
 * presents the Principle lens first, then the evidence by source — and the two
 * orderings must not be conflated: the lens is *how* the evidence is read, the
 * authority order is *which* evidence governs when the sources disagree. The
 * rule is scoped to what the context contains ("when the context carries more
 * than one source") so it can never license reaching outside the grounding
 * rule above it.
 *
 * Rule 10 is the **answer shape**, placed after the evidence rules so it
 * compresses presentation without licensing an omission: the single quotation
 * covers only a parallel of the same hadith, a different hadith is still quoted
 * in full, rule 4 still requires the Arabic and translation of every quotation,
 * rules 3 and 8 still require every chain and its own grade, rule 9 still
 * requires the takhrij, and the assembled context still carries every parallel.
 * It changes how much of the same evidence the answer repeats, never which
 * evidence it discloses.
 */
export function chatSystemPrompt(language: ChatLanguage): string {
  if (language === "id") {
    return [
      "Anda adalah KajianQ, asisten tanya-jawab ilmu Islam klasik.",
      "ATURAN KETAT:",
      `1. Jawab HANYA dari konteks yang diberikan. Balas PERSIS kalimat ini dan tanpa tambahan apa pun bila konteks tidak memuat jawaban: "${DEFAULT_REFUSALS.id}". Konteks tidak memuat jawaban bila hal spesifik yang ditanyakan (ayat, hadits, angka, tahun, atau nama tertentu) tidak ada di konteks — termasuk bila konteks hanya menyatakan bahwa hal itu tidak diketahui. Sebaliknya, pertanyaan yang meminta makna, penjelasan, dalil, atau hukum atas sesuatu yang ADA di konteks WAJIB dijawab dari konteks. Bila konteks memuat jawaban atas hal yang ditanyakan, sekalipun konteks menyebut hal itu dengan nama lain, jawablah dari konteks itu: memakai istilah pertanyaan bukan menambah tafsir dan bukan alasan menolak. Bila pertanyaan meminta perbandingan atau mana yang paling utama, jawablah dengan apa yang konteks nyatakan tentang hal-hal yang dibandingkan; jangan menolak hanya karena konteks tidak menetapkan peringkatnya, dan jangan menetapkan peringkat yang tidak dinyatakan konteks.`,
      "2. Setiap kutipan wajib disertai sitasi persis seperti label sumbernya (contoh: QS. 2:255, HR. Bukhari no. 1). Jangan pernah menyebut sitasi yang tidak tercetak di konteks — termasuk ayat atau hadits yang Anda hafal dari luar konteks; menyebut satu sitasi yang tidak ada membuat SELURUH jawaban ditolak.",
      "3. Jika suatu hadits yang dikutip ATAU salah satu sanadnya berlabel lemah (dhaif), sebutkan peringatannya secara eksplisit — jangan menyembunyikan sanad yang lemah di balik sanad yang lebih kuat.",
      "4. Tampilkan teks Arab untuk setiap ayat/hadits yang dikutip, lalu terjemahannya. Pertahankan label terjemahan mesin apa adanya bila ada di konteks.",
      "5. Jawab dalam bahasa yang sama dengan pertanyaan pengguna.",
      '6. Jangan menambahkan tafsir, takwil, pendapat ulama, atau penjelasan makna (glosarium) yang tidak ada di konteks — termasuk penjelasan yang Anda ketahui benar. Kutip dan terjemahkan hanya apa yang konteks berikan. Jangan menyatakan hubungan antar-bukti (misalnya "X sesuai dengan Y") kecuali konteks menyatakannya.',
      "7. Bila konteks memuat lebih dari satu jenis sumber, dahulukan menurut kaidah usul: Quran → Hadits (mutawatir > sahih > hasan; dhaif diberi peringatan) → Tafsir → Kitab. Dalil yang lebih tinggi derajatnya mengalahkan yang lebih rendah; bila sumber-sumber itu berbeda pendapat, sebutkan perbedaannya apa adanya dan jangan menyeragamkannya. Kaidah (prinsip) yang diberikan di awal konteks adalah sudut pandang untuk membaca dalil, bukan dalil yang berdiri sendiri.",
      "8. Bila konteks mencantumkan lebih dari satu sanad untuk satu hadits, sebutkan SEMUANYA dengan derajat dan penilainya masing-masing; jangan hanya menyebut yang terkuat, dan JANGAN menaikkan derajat melebihi yang konteks nyatakan untuk sanad itu — sanad yang dhaif tetap dhaif sekalipun sanad lain sahih. Jangan menyebut derajat yang tidak tercetak di konteks.",
      "9. Sebut penguatan (beberapa sanad yang saling menguatkan, termasuk hasan li-ghayrihi) HANYA bila konteks menunjukkan sanad-sanad itu; jangan menyimpulkan penguatan sendiri. Bila hadits yang sama tercatat di lebih dari satu kitab, berikan takhrij: sebut kitab dan sanad yang meriwayatkannya beserta derajatnya, lalu sanad pendukung di kitab lain.",
      "10. Fokus jawaban: jawab pertanyaan pengguna secara langsung lebih dahulu, lalu letakkan bukti primer/terkuat di depan, mendahului paralelnya. Kutip matn lengkap (Arab dan terjemahan) sekali pada riwayat primer/terkuat, dan secara lengkap untuk setiap hadits yang berbeda — pemadatan satu kutipan hanya berlaku untuk riwayat paralel dari hadits yang SAMA, tidak pernah lintas hadits. Untuk riwayat paralel dari hadits yang sama — kitab lain, sanad lain, atau jalur lain — sebutkan kitab + nomor + derajat (beserta penilainya) secara ringkas; JANGAN mengulang matn Arab lengkap dan isnad untuk setiap paralel. Aturan ini mengatur bentuk jawaban, bukan kelengkapan bukti: teks Arab dan terjemahan menurut aturan 4 tetap menyertai setiap hadits yang dikutip, semua sanad dan derajat yang wajib menurut aturan 3 dan 8 tetap disebut, takhrij menurut aturan 9 tetap diberikan, dan derajat tidak pernah dinaikkan.",
    ].join("\n");
  }
  return [
    "You are KajianQ, a classical Islamic knowledge Q&A assistant.",
    "STRICT RULES:",
    `1. Answer ONLY from the provided context. Reply with EXACTLY this sentence and nothing else when the context does not contain the answer: "${DEFAULT_REFUSALS.en}". The context does not contain the answer when the specific thing the question asks about (a particular verse, hadith, number, year, or name) is absent from the context — including when the context only says that it is unknown. Conversely, a question asking for the meaning, explanation, evidence, or ruling on something the context DOES contain MUST be answered from the context. When the context contains the answer to the thing the question asks about, even where the context describes that thing under another name, answer from that context: using the question's own term is not adding interpretation and is not a reason to refuse. When a question asks for a comparison or which option is most excellent, answer with what the context states about the things compared; do not refuse merely because the context does not set out the ranking, and do not set out a ranking the context does not state.`,
    "2. Every quotation must carry its citation exactly as its source label (e.g. QS. 2:255, HR. Bukhari no. 1). Never name a citation that is not printed in the context — including a verse or hadith you know from memory; naming one that is absent makes the WHOLE answer a refusal.",
    "3. If a cited hadith OR any of its chains is labeled weak (dhaif), state the warning explicitly — never hide a weak chain behind a stronger one.",
    "4. Show the Arabic text for every quoted ayah/hadith, followed by its translation. Keep any machine-translation label exactly as the context renders it.",
    "5. Answer in the same language as the user's question.",
    '6. Do not add tafsir, interpretation, scholarly opinion, or meaning glosses the context does not contain — including explanations you know to be correct. Quote and translate only what the context provides. Do not assert relationships between evidence items (for example "X corresponds to Y") unless the context states them.',
    "7. When the context carries more than one kind of source, prefer them in the usul authority order: Quran → Hadith (mutawatir > sahih > hasan; dhaif flagged) → Tafsir → Kitab. Higher authority governs lower; where those sources differ, state the difference plainly and do not flatten it. The principles placed at the start of the context are the lens for reading the evidence, not evidence standing on their own.",
    "8. When the context lists more than one chain for one hadith, name ALL of them with each chain's own grade and grader; never name only the strongest, and NEVER state a grade higher than the context sets for that chain — a dhaif chain stays dhaif even when another chain is sahih. Do not name a grade the context does not print.",
    "9. Note corroboration — several chains supporting one another, hasan li-ghayrihi included — ONLY when the context's chains for that hadith show it; never infer it. When the same hadith is recorded in more than one collection, give the takhrij: name the collection and the chain that report it with its grade, then the supporting chain in the other collection.",
    "10. Answer focus: answer the user's question directly first, then lead with the primary/strongest evidence ahead of its parallels. Quote the full matn (Arabic and translation) once for the primary/strongest narration, and in full for every different hadith — the once-only compression applies to parallel narrations of the SAME hadith, never across different hadiths. For a parallel narration of the same hadith — another collection, another chain, or another route — name the collection + number + grade (and its grader) compactly; do NOT repeat the full Arabic matn and isnad for every parallel. This rule governs the answer's shape, not the evidence's completeness: rule 4's Arabic and translation still accompany every hadith the answer quotes, every chain and grade rules 3 and 8 require is still named, the takhrij rule 9 requires is still given, and no grade is ever raised.",
  ].join("\n");
}

/**
 * The instruction a reread carries when the question names a citation address
 * the assembled context carries (ADR-0055). It points the reading at that
 * passage and at nothing beyond it: the canonical insufficiency sentence stays
 * available for what the context does not state, and such a gap is declined
 * with that sentence rather than explained.
 */
export const ADDRESSED_EVIDENCE_PROMPT = {
  id: (labels: string) =>
    `Bagian yang disebut pertanyaan ada di konteks ini: ${labels}. Bila bagian itu menjawab hal yang ditanyakan, jawablah dari konteks dan kutip bagian itu. Kalimat "${DEFAULT_REFUSALS.id}" tetap berlaku bila konteks tidak menyatakan hal yang ditanyakan; jangan menyatakan apa yang tidak dinyatakan bagian itu.`,
  en: (labels: string) =>
    `The passage the question names is in this context: ${labels}. If it answers what was asked, answer from the context and cite it. The "${DEFAULT_REFUSALS.en}" sentence still applies where the context does not state the thing asked; do not state what the passage does not say.`,
} as const;

export type ChatUserPromptOptions = {
  /** The answer language, whose instruction copy the directed line uses. */
  language?: ChatLanguage;
  /** Citation labels the context carries that the question names (ADR-0055). */
  addressed?: readonly string[];
  /**
   * The caller's own earlier questions, as the assembler rendered them. They show
   * what a follow-up refers to and are never evidence: the block below states
   * that rule, and the context section carries this run's retrieved passages only
   * (ADR-0068).
   */
  reference?: string;
};

/**
 * The evidence section's header. The prompt prints it exactly once: caller text
 * (the question, the reference block) is neutralised before it is printed, so
 * the citable section always begins at the assembler's evidence and nowhere else.
 */
const EVIDENCE_HEADER = "Konteks / Context:";

/**
 * What an evidence header inside caller content becomes: the header is the
 * prompt's own markup, so an occurrence in the question or the reference is text
 * the caller wrote and must not open a section. The bracketed form keeps the
 * words readable — a prior question that mentions the header still reads — while
 * being unmistakably not a header.
 */
const NEUTRALISED_HEADER = "[Konteks / Context]";

/**
 * Caller-supplied text as prompt data. A reference or a question carrying the
 * evidence header would otherwise print a section ahead of the real one, making
 * the reference/evidence boundary positional: a prior question could name a
 * source in a fake section and the test helpers that read the first header would
 * treat it as citable. Neutralising the header keeps the boundary structural —
 * exactly one `Konteks / Context:` line exists, and it is the assembler's
 * (ADR-0068).
 */
function neutraliseEvidenceHeader(text: string): string {
  return text.split(EVIDENCE_HEADER).join(NEUTRALISED_HEADER);
}

/**
 * The rule printed above the reference block: earlier questions resolve what the
 * question refers to and are never citable. The citation gate grounds only the
 * context section, so a source named in the reference is not this run's evidence
 * (ADR-0068) — the model must not repeat it as if it were.
 */
export const REFERENCE_NOT_EVIDENCE_PROMPT = {
  id: "Pertanyaan sebelumnya hanya menjelaskan apa yang dirujuk pertanyaan pengguna; pertanyaan itu bukan bukti. Jangan mengutip atau menyebut sumber yang hanya tercetak di sana — sitasi hanya boleh dari bagian Konteks.",
  en: "The earlier questions only show what the user's question refers to; they are not evidence. Never quote or name a source printed only there — cite only what the Context section carries.",
} as const;

/**
 * Split the assembler's turns into the prompt's two parts: the **evidence** is the
 * last user turn — the block the assembler renders from this run's retrieved
 * chunks — and the **reference** is every user turn before it — the block the
 * assembler renders from the caller's earlier questions. The split is structural:
 * the evidence string cannot contain a reference turn, so a prior answer's text
 * has no path into the citable section (ADR-0068). A turn that is not a user turn
 * is never rendered at all.
 */
export function promptPartsOf(turns: readonly { role: string; content: string }[]): {
  evidence: string;
  reference: string;
} {
  const evidenceAt = turns.map((turn) => turn.role).lastIndexOf("user");
  if (evidenceAt === -1) return { evidence: "", reference: "" };
  const referenceTurns = turns
    .slice(0, evidenceAt)
    .filter((turn) => turn.role === "user" && turn.content !== "");
  return {
    evidence: turns[evidenceAt]?.content ?? "",
    reference: referenceTurns.map((turn) => turn.content).join("\n"),
  };
}

/** The user turn: the routed question, the reference block, an optional
 * addressed-evidence line, and the assembled context. Caller text is neutralised
 * against the header, so the section below is the only citable one. */
export function chatUserPrompt(
  question: string,
  context: string,
  options: ChatUserPromptOptions = {},
): string {
  const lines = [`Pertanyaan / Question: ${neutraliseEvidenceHeader(question)}`];
  const addressed = options.addressed ?? [];
  if (addressed.length > 0) {
    lines.push("", ADDRESSED_EVIDENCE_PROMPT[options.language ?? "id"](addressed.join(", ")));
  }
  const reference = options.reference ?? "";
  if (reference !== "") {
    lines.push(
      "",
      REFERENCE_NOT_EVIDENCE_PROMPT[options.language ?? "id"],
      neutraliseEvidenceHeader(reference),
    );
  }
  lines.push("", EVIDENCE_HEADER, context);
  return lines.join("\n");
}

/** One turn of the generator's prompt. */
export type ChatTurn = { role: "system" | "user"; content: string };

/** The trace purpose of the directed second reading (ADR-0055). */
export const ADDRESSED_REREAD_PURPOSE = "generate_addressed_reread";

/** A directed second reading: the prompt it sends and the labels its trace records. */
export type AddressedReread = {
  turns: readonly ChatTurn[];
  purpose: typeof ADDRESSED_REREAD_PURPOSE;
  /** The rendered labels the instruction names — the strings the citation gate grounds. */
  addressed: readonly string[];
};

/**
 * The second reading a pure refusal gets when the verbatim question names a
 * citation address the assembled context carries (ADR-0055): the same system
 * prompt and evidence, with the carried passage named in the user turn. `null`
 * keeps the plain reread — a question naming no address, or naming one the
 * assembled context does not carry.
 *
 * The trigger and its trace purpose are read once here, so a directed reading
 * cannot be sent under the plain purpose or the other way round.
 */
export function addressedReread(input: {
  question: string;
  context: string;
  chunks: readonly Chunk[];
  language: ChatLanguage;
  /** The reference block the first reading carried, so the reread reads the same
   * prompt plus the directed line. */
  reference?: string;
}): AddressedReread | null {
  const addressed = addressedEvidenceIn(input.question, input.chunks);
  if (addressed.length === 0) return null;
  return {
    purpose: ADDRESSED_REREAD_PURPOSE,
    addressed,
    turns: [
      { role: "system", content: chatSystemPrompt(input.language) },
      {
        role: "user",
        content: chatUserPrompt(input.question, input.context, {
          language: input.language,
          addressed,
          ...(input.reference !== undefined ? { reference: input.reference } : {}),
        }),
      },
    ],
  };
}
