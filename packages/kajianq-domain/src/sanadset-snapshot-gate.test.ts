import { describe, expect, it } from "vite-plus/test";
import {
  IngestGateRefusal,
  assertIngestGate,
  resolveIngestGate,
  snapshotLabelProblem,
  type SnapshotVerdict,
} from "./sanadset-snapshot-gate";

/**
 * Test intent, named before the assertions:
 * - trap: an unverified or missing label must refuse the run. A gate that checks
 *   "a label was supplied" instead of "the verifier says verified" looks green and
 *   writes to a corpus with no snapshot; the verifier is asserted to be called with
 *   the label, and a verdict of `verified: false` is asserted to refuse while
 *   carrying the verifier's own reasons;
 * - trap: the test escape must not claim a label. It allows the write but records no
 *   label, so a report cannot read as snapshot-backed evidence it did not have;
 * - trap: a dry run must not spend a verification (the operator would pay a large
 *   download for a run that writes nothing) and must not record a label it never
 *   checked;
 * - trap: the refusal must travel as a typed error carrying the reasons, so a caller
 *   that catches it can print the operator's next step rather than "refused".
 */

const verifiedVerdict = (label: string): SnapshotVerdict => ({
  verified: true,
  label,
  reasons: [`snapshot "${label}" verified`],
});

const unverifiedVerdict = (label: string): SnapshotVerdict => ({
  verified: false,
  label,
  reasons: ["dump hash mismatch: manifest abc, downloaded def"],
});

describe("the pre-ingest snapshot gate", () => {
  it("refuses a write with no label and never calls the verifier", async () => {
    let called = 0;
    const decision = await resolveIngestGate({
      dryRun: false,
      testAllowNoSnapshot: false,
      verify: async (label) => {
        called += 1;
        return verifiedVerdict(label);
      },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.label).toBeNull();
    expect(decision.reasons.join("\n")).toContain("no snapshot label was given");
    expect(decision.reasons.join("\n")).toContain("ADR-0038");
    expect(called).toBe(0);
  });

  it("refuses a label the snapshot tool would not accept, before verifying it", async () => {
    let called = 0;
    for (const label of ["Pre-Ingest-2026", "../escape", "a", "has space"]) {
      const decision = await resolveIngestGate({
        dryRun: false,
        testAllowNoSnapshot: false,
        label,
        verify: async (l) => {
          called += 1;
          return verifiedVerdict(l);
        },
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reasons.join("\n")).toContain("must match");
    }
    expect(called).toBe(0);
  });

  it("refuses an unverified snapshot, carrying the verifier's reasons", async () => {
    const decision = await resolveIngestGate({
      dryRun: false,
      testAllowNoSnapshot: false,
      label: "pre-ingest-20261030",
      verify: async (label) => unverifiedVerdict(label),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.label).toBe("pre-ingest-20261030");
    expect(decision.reasons.join("\n")).toContain("dump hash mismatch");
    expect(decision.reasons.join("\n")).toContain("db:snapshot verify pre-ingest-20261030");
  });

  it("allows a verified snapshot and records it", async () => {
    const seen: string[] = [];
    const decision = await resolveIngestGate({
      dryRun: false,
      testAllowNoSnapshot: false,
      label: "pre-ingest-20261030",
      verify: async (label) => {
        seen.push(label);
        return verifiedVerdict(label);
      },
    });
    expect(decision.allowed).toBe(true);
    expect(decision.mode).toBe("verified-snapshot");
    expect(decision.label).toBe("pre-ingest-20261030");
    expect(seen).toEqual(["pre-ingest-20261030"]);
  });

  it("allows the explicit test escape without verifying and without claiming a label", async () => {
    let called = 0;
    const decision = await resolveIngestGate({
      dryRun: false,
      testAllowNoSnapshot: true,
      label: "pre-ingest-20261030",
      verify: async (label) => {
        called += 1;
        return verifiedVerdict(label);
      },
    });
    expect(decision.allowed).toBe(true);
    expect(decision.mode).toBe("test-escape");
    expect(decision.label).toBeNull();
    expect(decision.reasons.join("\n")).toContain("disposable database");
    expect(called).toBe(0);
  });

  it("allows a dry run, verifies nothing and records no label", async () => {
    let called = 0;
    const decision = await resolveIngestGate({
      dryRun: true,
      testAllowNoSnapshot: false,
      label: "pre-ingest-20261030",
      verify: async (label) => {
        called += 1;
        return verifiedVerdict(label);
      },
    });
    expect(decision.allowed).toBe(true);
    expect(decision.mode).toBe("dry-run");
    expect(decision.label).toBeNull();
    expect(called).toBe(0);
  });

  it("stops a write path with a typed refusal that carries every reason", () => {
    expect(() =>
      assertIngestGate({
        allowed: false,
        mode: "verified-snapshot",
        label: "pre-ingest-20261030",
        reasons: ["dump hash mismatch", "corpus drift"],
      }),
    ).toThrow(IngestGateRefusal);
    try {
      assertIngestGate({
        allowed: false,
        mode: "verified-snapshot",
        label: null,
        reasons: ["corpus drift"],
      });
    } catch (error) {
      expect((error as Error).message).toContain("corpus drift");
      expect((error as Error).message).toContain("no verified pre-ingest snapshot");
    }
    expect(() =>
      assertIngestGate({
        allowed: true,
        mode: "verified-snapshot",
        label: "pre-ingest-20261030",
        reasons: [],
      }),
    ).not.toThrow();
  });

  it("accepts the labels the snapshot CLI accepts and nothing else", () => {
    expect(snapshotLabelProblem("pre-ingest-20261030t1200")).toBeNull();
    expect(snapshotLabelProblem("abc")).toBeNull();
    expect(snapshotLabelProblem("")).not.toBeNull();
    expect(snapshotLabelProblem("ab")).not.toBeNull();
    expect(snapshotLabelProblem("has_underscore")).not.toBeNull();
    expect(snapshotLabelProblem("pre-ingest-20261030T1200")).not.toBeNull();
  });
});
