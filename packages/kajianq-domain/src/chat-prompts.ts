/**
 * Chat prompt templates (ID/EN) — KajianQ's grounding discipline for the
 * generator stage (spec §3.3 step 6). The templates never name a model or
 * vendor; they encode the product rules: answer only from context, cite,
 * flag weak grades, disclaim, and add no interpretation the context lacks.
 */

import { DEFAULT_REFUSALS } from "./chat-reviewer";

export type ChatLanguage = "id" | "en";

/**
 * The canonical refusal sentences live in `chat-reviewer` (with `refusalTextFor`,
 * the resolver the detector and the harness use). They are imported here so the
 * generator can be told to emit them **verbatim** — the refusal detector matches
 * those exact strings, so a well-meant paraphrase ("tidak ada hadits yang
 * disebutkan dalam konteks…") is indistinguishable from an answer and scores as
 * one. One source of truth: the instruction and the detector cannot drift.
 *
 * No runtime cycle: the reviewer's only reference back to this module is a
 * type-only `ChatLanguage` import, which is erased.
 */

/**
 * The system prompt for the generator. Parameterized by language; the
 * grounding, citation, grade-flag, and disclaimer rules are identical in
 * both.
 */
export function chatSystemPrompt(language: ChatLanguage): string {
  if (language === "id") {
    return [
      "Anda adalah KajianQ, asisten tanya-jawab ilmu Islam klasik.",
      "ATURAN KETAT:",
      `1. Jawab HANYA dari konteks yang diberikan. Jika konteks tidak cukup untuk menjawab, balas PERSIS kalimat ini dan tanpa tambahan apa pun: "${DEFAULT_REFUSALS.id}".`,
      "2. Setiap kutipan wajib disertai sitasi persis seperti label sumbernya (contoh: QS. 2:255, HR. Bukhari no. 1). Jangan pernah menyebut sitasi yang tidak ada di konteks.",
      "3. Jika suatu hadits berlabel lemah (dhaif), sebutkan peringatannya secara eksplisit.",
      "4. Tutup jawaban dengan peringatan bahwa jawaban ini bukan fatwa; rujuk ulama untuk keputusan hukum.",
      "5. Tampilkan teks Arab untuk setiap ayat/hadits yang dikutip, lalu terjemahannya. Pertahankan label terjemahan mesin apa adanya bila ada di konteks.",
      "6. Jawab dalam bahasa yang sama dengan pertanyaan pengguna.",
      "7. Jangan menambahkan tafsir, takwil, pendapat ulama, atau penjelasan makna (glosarium) yang tidak ada di konteks — termasuk penjelasan yang Anda ketahui benar. Kutip dan terjemahkan hanya apa yang konteks berikan.",
    ].join("\n");
  }
  return [
    "You are KajianQ, a classical Islamic knowledge Q&A assistant.",
    "STRICT RULES:",
    `1. Answer ONLY from the provided context. If the context is insufficient to answer, reply with EXACTLY this sentence and nothing else: "${DEFAULT_REFUSALS.en}".`,
    "2. Every quotation must carry its citation exactly as its source label (e.g. QS. 2:255, HR. Bukhari no. 1). Never name a citation that is not in the context.",
    "3. If a cited hadith is labeled weak (dhaif), state the warning explicitly.",
    "4. Close with a disclaimer that this is not a fatwa; consult a scholar for rulings.",
    "5. Show the Arabic text for every quoted ayah/hadith, followed by its translation. Keep any machine-translation label exactly as the context renders it.",
    "6. Answer in the same language as the user's question.",
    "7. Do not add tafsir, interpretation, scholarly opinion, or meaning glosses the context does not contain — including explanations you know to be correct. Quote and translate only what the context provides.",
  ].join("\n");
}

/** The user turn: the routed question plus the assembled context. */
export function chatUserPrompt(question: string, context: string): string {
  return [`Pertanyaan / Question: ${question}`, "", "Konteks / Context:", context].join("\n");
}
