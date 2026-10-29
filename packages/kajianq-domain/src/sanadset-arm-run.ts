/**
 * The model arm's half of a study run: what a run would cost, the answers it collects
 * from the pre-registered sample, and the facts it hands the report.
 *
 * The arm is optional and separately observable. A run without a credential collects no
 * predictions and reports `not-requested` or `key-absent`; the projection is computed
 * either way, so a `--no-model` rehearsal still states what the arm would have cost.
 */

import {
  estimateArm,
  estimateMatnCall,
  estimateNarratorCall,
  ModelCallCeilingError,
  S1_AUTO_MATCH_THRESHOLD,
  S1_MODEL_BAND_THRESHOLD,
  type ArmClient,
  type ArmEstimate,
  type ArmFacts,
  type ArmPrice,
  type ArmStatus,
  type ArmTotals,
  type ArmVerdict,
  type MatnDecision,
  type PairKind,
  type ReportInput,
  type SamplePair,
} from "./sanadset-core";

/** One pre-registered pair and the arm's blind verdict on it. */
export type SamplePrediction = {
  readonly pairId: string;
  readonly kind: PairKind;
  readonly verdict: ArmVerdict;
};

const NO_TOTALS: ArmTotals = {
  calls: 0,
  requests: 0,
  tokensIn: 0,
  tokensOut: 0,
  costMicroUsd: 0,
  estimated: false,
};

/**
 * The calls a run would make: one per pre-registered pair plus one per ambiguous matn
 * pair, capped by the same ceiling the run enforces. The cap is applied to the request
 * count, so the projection can never claim more calls than the run may issue.
 */
export function estimateStudyCalls(input: {
  readonly pairs: readonly SamplePair[];
  readonly decisions: readonly MatnDecision[];
  readonly rawMatnByIndex: ReadonlyMap<number, string>;
  readonly ceiling: number;
  readonly price: ArmPrice;
}): ArmEstimate {
  const calls = input.pairs.map((pair) =>
    pair.kind === "matn"
      ? estimateMatnCall({ a: pair.a, b: pair.b })
      : estimateNarratorCall({ a: pair.a, b: pair.b }),
  );
  for (const decision of input.decisions) {
    const best = decision.bestCandidate;
    if (best === null || decision.score === null) continue;
    if (decision.score < S1_MODEL_BAND_THRESHOLD || decision.score >= S1_AUTO_MATCH_THRESHOLD)
      continue;
    calls.push(
      estimateMatnCall({
        a: input.rawMatnByIndex.get(best.rowIndex) ?? "",
        b: input.rawMatnByIndex.get(decision.rowIndex) ?? "",
        score: decision.score,
      }),
    );
  }
  return estimateArm(input.price, calls.slice(0, input.ceiling));
}

/**
 * Ask the arm about every pre-registered pair, in registration order. A ceiling hit ends
 * the loop and keeps the answers already collected: the pairs not reached stay unpredicted
 * rather than being reported as anything.
 */
export async function runSamplePredictions(
  client: ArmClient,
  pairs: readonly SamplePair[],
): Promise<SamplePrediction[]> {
  const predictions: SamplePrediction[] = [];
  for (const pair of pairs) {
    try {
      const verdict =
        pair.kind === "matn"
          ? await client.predictSampleMatn({ a: pair.a, b: pair.b })
          : await client.predictSampleNarrator({ a: pair.a, b: pair.b });
      predictions.push({ pairId: pair.pairId, kind: pair.kind, verdict });
    } catch (error) {
      if (error instanceof ModelCallCeilingError) break;
      throw error;
    }
  }
  return predictions;
}

/** Why the arm stopped, in the vocabulary the report and the PR body use. */
export function stopReason(input: {
  readonly requested: boolean;
  readonly ran: boolean;
  readonly ceilingReached: boolean;
}): ArmFacts["stopReason"] {
  if (!input.ran) return input.requested ? "key-absent" : "not-requested";
  return input.ceilingReached ? "ceiling-reached" : "ran";
}

/**
 * The arm's measured facts and the cost records that back them. Totals are read after
 * the cascade so the band adjudication's requests are included; a run without a client
 * reports zeroes rather than omitting the fields, so a reader never has to guess.
 */
export function summariseArm(input: {
  readonly status: ArmStatus;
  readonly requested: boolean;
  readonly client: ArmClient | null;
  readonly ceilingReached: boolean;
  readonly estimate: ArmEstimate;
  readonly samplePredictions: number;
}): { readonly arm: ArmFacts; readonly costRecords: ReportInput["costRecords"] } {
  const totals = input.client?.totals() ?? NO_TOTALS;
  const arm: ArmFacts = {
    ...input.status,
    ran: input.client !== null,
    stopReason: stopReason({
      requested: input.requested,
      ran: input.client !== null,
      ceilingReached: input.ceilingReached,
    }),
    requests: totals.requests,
    calls: totals.calls,
    tokensIn: totals.tokensIn,
    tokensOut: totals.tokensOut,
    estimatedTokens: totals.estimated,
    spendMicroUsd: totals.costMicroUsd,
    estimate: input.estimate,
    samplePredictions: input.samplePredictions,
  };
  const costRecords: ReportInput["costRecords"] = (input.client?.calls() ?? []).map((record) => ({
    modelId: record.model,
    tokensIn: record.tokensIn,
    tokensOut: record.tokensOut,
    latencyMs: record.latencyMs,
    costMicroUsd: record.costMicroUsd,
    estimated: record.estimated,
  }));
  return { arm, costRecords };
}
