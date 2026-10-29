/**
 * Assemble the study report and evaluate the pre-registered go/no-go gates.
 *
 * The contract parse is a gate, not a habit: an artifact that does not satisfy
 * `IngestionReportSchema` never reaches disk. The gate table reports `not-measured`
 * with a reason whenever S1 cannot produce the input — a proxy is never promoted to a
 * pass, because the corpus match rate and the sampled F1 are what license a full run.
 */

import { parseIngestionReport } from "@app/contracts";
import type { ReportInput, StudyGate, StudyReportDocument } from "./sanadset-report-types";

/** Assemble the persisted document; the contract parse makes the shape a gate, not a habit. */
export function assembleReportDocument(input: ReportInput): StudyReportDocument {
  const report = parseIngestionReport({
    runId: input.facts.runId,
    sourceKey: `sanadset:s1:${input.facts.source.sha256.slice(0, 12)}`,
    startedAt: input.facts.timings.startedAt,
    finishedAt: input.facts.timings.finishedAt,
    parentsWritten: 0,
    childrenWritten: 0,
    quarantined: input.quarantined,
    costMicroUsd: input.facts.modelArm.spendMicroUsd,
    llmCalls: input.costRecords,
    details: { study: input.facts },
  });
  return { report, study: input.facts };
}

function passOrFail(passed: boolean): "pass" | "fail" {
  return passed ? "pass" : "fail";
}

/**
 * Evaluate the go/no-go gates. A gate whose input S1 cannot produce is
 * `not-measured` with the reason, never `pass` against a substitute number.
 */
export function evaluateGates(input: {
  readonly narratorCoverage: number;
  readonly quarantineShare: number;
  readonly spendMicroUsd: number;
  readonly capMicroUsd: number;
  readonly armRan: boolean;
}): StudyGate[] {
  return [
    {
      id: "narrator-coverage",
      requirement:
        "Narrator mentions whose folded name occurs more than once (coverage, not identity)",
      threshold: ">= 0.95",
      measured: input.narratorCoverage.toFixed(4),
      status: passOrFail(input.narratorCoverage >= 0.95),
      reason:
        "The fold is what places a mention in this count; identity evidence (folded variants, " +
        "blocking-key names, candidate pairs) sits beside the rate and is not the same claim.",
    },
    {
      id: "quarantine-share",
      requirement: "Share of isnad-bearing rows quarantined",
      threshold: "< 5%",
      measured: `${(input.quarantineShare * 100).toFixed(2)}%`,
      status: passOrFail(input.quarantineShare < 0.05),
      reason: "Measured on the slice; every quarantined row carries its rule id.",
    },
    {
      id: "corpus-match-rate",
      requirement: "Matn rows reconciled onto the v1 corpus",
      threshold: ">= 0.80",
      measured: null,
      status: "not-measured",
      reason:
        "S1 constructs no database client, so the reconciliation target is unread. The in-slice " +
        "match rate measures coalescing only and is never substituted here.",
    },
    {
      id: "sampled-macro-f1",
      requirement: "Macro-F1 of an adjudication arm on the pre-registered sample",
      threshold: ">= 0.85",
      measured: null,
      status: "not-measured",
      reason: input.armRan
        ? "The arm predicted the sample, but the labels are owner-supplied and scoring is a separate step, so no F1 exists in this run."
        : "Model arm not run and the sample is unlabelled; no arm can be scored.",
    },
    {
      id: "false-merge-precision",
      requirement: "Precision of 'same' verdicts on the sample",
      threshold: ">= 0.98",
      measured: null,
      status: "not-measured",
      reason:
        "Needs labelled pairs; a wrong merge is a silent corpus defect, so it is never inferred from an unlabelled run.",
    },
    {
      id: "spend-cap",
      requirement: "Recorded spend inside the study cap",
      threshold: "<= $50",
      measured: `$${(input.spendMicroUsd / 1_000_000).toFixed(4)}`,
      status: passOrFail(input.spendMicroUsd <= input.capMicroUsd),
      reason: "Summed from the arm's own usage blocks; zero when the arm did not run.",
    },
  ];
}

/** Count quarantined rows by rule; the report's per-rule table is this function's output. */
export function countByRule(rows: readonly { readonly rule: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.rule] = (counts[row.rule] ?? 0) + 1;
  return counts;
}
