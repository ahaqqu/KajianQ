import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DAIF_TRAP_LABEL,
  GOLDEN_SET_LABELS,
  GOLDEN_SET_TAG_VOCABULARY,
  INTENTS,
  isIntent,
  isPrincipleTag,
  isSubjectArea,
  PRINCIPLE_TAGS,
  SUBJECT_AREAS,
  SUB_QUERY_ORIGINS,
  SUB_QUERY_ROLES,
} from "./taxonomy";

/**
 * The classification vocabularies (#14) — one source of truth for the router's
 * prompt, the router's narrowing, and the Golden Set fixture's labels.
 *
 * The law that makes "one source of truth" real rather than aspirational: a
 * label the fixture carries but the taxonomy does not declare fails here, so
 * the two cannot drift apart silently.
 */

const FIXTURE = new URL("../fixtures/golden-set-v0.json", import.meta.url);

type FixtureQuestion = { id: string; tags?: string[] };

function fixtureTags(): { questionId: string; tag: string }[] {
  const parsed = JSON.parse(readFileSync(FIXTURE, "utf8")) as { questions: FixtureQuestion[] };
  return parsed.questions.flatMap((q) => (q.tags ?? []).map((tag) => ({ questionId: q.id, tag })));
}

describe("classification vocabularies", () => {
  const lists: Record<string, readonly string[]> = {
    SUBJECT_AREAS,
    INTENTS,
    PRINCIPLE_TAGS,
    SUB_QUERY_ROLES,
    SUB_QUERY_ORIGINS,
    GOLDEN_SET_LABELS,
  };

  it("declares no duplicate value inside a list", () => {
    for (const [name, values] of Object.entries(lists)) {
      expect(new Set(values).size, `${name} has a duplicate`).toBe(values.length);
    }
  });

  it("keeps a subject area and an eval label from ever colliding", () => {
    // One string must not mean two things: the fixture's tags are checked
    // against both lists, so an overlap would make the same label ambiguous.
    for (const label of GOLDEN_SET_LABELS) {
      expect(SUBJECT_AREAS as readonly string[]).not.toContain(label);
    }
  });

  it("narrows only the values it declares", () => {
    expect(isSubjectArea("fikih")).toBe(true);
    expect(isSubjectArea("fiqh")).toBe(false); // the spelling the fixture used to carry
    expect(isIntent("ruling")).toBe(true);
    expect(isIntent("dalil_umum")).toBe(false);
    expect(isPrincipleTag("yusr")).toBe(true);
    expect(isPrincipleTag("ease")).toBe(false);
  });

  it("names the dhaif trap inside the eval labels", () => {
    expect(GOLDEN_SET_LABELS as readonly string[]).toContain(DAIF_TRAP_LABEL);
  });

  it("keeps every Golden Set fixture tag inside the vocabulary", () => {
    const tags = fixtureTags();
    expect(tags.length).toBeGreaterThan(0);
    const unknown = tags.filter(({ tag }) => !GOLDEN_SET_TAG_VOCABULARY.includes(tag));
    expect(unknown, `unknown fixture labels: ${JSON.stringify(unknown)}`).toEqual([]);
  });

  it("keeps a subject area on every Golden Set question that is meant to be answerable", () => {
    // A question's subject area is what the router's `category` claims about
    // it, so a routable question with no subject is a curation gap the
    // vocabulary can see. The trap/refusal questions are the deliberate
    // exception: they carry no subject because they must not be answered.
    const tags = fixtureTags();
    const byQuestion = new Map<string, string[]>();
    for (const { questionId, tag } of tags) {
      byQuestion.set(questionId, [...(byQuestion.get(questionId) ?? []), tag]);
    }
    const gaps = [...byQuestion.entries()]
      .filter(([, questionTags]) => {
        const hasSubject = questionTags.some((tag) =>
          (SUBJECT_AREAS as readonly string[]).includes(tag),
        );
        return !hasSubject && !questionTags.includes("refusal");
      })
      .map(([questionId]) => questionId);
    expect(gaps).toEqual([]);
  });
});
