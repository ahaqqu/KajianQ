/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

/**
 * The independent probe suite's content, pinned in the domain pack: the five
 * questions, their languages, the citations a passing answer must ground, and the
 * short content checks. The engine-side test in `@app/eval` owns parsing, scoring
 * and reporting and names none of this vocabulary.
 *
 * The fixture is deliberately NOT a Golden Set: it has no `questions`, no
 * `status`, no expected source types and no refusal rows, so it cannot be loaded
 * or counted as one.
 */

type RawCheck = { label: string; anyOf: string[] };
type RawProbe = {
  id: string;
  question: string;
  language: string;
  expectedCitations: string[];
  expectedContent: RawCheck[];
};

const RAW = JSON.parse(
  readFileSync(new URL("../fixtures/independent-probes-v1.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

const PROBES = RAW.probes as RawProbe[];

const EXPECTED = [
  {
    id: "probe-4-103",
    language: "id",
    expectedCitations: ["QS. 4:103"],
  },
  {
    id: "probe-bukhari-1",
    language: "id",
    expectedCitations: ["HR. Bukhari no. 1"],
  },
  {
    id: "probe-2-275-278",
    language: "id",
    expectedCitations: ["QS. 2:275", "QS. 2:278"],
  },
  {
    id: "probe-bukhari-6094",
    language: "id",
    expectedCitations: ["HR. Bukhari no. 6094"],
  },
  {
    id: "probe-17-23-24",
    language: "id",
    expectedCitations: ["QS. 17:23", "QS. 17:24"],
  },
];

describe("independent-probes-v1 — the five probes", () => {
  it("is its own fixture, not a Golden Set", () => {
    expect(RAW.id).toBe("independent-probes-v1");
    expect(RAW.questions).toBeUndefined();
    expect(Array.isArray(RAW.probes)).toBe(true);
    expect(PROBES).toHaveLength(5);
  });

  it("pins the question id, language and expected citations in order", () => {
    expect(
      PROBES.map((probe) => ({
        id: probe.id,
        language: probe.language,
        expectedCitations: probe.expectedCitations,
      })),
    ).toEqual(EXPECTED);
  });

  it("asks a distinct, non-empty question per probe", () => {
    const questions = PROBES.map((probe) => probe.question.trim());
    expect(questions.every((question) => question !== "")).toBe(true);
    expect(new Set(questions).size).toBe(PROBES.length);
  });

  it("gives every probe a short content check with non-empty terms", () => {
    for (const probe of PROBES) {
      expect(probe.expectedContent.length).toBeGreaterThan(0);
      for (const check of probe.expectedContent) {
        expect(check.label.trim()).not.toBe("");
        expect(check.anyOf.length).toBeGreaterThan(0);
        expect(check.anyOf.every((term) => term.trim() !== "")).toBe(true);
      }
    }
  });

  it("pins the content-check labels each probe carries, without changing their terms", () => {
    expect(
      PROBES.map((probe) => ({
        id: probe.id,
        labels: probe.expectedContent.map((check) => check.label),
      })),
    ).toEqual([
      { id: "probe-4-103", labels: ["prayer", "fixed times"] },
      { id: "probe-bukhari-1", labels: ["intention", "deeds"] },
      { id: "probe-2-275-278", labels: ["riba", "prohibition", "remaining riba"] },
      { id: "probe-bukhari-6094", labels: ["truthfulness", "lying"] },
      { id: "probe-17-23-24", labels: ["parents", "kindness", "no harsh words"] },
    ]);
  });
});
