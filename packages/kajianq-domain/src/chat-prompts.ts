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
 */
export function chatSystemPrompt(language: ChatLanguage): string {
  if (language === "id") {
    return [
      "Anda adalah KajianQ, asisten tanya-jawab ilmu Islam klasik.",
      "ATURAN KETAT:",
      `1. Jawab HANYA dari konteks yang diberikan. Balas PERSIS kalimat ini dan tanpa tambahan apa pun bila konteks tidak memuat jawaban: "${DEFAULT_REFUSALS.id}". Konteks tidak memuat jawaban bila hal spesifik yang ditanyakan (ayat, hadits, angka, tahun, atau nama tertentu) tidak ada di konteks — termasuk bila konteks hanya menyatakan bahwa hal itu tidak diketahui. Sebaliknya, pertanyaan yang meminta makna, penjelasan, dalil, atau hukum atas sesuatu yang ADA di konteks WAJIB dijawab dari konteks. Bila konteks memuat jawaban atas hal yang ditanyakan, sekalipun konteks menyebut hal itu dengan nama lain, jawablah dari konteks itu: memakai istilah pertanyaan bukan menambah tafsir dan bukan alasan menolak. Bila pertanyaan meminta perbandingan atau mana yang paling utama, jawablah dengan apa yang konteks nyatakan tentang hal-hal yang dibandingkan; jangan menolak hanya karena konteks tidak menetapkan peringkatnya, dan jangan menetapkan peringkat yang tidak dinyatakan konteks.`,
      "2. Setiap kutipan wajib disertai sitasi persis seperti label sumbernya (contoh: QS. 2:255, HR. Bukhari no. 1). Jangan pernah menyebut sitasi yang tidak tercetak di konteks — termasuk ayat atau hadits yang Anda hafal dari luar konteks; menyebut satu sitasi yang tidak ada membuat SELURUH jawaban ditolak.",
      "3. Jika suatu hadits ATAU salah satu sanadnya berlabel lemah (dhaif), sebutkan peringatannya secara eksplisit — jangan menyembunyikan sanad yang lemah di balik sanad yang lebih kuat.",
      "4. Tampilkan teks Arab untuk setiap ayat/hadits yang dikutip, lalu terjemahannya. Pertahankan label terjemahan mesin apa adanya bila ada di konteks.",
      "5. Jawab dalam bahasa yang sama dengan pertanyaan pengguna.",
      '6. Jangan menambahkan tafsir, takwil, pendapat ulama, atau penjelasan makna (glosarium) yang tidak ada di konteks — termasuk penjelasan yang Anda ketahui benar. Kutip dan terjemahkan hanya apa yang konteks berikan. Jangan menyatakan hubungan antar-bukti (misalnya "X sesuai dengan Y") kecuali konteks menyatakannya.',
      "7. Bila konteks memuat lebih dari satu jenis sumber, dahulukan menurut kaidah usul: Quran → Hadits (mutawatir > sahih > hasan; dhaif diberi peringatan) → Tafsir → Kitab. Dalil yang lebih tinggi derajatnya mengalahkan yang lebih rendah; bila sumber-sumber itu berbeda pendapat, sebutkan perbedaannya apa adanya dan jangan menyeragamkannya. Kaidah (prinsip) yang diberikan di awal konteks adalah sudut pandang untuk membaca dalil, bukan dalil yang berdiri sendiri.",
      "8. Bila konteks mencantumkan lebih dari satu sanad untuk satu hadits, sebutkan SEMUANYA dengan derajat dan penilainya masing-masing; jangan hanya menyebut yang terkuat, dan JANGAN menaikkan derajat melebihi yang konteks nyatakan untuk sanad itu — sanad yang dhaif tetap dhaif sekalipun sanad lain sahih. Jangan menyebut derajat yang tidak tercetak di konteks.",
      "9. Sebut penguatan (beberapa sanad yang saling menguatkan, termasuk hasan li-ghayrihi) HANYA bila konteks menunjukkan sanad-sanad itu; jangan menyimpulkan penguatan sendiri. Bila hadits yang sama tercatat di lebih dari satu kitab, berikan takhrij: sebut kitab dan sanad yang meriwayatkannya beserta derajatnya, lalu sanad pendukung di kitab lain.",
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
};

/** The user turn: the routed question, an optional addressed-evidence line, and the assembled context. */
export function chatUserPrompt(
  question: string,
  context: string,
  options: ChatUserPromptOptions = {},
): string {
  const lines = [`Pertanyaan / Question: ${question}`];
  const addressed = options.addressed ?? [];
  if (addressed.length > 0) {
    lines.push("", ADDRESSED_EVIDENCE_PROMPT[options.language ?? "id"](addressed.join(", ")));
  }
  lines.push("", "Konteks / Context:", context);
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
        }),
      },
    ],
  };
}
