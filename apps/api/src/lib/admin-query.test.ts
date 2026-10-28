import { describe, expect, it } from "vite-plus/test";
import {
  accessSummaryOf,
  adminFilterOf,
  isTraceRowId,
  pageWindowOf,
  parseAdminQuery,
  traceAccessSummary,
} from "./admin-query";

/**
 * The admin list query's two projections. The trap this file exists for: the filter
 * carries the operator's search text and the ACCESS SUMMARY MUST NOT. The types
 * enforce it, and these assertions pin it at the value level — a future refactor that
 * "helpfully" adds the text to the summary reddens here.
 */
const query = (params: Record<string, string>) => new URLSearchParams(params);

describe("parseAdminQuery", () => {
  it("defaults to the first page and its size", () => {
    const parsed = parseAdminQuery(query({}));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.query.page).toBe(1);
    expect(parsed.query.pageSize).toBe(20);
  });

  it("refuses a page size outside the bound rather than clamping it", () => {
    // A clamped page size silently changes what the operator asked for; a filter that
    // degrades to "everything" is the failure this endpoint must not have.
    for (const value of ["0", "51", "1000", "-1", "abc", ""]) {
      expect(parseAdminQuery(query({ pageSize: value })).ok, value).toBe(false);
    }
    expect(parseAdminQuery(query({ page: "0" })).ok).toBe(false);
  });

  it("refuses a negative or non-numeric bound", () => {
    expect(parseAdminQuery(query({ minCostMicroUsd: "-1" })).ok).toBe(false);
    expect(parseAdminQuery(query({ minLatencyMs: "1.5" })).ok).toBe(false);
    expect(parseAdminQuery(query({ from: "yesterday" })).ok).toBe(false);
  });

  it("refuses a reversed date range", () => {
    expect(parseAdminQuery(query({ from: "2000", to: "1000" })).ok).toBe(false);
    expect(parseAdminQuery(query({ from: "1000", to: "2000" })).ok).toBe(true);
  });

  it("refuses an over-long search text instead of truncating it", () => {
    expect(parseAdminQuery(query({ q: "x".repeat(201) })).ok).toBe(false);
    expect(parseAdminQuery(query({ q: "x".repeat(200) })).ok).toBe(true);
  });

  it("ignores parameters it does not own", () => {
    const parsed = parseAdminQuery(query({ utm_source: "x", page: "2" }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.query.page).toBe(2);
  });
});

describe("adminFilterOf", () => {
  it("projects every dimension into the store filter", () => {
    const parsed = parseAdminQuery(
      query({
        q: "ayat kursi",
        from: "100",
        to: "200",
        intent: "ruling",
        model: "generator-stub",
        refused: "true",
        filterRelaxed: "false",
        minLatencyMs: "10",
        minCostMicroUsd: "20",
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(adminFilterOf(parsed.query)).toEqual({
      text: "ayat kursi",
      from: 100,
      to: 200,
      intent: "ruling",
      model: "generator-stub",
      refused: true,
      filterRelaxed: false,
      minLatencyMs: 10,
      minCostMicroUsd: 20,
    });
  });

  it("carries the page window as limit and offset", () => {
    const parsed = parseAdminQuery(query({ page: "3", pageSize: "10" }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(pageWindowOf(parsed.query)).toEqual({ limit: 10, offset: 20 });
  });
});

describe("accessSummaryOf: the log never carries the search text", () => {
  it("records that a text filter ran, and not what it was", () => {
    const parsed = parseAdminQuery(
      query({
        q: "ayat kursi rahasia",
        intent: "ruling",
        model: "generator-stub",
        page: "2",
        pageSize: "5",
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const summary = accessSummaryOf(parsed.query);
    expect(summary).toEqual({
      textSearch: true,
      intentFiltered: true,
      modelFiltered: true,
      page: 2,
      pageSize: 5,
    });
    // `intent` and `model` are bounded strings, not closed vocabularies: an operator can
    // type a question fragment into either one, so neither value may reach the log.
    expect(JSON.stringify(summary)).not.toContain("rahasia");
    expect(JSON.stringify(summary)).not.toContain("ruling");
    expect(JSON.stringify(summary)).not.toContain("generator-stub");
    // The summary type has no field the text could travel in.
    expect(Object.keys(summary)).not.toContain("q");
    expect(Object.keys(summary)).not.toContain("text");
  });

  it("writes only booleans and bounded numbers, whatever the operator typed", () => {
    // The information-schema test proves the COLUMN set; this is the value-level half: a
    // dimension whose value is an operator string would carry content even though no
    // column could hold it.
    const parsed = parseAdminQuery(
      query({
        q: "some question fragment",
        from: "100",
        to: "200",
        intent: "a ruling question fragment",
        model: "a model field someone pasted into",
        refused: "true",
        filterRelaxed: "false",
        minLatencyMs: "10",
        minCostMicroUsd: "20",
        page: "3",
        pageSize: "10",
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const summary = accessSummaryOf(parsed.query);
    for (const [key, value] of Object.entries(summary)) {
      expect(["boolean", "number"], key).toContain(typeof value);
    }
    const serialized = JSON.stringify(summary);
    for (const fragment of ["some question fragment", "a ruling question fragment", "pasted"]) {
      expect(serialized).not.toContain(fragment);
    }
  });

  it("says false when no text filter ran", () => {
    const parsed = parseAdminQuery(query({ refused: "true" }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const summary = accessSummaryOf(parsed.query);
    expect(summary.textSearch).toBe(false);
    expect(summary.refused).toBe(true);
  });

  it("names only the opaque row id for a single-trace read", () => {
    const id = "00000000-0000-4000-8000-000000000000";
    expect(traceAccessSummary(id)).toEqual({ textSearch: false, traceId: id });
  });
});

describe("isTraceRowId", () => {
  it("admits only the uuid form the column can hold", () => {
    expect(isTraceRowId("00000000-0000-4000-8000-000000000000")).toBe(true);
    expect(isTraceRowId("00000000-0000-4000-8000-00000000000Z")).toBe(false);
    expect(isTraceRowId("trace-1")).toBe(false);
    expect(isTraceRowId("")).toBe(false);
    // A malformed id must be answered as "no such trace", never reach the adapter's
    // uuid cast — where it would become a 500.
  });
});
