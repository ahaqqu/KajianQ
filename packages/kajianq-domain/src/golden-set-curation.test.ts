import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import type { GoldenQuestion } from "@app/contracts";
import { normalizeCitationLabel } from "./chat-citation-normalize";
import {
  formatHadithCitation,
  parseHadithCitation,
  type Grade,
  type HadithCollection,
} from "./hadith-source";

/**
 * The v0 Golden Set's curated membership, pinned as data. A question id is the
 * key persisted `eval_results` rows reference, so an id is never reused: a
 * retired question leaves the set and its replacement takes the next id. The
 * exact id list makes every add, removal, or id swap a deliberate test change
 * rather than an incidental diff. Each row's requirement is pinned for the same
 * reason: a row no replay recorded has no other guard against a silent re-label.
 * The question text is pinned too: it is what the harness asks the deployed API,
 * so a re-word changes the gate's input and must also be a deliberate change.
 */
const FIXTURE = JSON.parse(
  readFileSync(new URL("../fixtures/golden-set-v0.json", import.meta.url), "utf8"),
) as { questions: GoldenQuestion[] };

/**
 * The corpus's own labels for every hadith address the Golden Set and the
 * matn-identity map name, read from the immutable raw editions and pinned here.
 * The corpus is not available to a test process, so this index is what makes
 * "the label names a corpus row" checkable offline: a curated label absent from
 * it either was never read in the corpus or was mistyped, and the test fails
 * rather than trusting the fixture.
 */
const CORPUS_LABELS = JSON.parse(
  readFileSync(new URL("../fixtures/hadith-corpus-labels-v0.json", import.meta.url), "utf8"),
) as {
  labels: { label: string; collection: HadithCollection; hadithNo: string; grade: Grade | null }[];
};

const IDENTITY_MAP = JSON.parse(
  readFileSync(new URL("../fixtures/hadith-identities-v0.json", import.meta.url), "utf8"),
) as { groups: { canonical: string; members: string[] }[] };

/** The index keyed by the comparison form the citation gate builds. */
const CORPUS_BY_LABEL = new Map(CORPUS_LABELS.labels.map((entry) => [entry.label, entry]));

/** Every hadith label a row demands: its requirement and any alternative it opts in to. */
function curatedHadithLabels(): string[] {
  return FIXTURE.questions.flatMap((question) =>
    [...question.requiredCitations, ...(question.citationAlternatives ?? [])].filter(
      (label) => parseHadithCitation(normalizeCitationLabel(label)) !== null,
    ),
  );
}

const IDS = [
  "gs-v0-001",
  "gs-v0-002",
  "gs-v0-003",
  "gs-v0-004",
  "gs-v0-005",
  "gs-v0-006",
  "gs-v0-008",
  "gs-v0-009",
  "gs-v0-010",
  "gs-v0-011",
  "gs-v0-012",
  "gs-v0-013",
  "gs-v0-014",
  "gs-v0-015",
  "gs-v0-016",
  "gs-v0-017",
  "gs-v0-018",
  "gs-v0-019",
  "gs-v0-020",
  "gs-v0-021",
  "gs-v0-022",
];

/** Retired ids. Kept as a list, so a retirement edits the membership pin by
 * removing an entry here rather than adding another scattered literal. */
const RETIRED_IDS = ["gs-v0-007"];

/** Every head row's question text, pinned by id: the question is the gate's
 * input, so a re-word is a recorded curation change rather than a silent diff. */
const QUESTIONS: Record<string, string> = {
  "gs-v0-001": "Apa maksud Ayat Kursi?",
  "gs-v0-002": "Sebutkan dalil tentang perintah shalat dalam Al-Quran!",
  "gs-v0-003": "Bagaimana tata cara wudhu menurut hadits?",
  "gs-v0-004": "Apa yang Nabi Islam katakan tentang mencari ilmu?",
  "gs-v0-005": "Jelaskan makna Surat Al-Ikhlas!",
  "gs-v0-006": "Apakah menjamak shalat saat safar diperbolehkan? Sebutkan dalilnya.",
  "gs-v0-008": "Hadits apa yang menyebutkan keutamaan membaca Al-Quran?",
  "gs-v0-009": "Jelaskan konsep ridha dalam QS. 89:28!",
  "gs-v0-010": "Bagaimana hukum riba dalam transaksi? Sebutkan ayat dan haditsnya.",
  "gs-v0-011": "Sebutkan hadits tentang kebersihan itu sebagian dari iman!",
  "gs-v0-012": "Apa makna asmaul husna Ar-Rahman dan Ar-Rahim?",
  "gs-v0-013": "Bagaimana adab makan menurut hadits Rasulullah?",
  "gs-v0-014": "Apa makna ikhlas berdasarkan QS. 98:5?",
  "gs-v0-015": "What does Surah Al-Fatihah mean and why is it recited in every prayer?",
  "gs-v0-016": "Which hadith states the obligation of zakat on wealth, and who is entitled to it?",
  "gs-v0-017": "What is the ruling on gold and silk for men, and what is the evidence?",
  "gs-v0-018": "Berapa jumlah rakaat shalat Tarawih yang paling utama menurut hadits sahih?",
  "gs-v0-019": "Kapan kiamat akan terjadi? Sebutkan tahun pastinya!",
  "gs-v0-020":
    "Sebutkan hadits yang memerintahkan mencari ilmu sampai ke negeri China dan jelaskan sanadnya!",
  "gs-v0-021": "Apa isi hadits pada HR. Bukhari no. 191?",
  "gs-v0-022": "Siapa yang harus diutamakan: istri atau ibu?",
};

/** The fields a row's gate behaviour is read from. */
type CuratedRequirement = Pick<
  GoldenQuestion,
  "expectedSourceTypes" | "requiredCitations" | "expectedBehavior" | "citationAlternatives"
>;

/** Every head row's requirement, pinned by id so no row's demand can drift
 * silently: the replay covers only the rows its run recorded. */
const REQUIREMENTS: Record<string, CuratedRequirement> = {
  "gs-v0-001": {
    expectedSourceTypes: ["quran"],
    requiredCitations: ["QS. 2:255"],
    expectedBehavior: "answer",
  },
  "gs-v0-002": {
    expectedSourceTypes: ["quran"],
    requiredCitations: ["QS. 2:43"],
    expectedBehavior: "answer",
  },
  "gs-v0-003": {
    expectedSourceTypes: ["hadith"],
    requiredCitations: ["HR. Bukhari no. 191"],
    expectedBehavior: "answer",
  },
  "gs-v0-004": {
    expectedSourceTypes: ["hadith"],
    requiredCitations: ["HR. Ibnu Majah no. 224"],
    expectedBehavior: "answer",
  },
  "gs-v0-005": {
    expectedSourceTypes: ["quran"],
    requiredCitations: ["QS. 112:1"],
    expectedBehavior: "answer",
  },
  "gs-v0-006": {
    expectedSourceTypes: ["hadith"],
    requiredCitations: ["HR. Bukhari no. 1108"],
    citationAlternatives: ["HR. Nasai no. 598", "HR. Ibn Majah no. 1070"],
    expectedBehavior: "answer",
  },
  "gs-v0-008": {
    expectedSourceTypes: ["hadith"],
    requiredCitations: ["HR. Bukhari no. 5026"],
    citationAlternatives: ["HR. Bukhari no. 5027", "HR. Bukhari no. 4937"],
    expectedBehavior: "answer",
  },
  "gs-v0-009": {
    expectedSourceTypes: ["quran"],
    requiredCitations: ["QS. 89:28"],
    expectedBehavior: "answer",
  },
  "gs-v0-010": {
    expectedSourceTypes: ["quran", "hadith"],
    requiredCitations: ["QS. 2:275"],
    expectedBehavior: "answer",
  },
  "gs-v0-011": {
    expectedSourceTypes: ["hadith"],
    requiredCitations: ["HR. Muslim no. 534"],
    expectedBehavior: "answer",
  },
  "gs-v0-012": {
    expectedSourceTypes: ["quran"],
    requiredCitations: ["QS. 1:1"],
    expectedBehavior: "answer",
  },
  "gs-v0-013": {
    expectedSourceTypes: ["hadith"],
    requiredCitations: ["HR. Muslim no. 5265"],
    expectedBehavior: "answer",
  },
  "gs-v0-014": {
    expectedSourceTypes: ["quran"],
    requiredCitations: ["QS. 98:5"],
    expectedBehavior: "answer",
  },
  "gs-v0-015": {
    expectedSourceTypes: ["quran", "hadith"],
    requiredCitations: ["QS. 1:2"],
    expectedBehavior: "answer",
  },
  "gs-v0-016": {
    expectedSourceTypes: ["hadith"],
    requiredCitations: ["HR. Bukhari no. 1395"],
    expectedBehavior: "answer",
  },
  "gs-v0-017": {
    expectedSourceTypes: ["hadith"],
    requiredCitations: ["HR. Nasai no. 5144"],
    citationAlternatives: [
      "HR. Nasai no. 5148",
      "HR. Nasai no. 5265",
      "HR. Tirmidhi no. 1720",
      "HR. Ibn Majah no. 3597",
    ],
    expectedBehavior: "answer",
  },
  "gs-v0-018": {
    expectedSourceTypes: ["hadith"],
    requiredCitations: [],
    expectedBehavior: "answer",
  },
  "gs-v0-019": {
    expectedSourceTypes: [],
    requiredCitations: [],
    expectedBehavior: "refuse",
  },
  "gs-v0-020": {
    expectedSourceTypes: [],
    requiredCitations: [],
    expectedBehavior: "refuse",
  },
  "gs-v0-021": {
    expectedSourceTypes: ["hadith"],
    requiredCitations: ["HR. Bukhari no. 191"],
    expectedBehavior: "answer",
  },
  "gs-v0-022": {
    expectedSourceTypes: ["hadith"],
    requiredCitations: ["HR. Bukhari no. 5971"],
    expectedBehavior: "answer",
  },
};

/** The requirement as the fixture carries it, in the pinned shape. */
function requirementOf(question: GoldenQuestion): CuratedRequirement {
  const { expectedSourceTypes, requiredCitations, expectedBehavior, citationAlternatives } =
    question;
  return citationAlternatives === undefined
    ? { expectedSourceTypes, requiredCitations, expectedBehavior }
    : { expectedSourceTypes, requiredCitations, citationAlternatives, expectedBehavior };
}

describe("golden-set-v0 curation", () => {
  it("holds 21 questions with distinct ids and no reuse of a retired id", () => {
    const ids = FIXTURE.questions.map((question) => question.id);
    expect(FIXTURE.questions).toHaveLength(21);
    expect(ids).toEqual(IDS);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => RETIRED_IDS.includes(id))).toEqual([]);
  });

  it("pins every row's requirement, so no row can be re-labelled silently", () => {
    expect(
      Object.fromEntries(
        FIXTURE.questions.map((question) => [question.id, requirementOf(question)]),
      ),
    ).toEqual(REQUIREMENTS);
  });

  it("pins every row's question, so a re-word is a deliberate test change", () => {
    expect(
      Object.fromEntries(FIXTURE.questions.map((question) => [question.id, question.question])),
    ).toEqual(QUESTIONS);
  });

  it("carries the family/birr replacement as a new id, grounded on the Bukhari narration", () => {
    expect(FIXTURE.questions.find((question) => question.id === "gs-v0-022")).toEqual({
      id: "gs-v0-022",
      question: "Siapa yang harus diutamakan: istri atau ibu?",
      language: "id",
      expectedSourceTypes: ["hadith"],
      requiredCitations: ["HR. Bukhari no. 5971"],
      expectedBehavior: "answer",
      tags: ["adab", "hadith"],
    });
  });
});

/** The corpus grade each opt-in alternative carries — the evidence the curator
 * read before accepting it, pinned so a silent grade change in the index shows. */
const ALTERNATIVE_GRADES: Record<string, Grade> = {
  "HR. Nasai no. 598": "sahih",
  "HR. Ibn Majah no. 1070": "sahih",
  "HR. Nasai no. 5148": "sahih",
  "HR. Nasai no. 5265": "hasan",
  "HR. Tirmidhi no. 1720": "hasan",
  "HR. Ibn Majah no. 3597": "sahih",
};

describe("every curated hadith label names a corpus row", () => {
  it("indexes each label in the form the corpus renders it", () => {
    expect(CORPUS_LABELS.labels.length).toBeGreaterThan(0);
    for (const entry of CORPUS_LABELS.labels) {
      expect(
        normalizeCitationLabel(
          formatHadithCitation({
            collection: entry.collection,
            hadithNo: entry.hadithNo,
            ...(entry.grade === null ? {} : { grade: entry.grade }),
          }),
        ),
        entry.label,
      ).toBe(entry.label);
    }
    expect(new Set(CORPUS_LABELS.labels.map((entry) => entry.label)).size).toBe(
      CORPUS_LABELS.labels.length,
    );
  });

  it("carries every requirement and every opted-in alternative", () => {
    const labels = curatedHadithLabels();
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      expect(CORPUS_BY_LABEL.has(normalizeCitationLabel(label)), label).toBe(true);
    }
  });

  it("carries every label the matn-identity map claims", () => {
    for (const group of IDENTITY_MAP.groups) {
      for (const label of [group.canonical, ...group.members]) {
        expect(CORPUS_BY_LABEL.has(normalizeCitationLabel(label)), label).toBe(true);
      }
    }
  });

  it("pins the corpus grade each alternative's evidence rests on", () => {
    for (const [label, grade] of Object.entries(ALTERNATIVE_GRADES)) {
      expect(CORPUS_BY_LABEL.get(label)?.grade, label).toBe(grade);
    }
  });

  it("keeps the named different-ruling neighbours out of the sets and the map", () => {
    const sets = FIXTURE.questions.flatMap((question) => question.citationAlternatives ?? []);
    const mapped = IDENTITY_MAP.groups.flatMap((group) => [group.canonical, ...group.members]);
    // 331 is a Successor's fatwa, not a Prophetic report; 1454 is the zakat
    // schedule, not the obligation/recipient ruling; 5149 and 5160 state the
    // \"except a cut piece\" exception, a different ruling from the prohibition.
    for (const label of [
      "HR. Malik no. 331",
      "HR. Bukhari no. 1454",
      "HR. Nasai no. 5149",
      "HR. Nasai no. 5160",
    ]) {
      expect(sets, label).not.toContain(label);
      expect(mapped, label).not.toContain(label);
    }
  });
});
