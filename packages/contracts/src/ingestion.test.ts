import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  AlignedPairSchema,
  IngestionReportSchema,
  MorphTokenSchema,
  parseIngestionReport,
  type IngestionReport,
} from "./ingestion";

const validReport = {
  runId: "run-1",
  sourceKey: "corpus-fixture",
  startedAt: 1_700_000_000_000,
  finishedAt: 1_700_000_000_500,
  parentsWritten: 2,
  childrenWritten: 10,
  quarantined: 0,
  costMicroUsd: 4,
  llmCalls: [
    {
      modelId: "model-a",
      tokensIn: 100,
      tokensOut: 50,
      latencyMs: 120,
      costMicroUsd: 2,
    },
  ],
  details: { alignedPairs: 10 },
} satisfies IngestionReport;

describe("IngestionReportSchema", () => {
  it("accepts a valid report", () => {
    const result = v.safeParse(IngestionReportSchema, validReport);
    expect(result.success).toBe(true);
  });

  it("rejects a report with negative counts (quarantine is never negative)", () => {
    const result = v.safeParse(IngestionReportSchema, {
      ...validReport,
      quarantined: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a report without a cost record array (rule 4: reports are citable)", () => {
    const { llmCalls: _omitted, ...noCalls } = validReport;
    void _omitted;
    const result = v.safeParse(IngestionReportSchema, noCalls);
    expect(result.success).toBe(false);
  });

  it("round-trips through parseIngestionReport", () => {
    expect(parseIngestionReport(validReport)).toEqual(validReport);
  });
});

describe("AlignedPairSchema", () => {
  it("accepts a pair with both language tracks and an opaque citation", () => {
    const result = v.safeParse(AlignedPairSchema, {
      pairId: "p-1",
      citation: { chapter: 112, verse: 1 },
      textPrimary: "primary text",
      textSecondary: "secondary text",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a pair whose secondary track is empty (misalignment)", () => {
    const result = v.safeParse(AlignedPairSchema, {
      pairId: "p-1",
      citation: {},
      textPrimary: "primary",
      textSecondary: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("MorphTokenSchema", () => {
  it("accepts a stem with lemma and root", () => {
    const result = v.safeParse(MorphTokenSchema, {
      word: 1,
      segment: 1,
      form: "form",
      type: "STEM",
      lemma: "lemma",
      root: "root",
      pos: "N",
    });
    expect(result.success).toBe(true);
  });

  it("accepts an affix without lemma or root", () => {
    const result = v.safeParse(MorphTokenSchema, {
      word: 1,
      segment: 2,
      form: "wa",
      type: "PREFIX",
      pos: "CONJ",
    });
    expect(result.success).toBe(true);
  });

  it("rejects word position zero (positions are 1-based)", () => {
    const result = v.safeParse(MorphTokenSchema, {
      word: 0,
      segment: 1,
      form: "form",
      type: "STEM",
      pos: "N",
    });
    expect(result.success).toBe(false);
  });
});