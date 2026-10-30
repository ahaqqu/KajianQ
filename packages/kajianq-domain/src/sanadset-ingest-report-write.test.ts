import { describe, expect, it } from "vite-plus/test";
import { renderPilotMarkdown } from "./sanadset-ingest-report-write";
import { PILOT_LIMITS, type PilotFacts, type PilotReportDocument } from "./sanadset-ingest-report";

/**
 * Test intent, named before the assertions:
 * - trap: a rerun's digest must not read as a first run. The line labels the rows
 *   created/updated/unchanged/deleted, so an upsert of an existing row cannot be
 *   reported as "created";
 * - trap: the total quarantine must appear once as the total, not only as the
 *   prepare-stage slice — a reader of the human artifact must not have to add the
 *   cascade's count themselves.
 */

const baseFacts: PilotFacts = {
  schemaVersion: 1,
  runId: "s2-bukhari-test",
  command: "test",
  dryRun: false,
  collection: "bukhari",
  book: "صحيح البخاري",
  source: { fileName: "sanadset.csv", bytes: 10, sha256: "a".repeat(64), recordsRead: 2 },
  slice: {
    rows: 3,
    noSanad: 0,
    prepared: 2,
    quarantined: 1,
    quarantinedByRule: { reference_only_matn: 1 },
  },
  narrator: {
    identityBasis: "folded-name",
    mentions: 5,
    foldedNames: 2,
    rawSurfaces: 3,
    foldedVariants: 1,
    resolutionRate: 0.8,
    upserted: 2,
    variantsRecorded: 1,
    uncertainPairs: 0,
    uncertainByStratum: {},
  },
  matn: {
    groups: 2,
    matchedGroups: 1,
    ambiguousGroups: 0,
    newChildren: 1,
    storedChildrenCompared: 4,
    truncatedSearches: 0,
    matchRate: { scope: "v1-corpus", matchedRows: 1, rows: 2, value: 0.5 },
  },
  chains: { planned: 2 },
  write: {
    children: { created: 1, updated: 2, unchanged: 3, deleted: 4 },
    chains: { created: 5, updated: 6, unchanged: 7, deleted: 8 },
  },
  quarantine: { total: 9, byRule: { ambiguous_best_match: 8, reference_only_matn: 1 } },
  gate: { mode: "test-escape", label: null, reasons: [] },
  cost: { modelCalls: 0, costMicroUsd: 0 },
  limits: PILOT_LIMITS,
  timings: { startedAt: 0, finishedAt: 1 },
};

function render(overrides: Partial<PilotFacts>): string {
  const document = { pilot: { ...baseFacts, ...overrides } } as unknown as PilotReportDocument;
  return renderPilotMarkdown(document);
}

describe("the pilot's Markdown digest", () => {
  it("labels the write counts created/updated/unchanged/deleted", () => {
    const markdown = render({});
    expect(markdown).toContain("Children: 1 created · 2 updated · 3 unchanged · 4 deleted");
    expect(markdown).toContain("Chains: 5 created · 6 updated · 7 unchanged · 8 deleted");
  });

  it("prints the total quarantine once and the split beside it", () => {
    const markdown = render({});
    expect(markdown.match(/Quarantine total:/g)).toHaveLength(1);
    expect(markdown).toContain("Quarantine total: 9");
    expect(markdown).toContain("Held back after the cascade or by a refused target: 8");
  });

  it("says a cluster is not a Narrator and counts the upserted rows", () => {
    const markdown = render({});
    expect(markdown).toContain("Name cluster, not a resolved Narrator");
    expect(markdown).toContain("Name-cluster rows upserted: 2");
  });

  it("says a dry run wrote nothing and reports the plan's counts instead", () => {
    const markdown = render({ dryRun: true, write: baseFacts.write });
    expect(markdown).toContain(
      "Dry run: nothing written; the plan would create 1 children and write 2 chains.",
    );
    expect(markdown).not.toContain("1 created ·");
  });
});
