import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import type { GoldenQuestion } from "@app/contracts";
import { citationCandidatesIn, normalizeCitationLabel } from "./chat-citation-normalize";
import {
  formatHadithCitation,
  parseHadithCitation,
  type Grade,
  type HadithCollection,
} from "./hadith-source";

/** A row plus the curation note a `$comment` carries; the note is fixture
 * metadata the contract strips, so the parsed type stays the loader's. */
type CuratedRow = GoldenQuestion & { $comment?: string };

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
) as { questions: CuratedRow[] };

/**
 * The curated corpus-label index: every hadith address the Golden Set and the
 * matn-identity map name, with the label the citation gate folds it to, its
 * consolidated grade, and the edition files and manifest digests the curator
 * read it in.
 */
const CORPUS_LABELS = JSON.parse(
  readFileSync(new URL("../fixtures/hadith-corpus-labels-v0.json", import.meta.url), "utf8"),
) as {
  labels: {
    label: string;
    collection: HadithCollection;
    hadithNo: string;
    grade: Grade | null;
    arabicEdition: string;
    arabicEditionSha256: string;
    indonesianEdition: string;
    indonesianEditionSha256: string;
  }[];
};

const IDENTITY_MAP = JSON.parse(
  readFileSync(new URL("../fixtures/hadith-identities-v0.json", import.meta.url), "utf8"),
) as {
  groups: { canonical: string; members: string[]; relation: "same-report" | "same-ruling" }[];
};

/** The index keyed by the comparison form the citation gate builds. */
const CORPUS_BY_LABEL = new Map(CORPUS_LABELS.labels.map((entry) => [entry.label, entry]));

/**
 * The edition files and SHA256 digests the index was curated against, as the
 * corpus manifest records them. Every entry must carry its collection's pair:
 * a changed corpus or a re-read is then a deliberate update to both the entry
 * and this pin, and an operator with the corpus can verify the recorded file
 * with `sha256sum`.
 */
const SOURCE_EDITIONS: Record<
  HadithCollection,
  {
    arabicEdition: string;
    arabicEditionSha256: string;
    indonesianEdition: string;
    indonesianEditionSha256: string;
  }
> = {
  abudawud: {
    arabicEdition: "hadith/ara-abudawud.json",
    arabicEditionSha256: "216139c5f40a8147e700d62ffa3b5b2fe45d0e034f86941a193c598c10056189",
    indonesianEdition: "hadith/ind-abudawud.json",
    indonesianEditionSha256: "43eeef2a9b020219075bbb7ab2cbdb4d68c4e0a4158d12a7cb2b1da081712b51",
  },
  bukhari: {
    arabicEdition: "hadith/ara-bukhari.json",
    arabicEditionSha256: "e34a3402889ca378871da3c5984b7875c680920e93f1c8738ac7afe502179562",
    indonesianEdition: "hadith/ind-bukhari.json",
    indonesianEditionSha256: "a3005e17d00578bc4937f2c43575c2a3883c5f848c25ca66b064d92f5144bafb",
  },
  ibnmajah: {
    arabicEdition: "hadith/ara-ibnmajah.json",
    arabicEditionSha256: "b406e6be81588ab0ec1ddbed32f5fd95bbcdda242c460d88331e82eb5c2bc0aa",
    indonesianEdition: "hadith/ind-ibnmajah.json",
    indonesianEditionSha256: "57d24d566170dfbdf772264cf2ba20ff113f10c4c43a41190b502f479df56876",
  },
  malik: {
    arabicEdition: "hadith/ara-malik.json",
    arabicEditionSha256: "088b1f354e110211da006d47e37dd8f8837368f318ed683271f0fdb0f09a3ab5",
    indonesianEdition: "hadith/ind-malik.json",
    indonesianEditionSha256: "9ae098a8f282d99fa858dda064ae6578bc64a54906aa9b59490b5b2000b36772",
  },
  muslim: {
    arabicEdition: "hadith/ara-muslim.json",
    arabicEditionSha256: "194073b24090c5368e4d14a3f55c9e0ef144c7437bd7e5aa83aa4d2bc54a8ea0",
    indonesianEdition: "hadith/ind-muslim.json",
    indonesianEditionSha256: "a330ce352dbe509f3f40305daa78b0ed8c4fcb0f8fd3ea96cd7251c267509c5a",
  },
  nasai: {
    arabicEdition: "hadith/ara-nasai.json",
    arabicEditionSha256: "c705983c19bb089c87cd6531aff609bd94d862183ed0859115b0ff991826a956",
    indonesianEdition: "hadith/ind-nasai.json",
    indonesianEditionSha256: "a461e7f1cf64fb0d908a27b5947eb5218363b7bdea872f98c317fddc72eb4b3e",
  },
  tirmidhi: {
    arabicEdition: "hadith/ara-tirmidhi.json",
    arabicEditionSha256: "408028cd56329ed78edbe3ad443beb96b58e16c3e5bd49f9bc7b0eac77c8820f",
    indonesianEdition: "hadith/ind-tirmidhi.json",
    indonesianEditionSha256: "0b405ba8df14d7d90923f3135ce2a3327d827fdbbb036cc0f9ea2979ae280c19",
  },
};

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
  "gs-v0-013": "Sebutkan hadits tentang makan dan minum dengan tangan kanan",
  "gs-v0-014": "Apa makna ikhlas berdasarkan QS. 98:5?",
  "gs-v0-015": "What does Surah Al-Fatihah mean and why is it recited in every prayer?",
  "gs-v0-016": "What did the Prophet tell Mu'adh about zakat when he sent him to Yemen?",
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
    requiredCitations: ["HR. Tirmidhi no. 2646"],
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
    citationAlternatives: [
      "HR. Nasai no. 598",
      "HR. Ibn Majah no. 1070",
      "HR. Bukhari no. 1109",
      "HR. Muslim no. 1621",
      "HR. Muslim no. 1624",
    ],
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
    citationAlternatives: [
      "HR. Abu Dawud no. 5139",
      "HR. Tirmidhi no. 1897",
      "HR. Ibn Majah no. 3661",
    ],
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

/** Every row's structured exclusions, pinned by id: the decision is data, so a
 * dropped or widened exclusion is a deliberate test change; the reason stays in
 * the row's one-line `excludedNote`. */
const EXCLUDED_CITATIONS: Record<string, string[]> = {
  "gs-v0-006": [
    "HR. Malik no. 331",
    "HR. Ibn Majah no. 1069",
    "HR. Ibn Majah no. 1194",
    "HR. Nasai no. 602",
    "HR. Bukhari no. 1668",
    "HR. Tirmidhi no. 888",
    "HR. Bukhari no. 1111",
    "HR. Bukhari no. 1112",
    "HR. Malik no. 326",
  ],
  "gs-v0-017": ["HR. Nasai no. 5149", "HR. Nasai no. 5160", "HR. Ibn Majah no. 3590"],
  "gs-v0-008": [
    "HR. Ibn Majah no. 213",
    "HR. Tirmidhi no. 2905",
    "HR. Tirmidhi no. 2883",
    "HR. Bukhari no. 5015",
    "HR. Bukhari no. 5020",
    "HR. Bukhari no. 5023",
    "HR. Bukhari no. 5024",
    "HR. Bukhari no. 5031",
    "HR. Bukhari no. 5032",
    "HR. Bukhari no. 73",
    "HR. Bukhari no. 1409",
    "HR. Bukhari no. 7141",
    "HR. Bukhari no. 7316",
    "HR. Muslim no. 1896",
    "HR. Ibn Majah no. 4208",
  ],
  "gs-v0-022": [
    "HR. Ibn Majah no. 3657",
    "HR. Abu Dawud no. 5140",
    "HR. Bukhari no. 5970",
    "HR. Tirmidhi no. 1898",
    "HR. Bukhari no. 5972",
    "HR. Muslim no. 6504",
    "HR. Bukhari no. 5973",
    "HR. Bukhari no. 5975",
    "HR. Abu Dawud no. 5141",
    "HR. Tirmidhi no. 1899",
    "HR. Ibn Majah no. 3659",
  ],
};

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

  it("pins every row's structured exclusions, so none can drop or widen silently", () => {
    expect(
      Object.fromEntries(
        FIXTURE.questions
          .filter((question) => question.excludedCitations !== undefined)
          .map((question) => [question.id, question.excludedCitations]),
      ),
    ).toEqual(EXCLUDED_CITATIONS);
  });

  it("carries the family/birr replacement as a new id, grounded on the Bukhari narration", () => {
    const row = FIXTURE.questions.find((question) => question.id === "gs-v0-022") as
      | CuratedRow
      | undefined;
    expect(row).toBeDefined();
    const { $comment, ...curated } = row as CuratedRow;
    expect(curated).toEqual({
      id: "gs-v0-022",
      question: "Siapa yang harus diutamakan: istri atau ibu?",
      language: "id",
      expectedSourceTypes: ["hadith"],
      requiredCitations: ["HR. Bukhari no. 5971"],
      citationAlternatives: [
        "HR. Abu Dawud no. 5139",
        "HR. Tirmidhi no. 1897",
        "HR. Ibn Majah no. 3661",
      ],
      excludedCitations: [
        "HR. Ibn Majah no. 3657",
        "HR. Abu Dawud no. 5140",
        "HR. Bukhari no. 5970",
        "HR. Tirmidhi no. 1898",
        "HR. Bukhari no. 5972",
        "HR. Muslim no. 6504",
        "HR. Bukhari no. 5973",
        "HR. Bukhari no. 5975",
        "HR. Abu Dawud no. 5141",
        "HR. Tirmidhi no. 1899",
        "HR. Ibn Majah no. 3659",
      ],
      excludedNote:
        "HR. Ibn Majah no. 3657 states the same instruction but every grader grades it Daif; HR. Abu Dawud no. 5140 is Daif by both graders and lists mother, father, sister and brother in one breath; HR. Bukhari no. 5970 and HR. Tirmidhi no. 1898 rank deeds — prayer, then birr al-walidayn, then jihad — not who comes first; HR. Bukhari no. 5972 and HR. Muslim no. 6504 are jihad with living parents; HR. Bukhari no. 5973, HR. Bukhari no. 5975 and HR. Abu Dawud no. 5141 are cursing or disobeying parents; HR. Tirmidhi no. 1899 is the Lord's pleasure in the parent's pleasure; HR. Ibn Majah no. 3659 is a child's repayment of a parent.",
      expectedBehavior: "answer",
      tags: ["adab", "hadith"],
    });
    expect($comment).toMatch(/^citationAlternatives: /);
  });
});

/** The map group a label anchors, as canonical or member of either relation:
 * the coverage unit the gate reads instead of the single address. */
function groupOf(
  label: string,
  groups: readonly {
    relation: "same-report" | "same-ruling";
    canonical: string;
    members: readonly string[];
  }[],
): (typeof groups)[number] | undefined {
  const normalized = normalizeCitationLabel(label);
  return groups.find(
    (group) =>
      normalizeCitationLabel(group.canonical) === normalized ||
      group.members.some((member) => normalizeCitationLabel(member) === normalized),
  );
}

/** The excluded citations whose reason the row's one-line note does not name:
 * an exclusion is recorded only when its own reason names its address. The note
 * is documentation, never the decision — `excludedCitations` is. */
function unexplainedExclusions(
  row: Pick<CuratedRow, "excludedCitations" | "excludedNote">,
): string[] {
  const excluded = row.excludedCitations ?? [];
  if (excluded.length === 0) return [];
  const note = row.excludedNote;
  if (note === undefined || /[\r\n]/.test(note)) return [...excluded];
  const named = new Set(citationCandidatesIn(note));
  return excluded.filter((label) => !named.has(normalizeCitationLabel(label)));
}

/**
 * Coverage and relation, encoded: every required hadith address anchors a map
 * group of either relation, so a cited narration the map relates to it is the
 * gate's identity. The map, not the row's opt-in set, is what accepts a
 * same-ruling narration — a row repeats a member in `citationAlternatives` only
 * to widen the exact-address recall leg. A candidate the curator read and ruled
 * out is recorded in `excludedCitations` with a one-line reason naming it.
 */
describe("the map's coverage: every required address anchors a group", () => {
  it("anchors every required hadith address in a group of either relation", () => {
    const unanchored = FIXTURE.questions.flatMap((row) =>
      row.requiredCitations
        .filter((label) => parseHadithCitation(normalizeCitationLabel(label)) !== null)
        .filter((label) => groupOf(label, IDENTITY_MAP.groups) === undefined)
        .map((label) => `${row.id}: ${label}`),
    );
    expect(unanchored).toEqual([]);
  });

  it("pins 008's same-ruling family and the same-report groups that carry its chains", () => {
    const family = groupOf("HR. Bukhari no. 5026", IDENTITY_MAP.groups);
    expect(family?.relation).toBe("same-ruling");
    expect(family?.members).toEqual([
      "HR. Bukhari no. 5025",
      "HR. Bukhari no. 5027",
      "HR. Tirmidhi no. 2909",
      "HR. Tirmidhi no. 2910",
      "HR. Bukhari no. 4937",
      "HR. Muslim no. 1874",
      "HR. Tirmidhi no. 2914",
      "HR. Ibn Majah no. 3780",
    ]);
    const chains: [string, string[]][] = [
      [
        "HR. Bukhari no. 5025",
        [
          "HR. Muslim no. 1894",
          "HR. Muslim no. 1895",
          "HR. Bukhari no. 7529",
          "HR. Tirmidhi no. 1936",
          "HR. Ibn Majah no. 4209",
        ],
      ],
      [
        "HR. Bukhari no. 5027",
        [
          "HR. Bukhari no. 5028",
          "HR. Tirmidhi no. 2907",
          "HR. Tirmidhi no. 2908",
          "HR. Abu Dawud no. 1452",
          "HR. Ibn Majah no. 211",
          "HR. Ibn Majah no. 212",
        ],
      ],
      [
        "HR. Bukhari no. 4937",
        ["HR. Muslim no. 1862", "HR. Abu Dawud no. 1454", "HR. Ibn Majah no. 3779"],
      ],
      ["HR. Tirmidhi no. 2914", ["HR. Abu Dawud no. 1464"]],
    ];
    for (const [canonical, members] of chains) {
      const group = IDENTITY_MAP.groups.find((candidate) => candidate.canonical === canonical);
      expect(group?.relation, canonical).toBe("same-report");
      expect(group?.members, canonical).toEqual(members);
    }
  });

  it("states a reason naming every excluded citation, on one line", () => {
    for (const row of FIXTURE.questions) {
      expect(unexplainedExclusions(row), row.id).toEqual([]);
    }
  });

  it("records an exclusion as structured data, with a reason naming the address", () => {
    const row = (excluded: string[], note?: string) => ({
      excludedCitations: excluded,
      ...(note === undefined ? {} : { excludedNote: note }),
    });
    expect(unexplainedExclusions(row(["HR. Muslim no. 2"]))).toEqual(["HR. Muslim no. 2"]);
    expect(
      unexplainedExclusions(row(["HR. Muslim no. 2"], "HR. Muslim no. 2 is another report.")),
    ).toEqual([]);
    // A longer number in the reason does not name the excluded address.
    expect(
      unexplainedExclusions(row(["HR. Muslim no. 2"], "HR. Muslim no. 20 is another report.")),
    ).toEqual(["HR. Muslim no. 2"]);
  });
});

/** The grade each opt-in alternative carries in the index (`null` = ungraded,
 * e.g. a sahihayn address) — the evidence the curator read before accepting it,
 * pinned so a silent grade change in the index shows. The key set is pinned to
 * the alternatives too, so a new member enters only with its grade. */
const ALTERNATIVE_GRADES: Record<string, Grade | null> = {
  "HR. Nasai no. 598": "sahih",
  "HR. Ibn Majah no. 1070": "sahih",
  "HR. Bukhari no. 1109": null,
  "HR. Muslim no. 1621": null,
  "HR. Muslim no. 1624": null,
  "HR. Bukhari no. 5027": null,
  "HR. Bukhari no. 4937": null,
  "HR. Nasai no. 5148": "sahih",
  "HR. Nasai no. 5265": "hasan",
  "HR. Tirmidhi no. 1720": "hasan",
  "HR. Ibn Majah no. 3597": "sahih",
  "HR. Abu Dawud no. 5139": "hasan",
  "HR. Tirmidhi no. 1897": "hasan",
  "HR. Ibn Majah no. 3661": "hasan",
};

/**
 * A drift check, not evidence. This index and the Golden Set are both hand-written
 * declarations, so a label the curator misread in the corpus and wrote into both
 * passes: the test never opens the corpus. What it does catch is disagreement — a
 * requirement, alternative or map claim that was not registered, a grade the index
 * carries differently, an entry that no longer renders its own label — and the
 * recorded edition files and digests let an operator with the corpus audit the
 * reading. The fixture's own `$comment` states the same residual risk.
 */
describe("the curated corpus-label index registers every curated hadith label", () => {
  it("renders each entry's label from its own collection, number and grade", () => {
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

  it("records the edition files and manifest digests each label was read in", () => {
    expect(new Set(CORPUS_LABELS.labels.map((entry) => entry.collection))).toEqual(
      new Set(Object.keys(SOURCE_EDITIONS)),
    );
    for (const entry of CORPUS_LABELS.labels) {
      expect(
        {
          arabicEdition: entry.arabicEdition,
          arabicEditionSha256: entry.arabicEditionSha256,
          indonesianEdition: entry.indonesianEdition,
          indonesianEditionSha256: entry.indonesianEditionSha256,
        },
        entry.label,
      ).toEqual(SOURCE_EDITIONS[entry.collection]);
    }
  });

  it("registers every requirement and every opted-in alternative", () => {
    const labels = curatedHadithLabels();
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      expect(CORPUS_BY_LABEL.has(normalizeCitationLabel(label)), label).toBe(true);
    }
  });

  it("registers every label the matn-identity map claims", () => {
    for (const group of IDENTITY_MAP.groups) {
      for (const label of [group.canonical, ...group.members]) {
        expect(CORPUS_BY_LABEL.has(normalizeCitationLabel(label)), label).toBe(true);
      }
    }
  });

  it("pins a grade for every opted-in alternative", () => {
    const alternatives = FIXTURE.questions.flatMap(
      (question) => question.citationAlternatives ?? [],
    );
    expect(Object.keys(ALTERNATIVE_GRADES).sort()).toEqual([...alternatives].sort());
  });

  it("pins the grade each opt-in alternative carries in the index", () => {
    for (const [label, grade] of Object.entries(ALTERNATIVE_GRADES)) {
      expect(CORPUS_BY_LABEL.get(label)?.grade, label).toBe(grade);
    }
  });

  it("pins the sahih grade the re-curated knowledge requirement's retrieval depends on", () => {
    // The route may or may not apply the sahih grade filter to gs-v0-004: under
    // that shape a dhaif requirement is dropped before retrieval, and without it
    // the row is still reached on the fallback track. The requirement is the
    // address that survives both shapes, so it is 2646, not Ibnu Majah 224.
    expect(CORPUS_BY_LABEL.get("HR. Tirmidhi no. 2646")?.grade).toBe("sahih");
  });

  it("keeps the named excluded neighbours out of the requirements, the sets and the map", () => {
    const required = FIXTURE.questions.flatMap((question) => question.requiredCitations);
    const sets = FIXTURE.questions.flatMap((question) => question.citationAlternatives ?? []);
    const mapped = IDENTITY_MAP.groups.flatMap((group) => [group.canonical, ...group.members]);
    // 331 is a Successor's fatwa, not a Prophetic report; 1454 is the zakat
    // schedule, not the obligation/recipient ruling; 5149 and 5160 state the
    // "except a cut piece" exception, a different ruling from the prohibition;
    // 224 is a different narration (Anas, "seeking knowledge is obligatory")
    // that every grader grades dhaif, so a sahih filter drops it before
    // retrieval and no requirement, set or map may name it. For 006's ruling:
    // 1069 states travel combining but every grader grades it Daif; 1194 is
    // qasr rather than jamak; 602 combines while resident, not on a journey;
    // 1668 and 888 are Muzdalifah/Hajj material; 1111, 1112 and 326 combine
    // Dhuhr and Asr only. For 017's ruling: 3590 carries the prohibition with
    // "for them in this world and for us in the Hereafter" and no male/female
    // clause, so it does not state the men/women ruling. For 022's ruling: 3657
    // states the mother-three-times instruction but every grader grades it Daif,
    // 5140 is Daif by both graders and lists mother, father, sister and brother
    // rather than the threefold order, 5970 and 1898 rank deeds instead, 5972
    // and 6504 are jihad with parents, 5973, 5975 and 5141 are cursing or
    // disobeying parents, 1899 is the parent's pleasure and 3659 a child's
    // repayment. For 008's ruling: 213 states khayrukum but its dhaif-wins fold
    // is Daif; 2905 states a recitation reward but all four graders grade it
    // weak; 2883 and 5015 state a specific surah's merit; 5020 is the citron
    // parable, not the reciter's merit; 5023 and 5024 state what was permitted
    // for the Prophet's recitation; 5031 and 5032 are preservation instructions;
    // 73, 1409, 7141, 7316, 1896 and 4208 carry the la-hasad wording with wisdom
    // as the second item, not Quran recitation.
    for (const label of [
      "HR. Malik no. 331",
      "HR. Bukhari no. 1454",
      "HR. Nasai no. 5149",
      "HR. Nasai no. 5160",
      "HR. Ibn Majah no. 3590",
      "HR. Ibnu Majah no. 224",
      "HR. Ibn Majah no. 1069",
      "HR. Ibn Majah no. 1194",
      "HR. Nasai no. 602",
      "HR. Bukhari no. 1668",
      "HR. Tirmidhi no. 888",
      "HR. Bukhari no. 1111",
      "HR. Bukhari no. 1112",
      "HR. Malik no. 326",
      "HR. Ibn Majah no. 3657",
      "HR. Abu Dawud no. 5140",
      "HR. Bukhari no. 5970",
      "HR. Tirmidhi no. 1898",
      "HR. Bukhari no. 5972",
      "HR. Muslim no. 6504",
      "HR. Bukhari no. 5973",
      "HR. Bukhari no. 5975",
      "HR. Abu Dawud no. 5141",
      "HR. Tirmidhi no. 1899",
      "HR. Ibn Majah no. 3659",
      "HR. Ibn Majah no. 213",
      "HR. Tirmidhi no. 2905",
      "HR. Tirmidhi no. 2883",
      "HR. Bukhari no. 5015",
      "HR. Bukhari no. 5020",
      "HR. Bukhari no. 5023",
      "HR. Bukhari no. 5024",
      "HR. Bukhari no. 5031",
      "HR. Bukhari no. 5032",
      "HR. Bukhari no. 73",
      "HR. Bukhari no. 1409",
      "HR. Bukhari no. 7141",
      "HR. Bukhari no. 7316",
      "HR. Muslim no. 1896",
      "HR. Ibn Majah no. 4208",
    ]) {
      expect(required, label).not.toContain(label);
      expect(sets, label).not.toContain(label);
      expect(mapped, label).not.toContain(label);
    }
  });
});
