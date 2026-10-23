/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { citationIdentityResolver } from "./citation-identity";
import {
  GATING_IDENTITY_RELATIONS,
  REPORTED_IDENTITY_RELATIONS,
  parseHadithIdentitySet,
} from "./hadith-identity";
import {
  QuranIdentityError,
  parseQuranIdentitySet,
  quranIdentityResolver,
  type QuranIdentitySet,
} from "./quran-identity";

/**
 * The Qur'an identity map's contract: a pair names verses that are the same
 * evidence under a stated rationale, and the pair is the unit — the map must not
 * degrade into a "shares both divine names" rule, because six verses carry both
 * names and only one pair is the basmalah. A verse outside a pair has no identity
 * and can never match another.
 */

const ROOT = new URL("../../..", import.meta.url);
const QURAN: QuranIdentitySet = parseQuranIdentitySet(
  JSON.parse(
    readFileSync(
      new URL("packages/kajianq-domain/fixtures/quran-identities-v0.json", ROOT),
      "utf8",
    ),
  ),
  "quran-identities-v0",
);
const verseIdentityOf = quranIdentityResolver(QURAN);

const HADITH = parseHadithIdentitySet(
  JSON.parse(
    readFileSync(
      new URL("packages/kajianq-domain/fixtures/hadith-identities-v0.json", ROOT),
      "utf8",
    ),
  ),
  "hadith-identities-v0",
);

describe("the shipped Qur'an identity map", () => {
  it("loads each pair with a canonical, members and a rationale", () => {
    expect(QURAN.id).toBe("quran-identities-v0");
    expect(QURAN.status).toBe("v0-draft");
    expect(QURAN.pairs.length).toBeGreaterThan(0);
    for (const pair of QURAN.pairs) {
      expect(pair.canonical).not.toBe("");
      expect(pair.members.length).toBeGreaterThan(0);
      expect(pair.rationale, "the pair states the rule it is signed under").not.toBe("");
    }
  });

  it("classifies the signed basmalah pair as one evidence", () => {
    const canonical = verseIdentityOf("QS. 1:1");
    expect(canonical).toBe("QS. 1:1");
    expect(verseIdentityOf("QS. 1:3")).toBe(canonical);
  });

  it("does NOT generalize to the other verses that share both names", () => {
    // The measured alternative the packet rejected: six verses carry ar-Rahman and
    // ar-Rahim. Only the signed pair is one evidence; the rest are their own
    // identity, so a question requiring 1:1 is not satisfied by citing 2:163.
    for (const other of ["QS. 2:163", "QS. 27:30", "QS. 41:2", "QS. 59:22", "QS. 55:1"]) {
      expect(verseIdentityOf(other), other).toBeNull();
    }
  });

  it("returns null for a verse outside every pair and for a hadith label", () => {
    expect(verseIdentityOf("QS. 42:11")).toBeNull();
    expect(verseIdentityOf("QS. 1:2")).toBeNull();
    expect(verseIdentityOf("HR. Bukhari no. 191")).toBeNull();
    expect(verseIdentityOf("")).toBeNull();
  });

  it("normalizes the label's spacing before resolving, like the citation gate", () => {
    expect(verseIdentityOf(" QS. 1:3 ")).toBe(verseIdentityOf("QS. 1:1"));
  });
});

describe("citationIdentityResolver — the composed domain resolver", () => {
  const gateOf = citationIdentityResolver(HADITH, QURAN, GATING_IDENTITY_RELATIONS);
  const reportedOf = citationIdentityResolver(HADITH, QURAN, REPORTED_IDENTITY_RELATIONS);

  it("resolves a hadith group and a Qur'an pair in one opaque key space", () => {
    expect(gateOf("HR. Bukhari no. 191")).toBe("HR. Bukhari no. 186");
    expect(gateOf("QS. 1:3")).toBe("QS. 1:1");
    // The two maps' keys cannot collide: a hadith key and a verse key differ.
    expect(gateOf("HR. Bukhari no. 191")).not.toBe(gateOf("QS. 1:1"));
  });

  it("reads the Qur'an pair under both relation sets, and the same-ruling group only when reported", () => {
    expect(gateOf("QS. 1:3")).toBe(gateOf("QS. 1:1"));
    expect(reportedOf("QS. 1:3")).toBe(reportedOf("QS. 1:1"));
    expect(gateOf("HR. Nasai no. 598")).toBeNull();
    expect(reportedOf("HR. Nasai no. 598")).toBe(reportedOf("HR. Bukhari no. 1108"));
  });
});

describe("parseQuranIdentitySet", () => {
  const pair = {
    id: "p",
    canonical: "QS. 1:1",
    members: ["QS. 1:3"],
    rationale: "same two names, the shorter verse adds only the basmalah",
  };
  const valid = { id: "q", status: "v0-draft", pairs: [pair] };

  it("accepts a well-formed map", () => {
    expect(parseQuranIdentitySet(valid).pairs).toHaveLength(1);
  });

  it("rejects a range: a pair key names one verse", () => {
    expect(() =>
      parseQuranIdentitySet({ ...valid, pairs: [{ ...pair, canonical: "QS. 1:1-3" }] }),
    ).toThrow(/not one Quran verse/);
  });

  it("rejects a zero-padded spelling no corpus row renders", () => {
    expect(() =>
      parseQuranIdentitySet({ ...valid, pairs: [{ ...pair, members: ["QS. 01:3"] }] }),
    ).toThrow(/not one Quran verse/);
  });

  it("rejects a label that is not a Qur'an citation", () => {
    expect(() =>
      parseQuranIdentitySet({ ...valid, pairs: [{ ...pair, members: ["HR. Bukhari no. 1"] }] }),
    ).toThrow(QuranIdentityError);
  });

  it("rejects a pair with no rationale: the rule would be unreadable", () => {
    expect(() => parseQuranIdentitySet({ ...valid, pairs: [{ ...pair, rationale: " " }] })).toThrow(
      /rationale must be a non-empty string/,
    );
  });

  it("rejects a label claimed by two pairs", () => {
    expect(() =>
      parseQuranIdentitySet({
        ...valid,
        pairs: [pair, { ...pair, id: "r", canonical: "QS. 2:255" }],
      }),
    ).toThrow(/already claimed/);
  });

  it("rejects a duplicated pair id", () => {
    expect(() =>
      parseQuranIdentitySet({
        ...valid,
        pairs: [pair, { ...pair, canonical: "QS. 2:255" }],
      }),
    ).toThrow(/pair id "p" is already used/);
  });

  it("rejects a member that repeats the canonical", () => {
    expect(() =>
      parseQuranIdentitySet({ ...valid, pairs: [{ ...pair, members: ["QS. 1:1"] }] }),
    ).toThrow(QuranIdentityError);
  });

  it("rejects a malformed map or status", () => {
    expect(() => parseQuranIdentitySet(null)).toThrow(QuranIdentityError);
    expect(() => parseQuranIdentitySet({ ...valid, status: "draft" })).toThrow(/status must be/);
    expect(() => parseQuranIdentitySet({ ...valid, pairs: [] })).toThrow(/pairs must be/);
  });
});
