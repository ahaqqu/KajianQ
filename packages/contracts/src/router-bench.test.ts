import { describe, expect, it } from "vite-plus/test";
import { parseRouterBenchFixture } from "./router-bench";

/**
 * The router-bench fixture parser: the item schema checks each case, and the
 * parser adds the cross-field check the schema cannot state — every case id
 * is unique, so a run's records and the report's miss list name exactly one
 * case each.
 */

const fixture = (cases: readonly Record<string, unknown>[]) => ({
  id: "router-v0",
  status: "v0-draft",
  cases,
});

const caseOf = (id: string) => ({
  id,
  language: "id",
  question: "Apa hukumnya?",
  expected: { intent: "lookup" },
});

describe("parseRouterBenchFixture", () => {
  it("parses a fixture whose case ids are unique", () => {
    const parsed = parseRouterBenchFixture(fixture([caseOf("a"), caseOf("b")]));
    expect(parsed.cases.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("refuses a duplicated case id, naming it", () => {
    expect(() => parseRouterBenchFixture(fixture([caseOf("a"), caseOf("a")]))).toThrow(
      /duplicate case id "a"/,
    );
  });

  it("still refuses a fixture that violates the item schema", () => {
    expect(() => parseRouterBenchFixture(fixture([{ id: "" }]))).toThrow();
  });
});
