import type { Localized } from "./localized";

/**
 * The FAQ page's content: what KajianQ is, what it refuses to be, how an answer
 * is built, and what happens to a reader's conversation. Every statement here
 * describes behaviour the code already has — sources on the collection page,
 * the trace panel under each answer, the dhaif warning, the feedback controls,
 * the anonymous session — so the page cannot outrun the product.
 */
export type FaqItem = { id: string; question: Localized; answer: Localized };

/** The page's hero copy, kept beside the items it introduces. */
export const FAQ_PAGE = {
  eyebrow: { en: "Frequently asked questions", id: "Pertanyaan umum" },
  title: { en: "Questions, answered plainly.", id: "Pertanyaan, dijawab lugas." },
  lead: {
    en: "What KajianQ is, what it is not, and how to read what it gives you.",
    id: "Apa KajianQ, apa yang bukan, dan bagaimana membaca yang diberikannya.",
  },
} as const satisfies Record<string, Localized>;

export const FAQ_ITEMS: readonly FaqItem[] = [
  {
    id: "what",
    question: {
      en: "What is KajianQ?",
      id: "Apa itu KajianQ?",
    },
    answer: {
      en: "KajianQ is a reading companion for Islamic classical literature. You ask a question, and it composes an answer that names the texts it drew on — the Quran, hadith collections, tafsir, and classical works — so you can continue the study with the sources themselves.",
      id: "KajianQ adalah pendamping membaca literatur Islam klasik. Anda bertanya, lalu ia menyusun jawaban yang menyebutkan teks yang dipakainya — Al-Quran, koleksi hadits, tafsir, dan karya klasik — sehingga Anda dapat melanjutkan kajian pada sumbernya sendiri.",
    },
  },
  {
    id: "fatwa",
    question: {
      en: "Does KajianQ issue fatwa?",
      id: "Apakah KajianQ menetapkan fatwa?",
    },
    answer: {
      en: "No. KajianQ is a study companion, not a mufti. For rulings on worship, family matters, or your own circumstances, ask a qualified scholar. Every answer closes with that reminder, because a reading aid is not an authority.",
      id: "Tidak. KajianQ adalah pendamping belajar, bukan mufti. Untuk keputusan ibadah, keluarga, atau keadaan pribadi, tanyakan kepada ulama yang mumpuni. Setiap jawaban ditutup dengan pengingat itu, karena alat bantu membaca bukan otoritas.",
    },
  },
  {
    id: "sources",
    question: {
      en: "Where do the answers come from?",
      id: "Dari mana jawabannya diambil?",
    },
    answer: {
      en: "From the corpus registered on the Collection page. Entries marked Available are ingested and citable today; entries marked Planned are registered work and are not used yet. An answer is grounded in that corpus — when the evidence is not there, it says so instead of inventing a source.",
      id: "Dari korpus yang terdaftar di halaman Koleksi. Entri bertanda Tersedia sudah diingest dan dapat dikutip hari ini; entri bertanda Direncanakan adalah pekerjaan terdaftar dan belum dipakai. Jawaban berpijak pada korpus itu — bila buktinya tidak ada, ia menyatakannya alih-alih mengarang sumber.",
    },
  },
  {
    id: "trace",
    question: {
      en: "What is the panel below each answer?",
      id: "Apa panel di bawah setiap jawaban?",
    },
    answer: {
      en: "\u201cSee how this answer came together\u201d opens the answer's trace: the sources on record, the router's reading of the question, the sub-queries it searched, the passages it retrieved with their scores, and the model that composed the text. It is the instrument for judging an answer, not decoration.",
      id: "\u201cLihat bagaimana jawaban ini disusun\u201d membuka jejak jawaban: sumber yang tercatat, bacaan router atas pertanyaan, sub-kueri yang dicari, cuplikan yang diambil beserta skornya, dan model yang menyusun teksnya. Itu alat untuk menilai jawaban, bukan hiasan.",
    },
  },
  {
    id: "conversation",
    question: {
      en: "What happens to my questions and conversation?",
      id: "Apa yang terjadi pada pertanyaan dan percakapan saya?",
    },
    answer: {
      en: "There are no accounts. Your conversations are kept in this browser, and starting a new one keeps the previous conversation in the history drawer so you can reopen it. Clearing browser storage removes them all; a server-side copy serves each answer and expires on the schedule the privacy notice lists, together with the erasure path.",
      id: "Tidak ada akun. Percakapan disimpan di peramban ini, dan memulai percakapan baru menyimpan percakapan sebelumnya di riwayat agar bisa dibuka lagi. Menghapus penyimpanan peramban membuang semuanya; salinan di server melayani tiap jawaban lalu kedaluwarsa sesuai jadwal yang dicantumkan pemberitahuan privasi, beserta jalur penghapusannya.",
    },
  },
  {
    id: "languages",
    question: {
      en: "Which languages does KajianQ support?",
      id: "Bahasa apa yang didukung KajianQ?",
    },
    answer: {
      en: "Indonesian and English. Arabic sources are quoted in their original text with a labelled translation, so the wording and the rendering stay distinguishable.",
      id: "Indonesia dan Inggris. Sumber Arab dikutip dalam teks aslinya dengan terjemahan berlabel, sehingga lafal asli dan hasil terjemahan tetap dapat dibedakan.",
    },
  },
  {
    id: "dhaif",
    question: {
      en: "How are weak hadith handled?",
      id: "Bagaimana hadits lemah ditangani?",
    },
    answer: {
      en: "A hadith graded weak (dhaif) always carries a warning card and its grade badge. It may be quoted as a report, but it is never presented as a primary proof.",
      id: "Hadits yang berderajat lemah (dhaif) selalu membawa kartu peringatan dan lencana derajatnya. Ia boleh dikutip sebagai riwayat, tetapi tidak pernah disajikan sebagai dalil utama.",
    },
  },
  {
    id: "report",
    question: {
      en: "How do I report a bad answer?",
      id: "Bagaimana melaporkan jawaban yang keliru?",
    },
    answer: {
      en: "Use the feedback controls under the answer: a wrong citation, an irrelevant passage, a bad machine translation, or a questionable grade. Each report is anchored to the trace element you marked — not free text — so it can be checked against the record.",
      id: "Gunakan kontrol masukan di bawah jawaban: kutipan salah, cuplikan tidak relevan, terjemahan mesin buruk, atau derajat yang diragukan. Setiap laporan tertaut ke elemen jejak yang Anda tandai — bukan teks bebas — sehingga dapat diperiksa terhadap rekamannya.",
    },
  },
  {
    id: "cost",
    question: {
      en: "Is KajianQ free?",
      id: "Apakah KajianQ gratis?",
    },
    answer: {
      en: "Yes. There are no accounts, no advertising, and no tracking. The operator covers the model calls.",
      id: "Ya. Tidak ada akun, iklan, atau pelacakan. Operator menanggung panggilan model.",
    },
  },
];
