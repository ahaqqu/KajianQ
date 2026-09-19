import type { CollectionEntry } from "./collections-types";

/**
 * Planned entries — registered work, listed so the direction is visible.
 * Never presented as available: each carries a `planRef` (the issue/ADR that
 * registered it), rendered as muted mono text. Mirrors `SPECS.md` §4.2
 * (priority kitab, complete verified corpora) and issues #21, #22, #33, #35.
 */
export const COLLECTION_PLANNED_KITAB: readonly CollectionEntry[] = [
  {
    id: "kitab-al-umm",
    status: "planned",
    category: "kitab",
    century: { en: "2nd c. AH · d. 204 H", id: "Abad 2 H · w. 204 H" },
    title: { en: "Al-Umm", id: "Al-Umm" },
    author: { en: "Imam Syafi'i", id: "Imam Syafi'i" },
    description: {
      en: "The tracer title for kitab ingestion: one classical legal work end to end before scale-out.",
      id: "Judul perintis untuk ingest kitab: satu kitab fikih klasik dari hulu ke hilir sebelum perluasan.",
    },
    planRef: "#21",
  },
  {
    id: "kitab-mudawwanah",
    status: "planned",
    category: "kitab",
    century: { en: "3rd c. AH · d. 240 H", id: "Abad 3 H · w. 240 H" },
    title: { en: "Al-Mudawwanah", id: "Al-Mudawwanah" },
    author: { en: "Sahnun", id: "Sahnun" },
    description: {
      en: "A foundational Maliki legal compilation, carrying Madzhab representation beyond the Syafi'i default.",
      id: "Kompilasi hukum Maliki yang mendasar, membawa keterwakilan madzhab di luar bawaan Syafi'i.",
    },
    planRef: "#22",
  },
  {
    id: "kitab-syarh-aqidah-thahawiyah",
    status: "planned",
    category: "theology",
    century: { en: "4th c. AH · d. 321 H", id: "Abad 4 H · w. 321 H" },
    title: { en: "Syarh Aqidah Thahawiyah", id: "Syarh Aqidah Thahawiyah" },
    author: { en: "Ibn Abi al-'Izz", id: "Ibnu Abi al-'Izz" },
    description: {
      en: "A classical creed commentary, the corpus's aqidah anchor — sharh kept distinct from its matn.",
      id: "Syarah akidah klasik, jangkar akidah korpus — sharh dijaga terpisah dari matn-nya.",
    },
    planRef: "#22",
  },
  {
    id: "kitab-tarikh-tabari",
    status: "planned",
    category: "kitab",
    century: { en: "4th c. AH · d. 310 H", id: "Abad 4 H · w. 310 H" },
    title: { en: "Tarikh al-Tabari", id: "Tarikh ath-Thabari" },
    author: { en: "Ibn Jarir al-Tabari", id: "Ibnu Jarir ath-Thabari" },
    description: {
      en: "The classical universal history, a context source rather than a legal proof.",
      id: "Sejarah universal klasik, sumber konteks alih-alih dalil hukum.",
    },
    planRef: "#22",
  },
  {
    id: "kitab-al-kamil",
    status: "planned",
    category: "kitab",
    century: { en: "7th c. AH · d. 630 H", id: "Abad 7 H · w. 630 H" },
    title: { en: "Al-Kamil fi al-Tarikh", id: "Al-Kamil fi at-Tarikh" },
    author: { en: "Ibn al-Athir", id: "Ibnu al-Atsir" },
    description: {
      en: "The later universal history that closes the priority chronological arc.",
      id: "Sejarah universal yang lebih belakangan, menutup rangkaian kronologis prioritas.",
    },
    planRef: "#22",
  },
  {
    id: "kitab-musnad-ahmad",
    status: "planned",
    category: "hadith",
    century: { en: "3rd c. AH · d. 241 H", id: "Abad 3 H · w. 241 H" },
    title: { en: "Musnad Ahmad", id: "Musnad Ahmad" },
    author: { en: "Imam Ahmad ibn Hanbal", id: "Imam Ahmad bin Hanbal" },
    description: {
      en: "A large musnad collection, adding Hanbali representation to the kitab corpus.",
      id: "Koleksi musnad yang besar, menambah keterwakilan Hanbali pada korpus kitab.",
    },
    planRef: "#22",
  },
  {
    id: "kitab-sunan-ad-darimi",
    status: "planned",
    category: "hadith",
    century: { en: "3rd c. AH · d. 255 H", id: "Abad 3 H · w. 255 H" },
    title: { en: "Sunan ad-Darimi", id: "Sunan ad-Darimi" },
    author: { en: "Imam ad-Darimi", id: "Imam ad-Darimi" },
    description: {
      en: "A further sunan collection, widening the hadith base beyond the seven ingested today.",
      id: "Koleksi sunan lanjutan, memperluas basis hadits di luar tujuh koleksi yang diingest hari ini.",
    },
    planRef: "#22",
  },
  {
    id: "kitab-tahdzib-al-akhlaq",
    status: "planned",
    category: "spirituality",
    century: { en: "5th c. AH · d. 421 H", id: "Abad 5 H · w. 421 H" },
    title: { en: "Tahdzib al-Akhlaq", id: "Tahdzib al-Akhlaq" },
    author: { en: "Ibn Miskawayh", id: "Ibnu Miskawaih" },
    description: {
      en: "A classical akhlaq treatise, the corpus's ethical-philosophical entry point.",
      id: "Risalah akhlak klasik, pintu masuk etis-filosofis korpus.",
    },
    planRef: "#22",
  },
  {
    id: "kitab-al-mabsut",
    status: "planned",
    category: "kitab",
    century: { en: "5th c. AH · d. 483 H", id: "Abad 5 H · w. 483 H" },
    title: { en: "Al-Mabsut", id: "Al-Mabsut" },
    author: { en: "Al-Sarakhsi", id: "As-Sarakhsi" },
    description: {
      en: "Medium-priority Hanafi legal commentary, planned partially and matn-verified per edition.",
      id: "Syarah hukum Hanafi prioritas menengah, direncanakan sebagian dan matn-nya diverifikasi per edisi.",
    },
    planRef: "#22",
  },
  {
    id: "kitab-al-hidayah",
    status: "planned",
    category: "kitab",
    century: { en: "6th c. AH · d. 593 H", id: "Abad 6 H · w. 593 H" },
    title: { en: "Al-Hidayah", id: "Al-Hidayah" },
    author: { en: "Al-Marghinani", id: "Al-Marghinani" },
    description: {
      en: "The Hanafi legal compendium that complements Al-Mabsut; the last of the priority titles.",
      id: "Ringkasan hukum Hanafi yang melengkapi Al-Mabsut; judul prioritas terakhir.",
    },
    planRef: "#22",
  },
];

/**
 * Planned complete verified author corpora (SPECS §4.2): beyond single titles,
 * the complete verified works of the classical tasawuf lineage plus Al-Ghazali.
 * Disputed attributions are excluded or labeled, never silently ingested.
 */
export const COLLECTION_PLANNED_CORPORA: readonly CollectionEntry[] = [
  {
    id: "corpus-ghazali",
    status: "planned",
    category: "theology",
    century: { en: "5th c. AH · d. 505 H", id: "Abad 5 H · w. 505 H" },
    title: {
      en: "Al-Ghazali — complete verified works",
      id: "Al-Ghazali — karya lengkap terverifikasi",
    },
    author: { en: "Al-Ghazali", id: "Al-Ghazali" },
    description: {
      en: "Fiqh trilogy, ushul, aqidah and kalam, tasawuf and akhlaq (Ihya included), and the Persian works — bibliography owner-verified; disputed attributions excluded or labeled.",
      id: "Trilogi fikih, ushul, akidah dan kalam, tasawuf dan akhlak (termasuk Ihya), serta karya Persia — bibliografi diverifikasi pemilik; atribusi yang diperdebatkan dikecualikan atau dilabeli.",
    },
    planRef: "#33",
  },
  {
    id: "corpus-tasawuf-classics",
    status: "planned",
    category: "spirituality",
    century: { en: "4th–6th c. AH · d. 386–561 H", id: "Abad 4–6 H · w. 386–561 H" },
    title: {
      en: "Tasawuf classics — Makki, Qushayri, Jilani",
      id: "Klasik tasawuf — Makki, Qusyairi, Jilani",
    },
    author: {
      en: "Abu Talib al-Makki · al-Qushayri · Abdul Qadir al-Jilani",
      id: "Abu Thalib al-Makki · al-Qusyairi · Abdul Qadir al-Jilani",
    },
    description: {
      en: "Qut al-Qulub; Al-Risalah al-Qushayriyyah and Lata'if al-Isharat; Al-Ghunyah, Futuh al-Ghayb and Al-Fath al-Rabbani — popular disputed attributions such as Sirr al-Asrar are excluded or labeled.",
      id: "Qut al-Qulub; Ar-Risalah al-Qusyairiyyah dan Latha'if al-Isyarat; Al-Ghunyah, Futuh al-Ghaib, dan Al-Fath ar-Rabbani — atribusi populer yang diperdebatkan seperti Sirr al-Asrar dikecualikan atau dilabeli.",
    },
    planRef: "#35",
  },
  {
    id: "corpus-sanadset-v2",
    status: "planned",
    category: "hadith",
    century: { en: "v2 · narrator chains", id: "v2 · rantai perawi" },
    title: { en: "Sanadset isnad corpus", id: "Korpus isnad Sanadset" },
    author: { en: "Sanadset (Kaggle)", id: "Sanadset (Kaggle)" },
    description: {
      en: "Narrator chains and per-chain hadith grades, so the same matn can be graded per sanad rather than once for all chains.",
      id: "Rantai perawi dan derajat hadits per rantai, sehingga matn yang sama dapat dinilai per sanad alih-alih sekali untuk semua rantai.",
    },
    planRef: "#27–#31",
  },
];
