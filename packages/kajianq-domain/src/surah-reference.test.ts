import { readFileSync } from "node:fs";
import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, it } from "vite-plus/test";
import { TOTAL_AYAHS, TOTAL_SURAHS } from "./quran-source";
import {
  SURAH_AYAH_COUNTS,
  SURAH_DESCRIPTION_ALIASES,
  SURAH_NAMES,
  normalizeSurahText,
  withoutArticle,
} from "./surah-names";
import { detectSurahReference, type SurahReference } from "./surah-reference";

/**
 * Surah/verse-reference detection (ADR-0045).
 *
 * The invariant under test: a question that names a surah (by explicit
 * address, by a marker-gated name, or by a description the curated table
 * carries) is recognised deterministically, and a question that
 * does not name one is not. The second half is the trap — expansion is
 * additive context, so a false positive spends budget on an unrelated surah
 * and, worse, would let a question about the *person* Muhammad or the
 * *concept* ikhlas retrieve a surah neither asked about.
 *
 * Adversarial cases named before writing: article-less common names
 * (`Muhammad`, `Yunus`, `Maryam`), article-stripped ordinary words (`ikhlas`,
 * `qadr`, `asr`, `nas`, `tin`), out-of-range addresses, and an explicit
 * comparison naming two surahs (first reference wins).
 */

describe("the surah-name table", () => {
  it("covers all 114 surahs, numbered 1..114 in order, with unique names", () => {
    expect(SURAH_NAMES).toHaveLength(114);
    expect(SURAH_NAMES.map((s) => s.number)).toEqual(Array.from({ length: 114 }, (_, i) => i + 1));
    const normalized = SURAH_NAMES.map((s) => normalizeSurahText(s.name));
    for (const name of normalized) expect(name).not.toBe("");
    expect(new Set(normalized).size).toBe(114);
  });
});

/**
 * The per-surah ayah counts are hand-maintained static domain data, so they
 * are pinned from both ends: the corpus total (a typo anywhere breaks the sum)
 * and the committed Tanzil surah-list fixture, whose four entries are exact.
 */
describe("the per-surah ayah counts", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/surah_list.json", import.meta.url), "utf8"),
  ) as Record<string, { id: number; count_ayat: number }>;

  it("has one count per surah, summing to the corpus total", () => {
    expect(SURAH_AYAH_COUNTS).toHaveLength(TOTAL_SURAHS);
    for (const count of SURAH_AYAH_COUNTS) expect(count).toBeGreaterThanOrEqual(1);
    expect(SURAH_AYAH_COUNTS.reduce((a, b) => a + b, 0)).toBe(TOTAL_AYAHS);
  });

  it("agrees with the committed Tanzil surah-list fixture", () => {
    for (const entry of Object.values(fixture)) {
      expect(SURAH_AYAH_COUNTS[entry.id - 1]).toBe(entry.count_ayat);
    }
  });

  it("pins the well-known counts a mixed-up table would break", () => {
    const count = (surah: number) => SURAH_AYAH_COUNTS[surah - 1];
    expect(count(1)).toBe(7); // Al-Fatihah
    expect(count(2)).toBe(286); // Al-Baqarah, the longest
    expect(count(36)).toBe(83); // Ya-Sin
    expect(count(55)).toBe(78); // Ar-Rahman
    expect(count(112)).toBe(4); // Al-Ikhlas
    expect(count(114)).toBe(6); // An-Nas
  });
});

describe("detectSurahReference — recognises a named reference", () => {
  it("detects the Golden Set gs-v0-015 question (the #142/#241 case)", () => {
    expect(
      detectSurahReference(
        "What does Surah Al-Fatihah mean and why is it recited in every prayer?",
      ),
    ).toEqual({ surah: 1 });
  });

  it("detects a name in both the canonical and the article-stripped form", () => {
    expect(detectSurahReference("What does Surah Al-Baqarah teach about fasting?")).toEqual({
      surah: 2,
    });
    expect(detectSurahReference("surat Fatihah artinya apa?")).toEqual({ surah: 1 });
    expect(detectSurahReference("jelaskan isi surah an-nas")).toEqual({ surah: 114 });
  });

  it("detects an explicit QS verse address", () => {
    expect(detectSurahReference("Apa makna QS. 2:255?")).toEqual({ surah: 2, ayah: 255 });
    expect(detectSurahReference("jelaskan Q.S. 112:1")).toEqual({ surah: 112, ayah: 1 });
    expect(detectSurahReference("tafsir QS 18:10")).toEqual({ surah: 18, ayah: 10 });
  });

  it("keeps the verse only when the surah actually has it (A4)", () => {
    // `QS. 1:999` names surah 1 — the expansion reads that surah either way —
    // but Al-Fatihah has seven verses, so the trace must not claim verse 999.
    expect(detectSurahReference("makna QS. 1:999")).toEqual({ surah: 1 });
    expect(detectSurahReference("QS. 2:287")).toEqual({ surah: 2 });
    // The boundary verses themselves are real and stay exact.
    expect(detectSurahReference("QS. 1:7")).toEqual({ surah: 1, ayah: 7 });
    expect(detectSurahReference("QS. 2:286")).toEqual({ surah: 2, ayah: 286 });
    expect(detectSurahReference("QS. 114:6")).toEqual({ surah: 114, ayah: 6 });
    expect(detectSurahReference("QS. 114:7")).toEqual({ surah: 114 });
    // A worded verse carries no number in this grammar: honest surah-only
    // value rather than a guessed one.
    expect(detectSurahReference("surat al-baqarah ayat 255")).toEqual({ surah: 2 });
  });

  it("detects the one-word spellings of a two-word name under the marker (A3)", () => {
    // The executed gap: `surat yasin` / `surat thaha` / `surat yaa siin` hit
    // the very marker that makes them unambiguous and still missed, because
    // the table's canonical forms are two words (`ya sin`, `ta ha`).
    expect(detectSurahReference("kisah surat yasin")).toEqual({ surah: 36 });
    expect(detectSurahReference("surat thaha")).toEqual({ surah: 20 });
    expect(detectSurahReference("surat yaa siin")).toEqual({ surah: 36 });
    expect(detectSurahReference("surat ta ha")).toEqual({ surah: 20 });
    // The compact rule applies to every multi-word name, not just these two.
    expect(detectSurahReference("jelaskan surah annas")).toEqual({ surah: 114 });
    expect(detectSurahReference("isi surat alfatihah")).toEqual({ surah: 1 });
  });

  it("detects a surah-only QS address and the surah/surat marker", () => {
    expect(detectSurahReference("ringkas isi QS. 36")).toEqual({ surah: 36 });
    expect(detectSurahReference("apa isi surah 18?")).toEqual({ surah: 18 });
    expect(detectSurahReference("jelaskan surat ke-12")).toEqual({ surah: 12 });
  });

  it("detects an article-less name when the marker is present", () => {
    // Article-less names are ordinary proper nouns, so the marker is what
    // makes them a reference.
    expect(detectSurahReference("apa isi surah Muhammad?")).toEqual({ surah: 47 });
    expect(detectSurahReference("kisah surat Yunus")).toEqual({ surah: 10 });
    expect(detectSurahReference("surah ikhlas artinya apa?")).toEqual({ surah: 112 });
  });

  it("takes the first reference when a question names two surahs", () => {
    expect(
      detectSurahReference("What is the difference between Surah Al-Fatihah and Surah Al-Ikhlas?"),
    ).toEqual({ surah: 1 });
    // …and the numeric form orders by position too.
    expect(detectSurahReference("compare QS. 112:1 with Surah Al-Fatihah")).toEqual({
      surah: 112,
      ayah: 1,
    });
  });
});

/**
 * The reviewed description table, pinned as literals: the table is a recall
 * device, so its content is a reviewed edit — adding an entry, or changing the
 * surah one maps to, reddens this file.
 *
 * `movedBy` is the entry's referent-moving negative: a longer phrase that
 * contains the entry's own words as a contiguous run, whose qualifier moves the
 * referent to a different surah. It is not a bare-form revert (the entry with
 * its complement removed), which proves only that the phrase is not a bare
 * form, not that a qualifier cannot extend it.
 *
 * The table admits no entry, and the guard below is the structural veto: while
 * detection matches a padded phrase on normalized text, any negative carrying
 * an entry's words prefix-matches, so the null assertion would return the
 * entry's surah for every admitted entry. An entry added before the boundary
 * rule reddens the guard.
 */
type PinnedDescription = {
  phrase: string;
  /** The Tanzil surah the phrase denotes in mushaf order. */
  surah: number;
  movedBy: readonly string[];
};

const PINNED_DESCRIPTIONS: readonly PinnedDescription[] = [];

/**
 * Descriptions a maintainer might admit, each beside the natural qualifier that
 * moves its referent to a different surah. They are residual, not entries: every
 * row's qualified phrase carries the base phrase's words as a contiguous run,
 * and detection must stay null on it — re-admitting a base phrase to the table
 * reddens this pin.
 */
const REFERENT_MOVING_NEGATIVES: readonly Pick<PinnedDescription, "phrase" | "movedBy">[] = [
  {
    phrase: "the first surah of the quran",
    movedBy: ["the first surah of the quran to be revealed"],
  },
  {
    phrase: "the opening chapter of the quran",
    movedBy: ["the opening chapter of the quran in the order of revelation"],
  },
];

/**
 * True when `phrase`'s words appear in `text` as a contiguous run of whole
 * words. Both sides are normalized here, and the normal form is a fixed point,
 * so a caller may pass an already-normalized `text` or a raw phrase without
 * changing the comparison; the detector normalizes an admitted entry the same
 * way, so a raw phrase cannot silently disagree with it on case, punctuation or
 * an apostrophe. The detector's description search matches a padded ` phrase `
 * on normalized text, so it matches whole words only — containment has to
 * agree, or a negative like `caves` for `cave` counts as carrying the entry's
 * words while the detector can never match it.
 */
function containsWordRun(text: string, phrase: string): boolean {
  const words = normalizeSurahText(text)
    .split(" ")
    .filter((word) => word !== "");
  const run = normalizeSurahText(phrase)
    .split(" ")
    .filter((word) => word !== "");
  if (run.length === 0 || run.length > words.length) return false;
  return words.some((_, start) => run.every((word, offset) => words[start + offset] === word));
}

/**
 * Why a row cannot be a guard row, or null when it can: it must carry a
 * referent-moving negative, every negative must carry the phrase's words as a
 * contiguous word run on normalized text (the detector's padded whole-phrase
 * match), and detection must stay null on every negative.
 *
 * The rows loop calls this to pin its null verdict, and every row in it passes
 * the word-run branch by construction, so those calls say nothing about that
 * branch. The typo probe's call is the one that reaches it: it pins the
 * rejection reason, not just a non-null verdict.
 */
function rowRejection(row: { phrase: string; movedBy: readonly string[] }): string | null {
  if (row.movedBy.length === 0) return `${row.phrase}: no referent-moving negative`;
  for (const moved of row.movedBy) {
    if (!containsWordRun(moved, row.phrase)) {
      return `${row.phrase} -> ${moved}: the phrase is not a word run of the negative`;
    }
    if (detectSurahReference(`Which is ${moved}?`) !== null) {
      return `${row.phrase} -> ${moved}: detection is not null`;
    }
  }
  return null;
}

/**
 * Negatives the guard must refuse before it trusts a row: each carries its
 * entry's words as a substring only, never as a contiguous word run, so the
 * detector's padded search cannot match it and the row's null assertion would
 * say nothing about the entry. Each row's `name` is the mutation it pins.
 *
 * The named mutation (`pluralTypo`): admit `the chapter of the cave` into the
 * table and pin it with this negative as its `movedBy`; the guard rejects the
 * row on the word-run check instead of trusting a negative the detector never
 * matches. The negative also names the surah it means, as a maintainer writing
 * a referent would, so detection is non-null on it: a containment regression
 * would still reject the row through the detection branch, and only the pinned
 * reason tells that rejection from the word-run one.
 */
const WORD_ALIGNMENT_PROBES: readonly { name: string; phrase: string; movedBy: string }[] = [
  {
    name: "pluralTypo",
    phrase: "the chapter of the cave",
    movedBy: "the chapter of the caves in the hadith, i.e. surah al-kahf",
  },
];

/**
 * Raw-phrase rows: `phrase` is a literal no caller normalized, while `text` is
 * the normalized question the detector's matcher sees. The helper normalizes
 * the phrase itself, so a raw literal cannot disagree with detection on case,
 * punctuation or an apostrophe. `apostrophe` is that class — `the prophet's`
 * has to match `the prophets`, and detection reads the phrase as no reference.
 *
 * `markerName`'s phrase carries a `surah` marker, so detection reads it through
 * the marker-gated name rule, not through the description path whose table is
 * empty; its `detected` value pins that rule, and the row shares with the
 * helper only the normalized text a raw phrase has to agree on.
 */
const RAW_PHRASE_ROWS: readonly {
  name: string;
  text: string;
  phrase: string;
  detected: SurahReference | null;
}[] = [
  {
    name: "apostrophe",
    text: normalizeSurahText("Which is the prophet's cave in the hadith?"),
    phrase: "the prophet's cave",
    detected: null,
  },
  {
    name: "markerName",
    text: normalizeSurahText("What does Surah Al-Fatihah mean and why is it recited?"),
    phrase: "Surah Al-Fatihah",
    detected: { surah: 1 },
  },
];

describe("detectSurahReference — the curated description table", () => {
  it("carries exactly the reviewed descriptions, pinned as literals", () => {
    expect(SURAH_DESCRIPTION_ALIASES.map((alias) => [alias.phrase, alias.surah])).toEqual(
      PINNED_DESCRIPTIONS.map((entry) => [entry.phrase, entry.surah]),
    );
  });

  it("carries no phrase a natural qualifier moves", () => {
    // The table is empty by design: the positional phrasings are prefixes of
    // revelation-order phrasings (Al-Alaq, not Al-Fatihah), and a tradition-named
    // description's referent rests on an attribution the product does not assert
    // at retrieval time. An empty table with an honest residual is the intended
    // state, not a gap to fill.
    expect(PINNED_DESCRIPTIONS).toEqual([]);
  });

  it("vetoes every description entry until detection gains a boundary rule", () => {
    // The table admits no entry, so the same construction exercises the
    // residual rows: every row's negative carries the row's own words as a
    // contiguous run, and detection must stay null on it. Applied to an entry,
    // that null assertion is the structural veto — the padded phrase match on
    // normalized text finds the entry inside its referent-moving negative and
    // returns the entry's surah — so an entry added before the boundary rule
    // reddens here. The residual rows pass because they are not in the table.
    const rows = [...PINNED_DESCRIPTIONS, ...REFERENT_MOVING_NEGATIVES];
    expect(rows.length).toBeGreaterThan(0);
    for (const entry of rows) {
      expect(rowRejection(entry), entry.phrase).toBeNull();
    }

    // The typo row is not an entry: the guard must reject it, and the phrase is
    // a substring of the negative but not a word run of it. Detection is
    // non-null on the negative (it names a surah), so the detection branch
    // rejects the row too — only the pinned reason shows the word-run branch
    // did, and a containment regression in the helper reddens here.
    expect(WORD_ALIGNMENT_PROBES).toHaveLength(1);
    for (const probe of WORD_ALIGNMENT_PROBES) {
      expect(normalizeSurahText(probe.movedBy), probe.name).toContain(
        normalizeSurahText(probe.phrase),
      );
      expect(rowRejection({ phrase: probe.phrase, movedBy: [probe.movedBy] }), probe.name).toMatch(
        /: the phrase is not a word run of the negative$/,
      );
    }

    // A raw phrase is what the helper receives: it normalizes both sides, so
    // the phrase cannot disagree with the detector's description path, which
    // matches an admitted entry on the same normalized text. `markerName`
    // shares only that normalisation with detection — its phrase is read by
    // the marker-gated name rule, not the empty description table — and
    // `apostrophe` is the same normalisation with no reference either way.
    expect(RAW_PHRASE_ROWS).toHaveLength(2);
    for (const row of RAW_PHRASE_ROWS) {
      expect(containsWordRun(row.text, row.phrase), row.name).toBe(true);
      expect(detectSurahReference(row.text), row.name).toEqual(row.detected);
    }
  });

  it("detects no description in a sentence while the table admits none", () => {
    // The empty table's consequence on the detector: a description-shaped
    // question is residual until a boundary rule lets an entry be admitted, and
    // this reddens when one is.
    for (const question of [
      "What does the surah of the cave mean?",
      "What does the surah that begins with praise mean?",
    ]) {
      expect(detectSurahReference(question), question).toBeNull();
    }
  });

  it("admits only whole phrases once one is admitted", () => {
    // The table's admission rule, pinned structurally: a phrase is at least two
    // words, carries no number, and is no bare name form (which would match
    // without a marker and turn an ordinary word into a surah).
    const nameForms = new Set(
      SURAH_NAMES.flatMap((entry) => {
        const canonical = normalizeSurahText(entry.name);
        return [canonical, withoutArticle(canonical)];
      }),
    );
    for (const alias of SURAH_DESCRIPTION_ALIASES) {
      const normalized = normalizeSurahText(alias.phrase);
      expect(normalized.split(" ").length, alias.phrase).toBeGreaterThan(1);
      expect(normalized, alias.phrase).not.toMatch(/\d/);
      expect(nameForms.has(normalized), alias.phrase).toBe(false);
      expect(alias.surah, alias.phrase).toBeGreaterThanOrEqual(1);
      expect(alias.surah, alias.phrase).toBeLessThanOrEqual(TOTAL_SURAHS);
    }
  });

  it("leaves every description the table does not carry to the residual", () => {
    // A description outside the table gets no reference read: a bare form (any
    // book's opening chapter, or Al-Fatihah only when the question's own context
    // supplies it), a phrase a natural qualifier moves, a tradition-named
    // description whose referent rests on an attribution the product does not
    // assert at retrieval time, an unlisted description, and an Indonesian
    // description the table does not carry. Mapping any of them would be the
    // semantic inference the detection refuses.
    expect(
      detectSurahReference("Which was the first surah of the Quran to be revealed?"),
    ).toBeNull();
    expect(detectSurahReference("What does the seven oft-repeated mean?")).toBeNull();
    expect(detectSurahReference("Why is Ya-Sin called the heart of the Quran?")).toBeNull();
    expect(detectSurahReference("What does the opening chapter say about mercy?")).toBeNull();
    expect(detectSurahReference("What does the first surah teach about prayer?")).toBeNull();
    expect(detectSurahReference("What does the surah that begins with praise mean?")).toBeNull();
    expect(detectSurahReference("What does the first chapter of Al-Umm say?")).toBeNull();
    expect(detectSurahReference("Bagaimana isi surah yang pertama turun?")).toBeNull();
  });
});

describe("detectSurahReference — trap cases (no reference must be detected)", () => {
  it("ignores an article-less common name used about a person or place", () => {
    expect(
      detectSurahReference("Apa akhlak Nabi Muhammad shallallahu alaihi wasallam?"),
    ).toBeNull();
    expect(detectSurahReference("Siapa Maryam binti Imran?")).toBeNull();
  });

  it("ignores article-stripped ordinary words without the marker", () => {
    // `ikhlas` (sincerity), `qadr` (Lailatul Qadar), `asr` (the Asr prayer),
    // `nas` (people) are all ordinary Indonesian/Arabic words.
    expect(detectSurahReference("Apa makna ikhlas dalam beribadah?")).toBeNull();
    expect(detectSurahReference("Apa keutamaan malam Lailatul Qadar?")).toBeNull();
    expect(detectSurahReference("Bagaimana keutamaan sholat Asr?")).toBeNull();
  });

  it("ignores a bare surah name that is really a divine name (the gs-v0-012 trap)", () => {
    // The Golden Set question is about asmaul husna, not Surah Ar-Rahman.
    expect(detectSurahReference("Apa makna asmaul husna Ar-Rahman dan Ar-Rahim?")).toBeNull();
  });

  it("ignores the one-word spellings when no marker precedes them (A3's guard)", () => {
    // The marker is what the new spellings trade on: `yasin` is a common
    // personal name and `annas` is `an-Nas` read as an ordinary word, so
    // without `surah`/`surat` they must stay invisible — exactly like every
    // other article-stripped form above.
    expect(detectSurahReference("Siapa Yasin dalam cerita itu?")).toBeNull();
    expect(detectSurahReference("Apa arti thaha menurut ulama?")).toBeNull();
    expect(detectSurahReference("Apa makna annas dalam bahasa Arab?")).toBeNull();
    // …and a one-word spelling no table rule reaches stays a recorded hole,
    // not a fuzzy match (ADR-0045 revisit trigger).
    expect(detectSurahReference("kisah surat yaseen")).toBeNull();
  });

  it("ignores questions about unrelated subjects", () => {
    expect(detectSurahReference("Bagaimana tata cara bersuci sebelum sholat?")).toBeNull();
    expect(
      detectSurahReference("What is the ruling on praying in a garment that contains gold?"),
    ).toBeNull();
    expect(detectSurahReference("")).toBeNull();
    expect(detectSurahReference("   ")).toBeNull();
  });

  it("rejects an out-of-range address instead of expanding a wrong surah", () => {
    expect(detectSurahReference("QS. 115:1")).toBeNull();
    expect(detectSurahReference("QS. 0:1")).toBeNull();
    expect(detectSurahReference("apa isi surah 999?")).toBeNull();
  });
});

describe("detectSurahReference — the collapse's recorded false positive (R2)", () => {
  it("collapses a doubled-vowel ordinary word onto Al-Fil — accepted-as-is", () => {
    // The elongation collapse (A3) that makes `surat yaa siin` work also turns
    // `fiil` into `fil` — Al-Fil's article-stripped form — so a grammar phrase
    // like `surat fiil madhi` expands a surah the question never named. The
    // class is unreachable before the collapse step existed, realism is weak,
    // and the cost is bounded (a 5-verse surah), so ADR-0045's revisit triggers
    // record it and this test pins it rather than the collapse being narrowed —
    // narrowing would reopen the `yaa siin`/`annas` spellings A3 fixed.
    expect(normalizeSurahText("fiil")).toBe(normalizeSurahText("fil"));
    expect(detectSurahReference("surat fiil madhi")).toEqual({ surah: 105 });
    expect(detectSurahReference("surat fiil dalam bahasa arab")).toEqual({ surah: 105 });
  });
});

/**
 * Every class normalization transforms — case, vowels, apostrophes,
 * separators, diacritics, digits — densely enough that a step which stops
 * producing a fixed point is generated rather than stumbled on. `fc.string()`
 * covers the rest of the input space.
 */
const normalizationInput = fc.oneof(
  fc.string(),
  fc.string({
    unit: fc.constantFrom(
      "a",
      "A",
      "e",
      "E",
      "i",
      "I",
      "o",
      "O",
      "u",
      "U",
      "z",
      "Z",
      "1",
      "9",
      " ",
      "-",
      "'",
      "`",
      "\u0301",
      "\u2019",
      "é",
    ),
  }),
);

describe("normalizeSurahText", () => {
  // The comparison form is a fixed point. The helper normalizes both sides,
  // including a `text` a caller already normalized, and the detector matches an
  // admitted entry's padded phrase on the same form.
  fcTest.prop([normalizationInput])("is idempotent", (text) => {
    const once = normalizeSurahText(text);
    expect(normalizeSurahText(once)).toBe(once);
  });
});

describe("withoutArticle", () => {
  it("strips the transliterated definite article, longest prefix first", () => {
    expect(withoutArticle(normalizeSurahText("Ash-Shu'ara"))).toBe("shuara");
    expect(withoutArticle(normalizeSurahText("An-Nas"))).toBe("nas");
    expect(withoutArticle(normalizeSurahText("Quraish"))).toBe("quraish");
  });
});

/**
 * The whole Golden Set is the false-positive corpus: expansion is additive
 * context, so a question the detector wrongly flags spends budget on a surah
 * nobody asked about. This pins the exact set of questions that expand, so a
 * future name-table edit that starts matching an unrelated question fails
 * here rather than silently in the gate.
 */
describe("detectSurahReference over the Golden Set", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("../fixtures/golden-set-v0.json", import.meta.url), "utf8"),
  ) as { questions: { id: string; question: string }[] };

  it("flags exactly the questions that name a surah reference", () => {
    const flagged = fixture.questions
      .map((q) => [q.id, detectSurahReference(q.question)] as const)
      .filter(([, ref]) => ref !== null);
    expect(Object.fromEntries(flagged)).toEqual({
      "gs-v0-005": { surah: 112 },
      "gs-v0-009": { surah: 89, ayah: 28 },
      "gs-v0-014": { surah: 98, ayah: 5 },
      "gs-v0-015": { surah: 1 },
    });
  });
});
