import { describe, expect, it } from "bun:test";
import { provenance, queriesFor, unionCandidates, type Candidate } from "./query-expansion";

const SHAPES = {
  topics: ["hukum jamak shalat safar", "bolehkah menjamak shalat dalam perjalanan"],
  hypothetical: "Nabi menjamak shalat Zhuhur dan Ashar ketika dalam perjalanan.",
  quoted: "beliau menjama' shalat Maghrib dan Isya",
};

const row = (id: string, address: string, text = "text"): Candidate => ({
  id,
  address,
  text,
  origin: "question",
});

describe("queriesFor", () => {
  it("puts the user's question first and keeps every distinct shape", () => {
    const plans = queriesFor("Apakah menjamak shalat saat safar boleh?", SHAPES);
    expect(plans[0]).toEqual({
      query: "Apakah menjamak shalat saat safar boleh?",
      origin: "question",
    });
    expect(plans.map((plan) => plan.origin)).toEqual([
      "question",
      "topic",
      "topic",
      "hypothetical",
      "quoted",
    ]);
  });

  it("runs a repeated query once, keeping the origin that introduced it", () => {
    const plans = queriesFor("jamak shalat", {
      topics: ["jamak shalat", "jamak shalat"],
      hypothetical: "  ",
      quoted: "jamak",
    });
    expect(plans).toEqual([
      { query: "jamak shalat", origin: "question" },
      { query: "jamak", origin: "quoted" },
    ]);
  });
});

describe("unionCandidates", () => {
  const corpus: Record<string, Candidate[]> = {
    "question-1": [row("a", "QS. 2:43"), row("b", "HR. Malik no. 326")],
    topic1: [row("b", "HR. Malik no. 326"), row("c", "HR. Nasai no. 598")],
    topic2: [row("d", "HR. Bukhari no. 1108")],
    hypothetical: [row("e", "HR. Muslim no. 1626")],
    quoted: [row("c", "HR. Nasai no. 598")],
  };

  it("unions by id and keeps the first origin that surfaced a row", async () => {
    const seen: string[] = [];
    const union = await unionCandidates(
      "question-1",
      {
        topics: ["topic1", "topic2"],
        hypothetical: "hypothetical",
        quoted: "quoted",
      },
      async (query) => {
        seen.push(query);
        return corpus[query] ?? [];
      },
      10,
    );
    expect(seen).toEqual(["question-1", "topic1", "topic2", "hypothetical", "quoted"]);
    expect(union.map((candidate) => candidate.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(union.find((candidate) => candidate.id === "b")?.origin).toBe("question");
    expect(union.find((candidate) => candidate.id === "c")?.origin).toBe("topic");
    expect(provenance(union)).toEqual({ question: 2, topic: 2, hypothetical: 1, quoted: 0 });
  });

  it("survives a retriever that returns nothing for a shape", async () => {
    const union = await unionCandidates(
      "question-1",
      { topics: ["empty"], hypothetical: "empty2", quoted: "quoted" },
      async (query) => corpus[query] ?? [],
      10,
    );
    expect(union.map((candidate) => candidate.id)).toEqual(["a", "b", "c"]);
  });
});
