/**
 * The matn reconciliation cascade: exact -> folded-exact -> trigram Jaccard, with
 * the model reached only inside the pre-registered ambiguous band.
 *
 * The cascade is sequential and deterministic: every row is compared against the
 * group book built from earlier rows, and the book has no merge path, so a decision
 * is never retracted and the outcome is a function of the input order alone.
 *
 * Thresholds (pre-registered): >= 0.90 joins automatically, [0.60, 0.90) is the
 * model band, < 0.60 does not match. Two groups within 0.02 of the top score are
 * quarantined as an ambiguous best match before the model is asked — an arbitrary
 * tie-break is exactly the force-merge this study exists to avoid.
 */

import { ModelCallCeilingError, type CallBudget } from "./sanadset-budget";
import { createGroupBook } from "./sanadset-cascade-groups";
import {
  assertThresholds,
  S1_AMBIGUITY_MARGIN,
  S1_AUTO_MATCH_THRESHOLD,
  S1_MODEL_BAND_THRESHOLD,
  type BestCandidate,
  type CascadeOptions,
  type CascadeResult,
  type MatnCounts,
  type MatnDecisionKind,
  type MatnVerdict,
  type ScoredPair,
} from "./sanadset-cascade-types";
import { jaccard } from "./sanadset-text";
import type { PreparedRow, QuarantinedRow } from "./sanadset-prepare";

function emptyCounts(): MatnCounts {
  return {
    exact: 0,
    folded: 0,
    trigram: 0,
    modelSame: 0,
    modelDifferent: 0,
    bandUnresolved: 0,
    noMatch: 0,
    quarantined: 0,
    joinedExisting: 0,
    newGroups: 0,
    coalescedRows: 0,
    bandRows: 0,
    scoredRows: 0,
    candidateCapHits: 0,
  };
}

/** Run the cascade over prepared rows and return every decision it made. */
export async function runMatnCascade(options: CascadeOptions): Promise<CascadeResult> {
  const autoThreshold = options.autoThreshold ?? S1_AUTO_MATCH_THRESHOLD;
  const bandThreshold = options.bandThreshold ?? S1_MODEL_BAND_THRESHOLD;
  const ambiguityMargin = options.ambiguityMargin ?? S1_AMBIGUITY_MARGIN;
  assertThresholds(autoThreshold, bandThreshold, ambiguityMargin);
  const adjudicator = options.adjudicate;
  const callBudget: CallBudget | undefined = options.budget;
  if (adjudicator !== undefined && callBudget === undefined) {
    throw new Error("matn cascade: a model adjudicator requires a call budget");
  }

  const rowsByIndex = new Map<number, PreparedRow>();
  for (const row of options.rows) {
    if (rowsByIndex.has(row.rowIndex))
      throw new Error(`matn cascade: duplicate row index ${row.rowIndex}`);
    rowsByIndex.set(row.rowIndex, row);
  }

  const book = createGroupBook();
  const decisions: CascadeResult["decisions"] = [];
  const quarantined: QuarantinedRow[] = [];
  const counts = emptyCounts();
  const model = { calls: 0, ceilingReached: false };
  const onGroupScore = options.onGroupScore;

  const decide = (
    row: PreparedRow,
    kind: MatnDecisionKind,
    groupId: number | null,
    matchedRowIndex: number | null,
    score: number | null,
    bestCandidate: BestCandidate | null,
  ): void => {
    decisions.push({
      rowIndex: row.rowIndex,
      kind,
      groupId,
      matchedRowIndex,
      score,
      bestCandidate,
    });
  };

  const quarantine = (row: PreparedRow, rule: QuarantinedRow["rule"], note: string): void => {
    quarantined.push({
      rowIndex: row.rowIndex,
      book: row.book,
      hadithNumber: row.hadithNumber,
      rule,
      detail: note,
      sanadLength: null,
    });
    counts.quarantined += 1;
  };

  /** Score every candidate group and keep its best member; reports one pair per group. */
  const rankGroups = (
    row: PreparedRow,
    members: readonly { rowIndex: number; groupId: number }[],
  ): BestCandidate[] => {
    const bestByGroup = new Map<number, BestCandidate>();
    for (const member of members) {
      const other = rowsByIndex.get(member.rowIndex);
      if (other === undefined) continue;
      const score = jaccard(row.trigrams, other.trigrams);
      const current = bestByGroup.get(member.groupId);
      const wins =
        current === undefined ||
        score > current.score ||
        (score === current.score && member.rowIndex < current.rowIndex);
      if (wins)
        bestByGroup.set(member.groupId, {
          rowIndex: member.rowIndex,
          groupId: member.groupId,
          score,
        });
    }
    const ranked = [...bestByGroup.values()].sort(
      (left, right) =>
        right.score - left.score || left.rowIndex - right.rowIndex || left.groupId - right.groupId,
    );
    if (onGroupScore !== undefined) {
      for (const candidate of ranked) {
        const pair: ScoredPair = {
          rowIndex: row.rowIndex,
          otherRowIndex: candidate.rowIndex,
          groupId: candidate.groupId,
          score: candidate.score,
        };
        onGroupScore(pair);
      }
    }
    return ranked;
  };

  /** Ask the model inside the band; a spent budget or an unparseable verdict never merges. */
  const adjudicateBand = async (
    row: PreparedRow,
    top: BestCandidate,
  ): Promise<MatnVerdict | "ceiling"> => {
    if (adjudicator === undefined) return "ceiling";
    if (model.ceilingReached) return "ceiling";
    try {
      callBudget?.take();
      return await adjudicator({
        a: rowsByIndex.get(top.rowIndex)?.rawMatn ?? row.rawMatn,
        b: row.rawMatn,
        score: top.score,
      });
    } catch (error) {
      if (!(error instanceof ModelCallCeilingError)) throw error;
      model.ceilingReached = true;
      return "ceiling";
    }
  };

  for (const row of options.rows) {
    const exactGroupId = book.groupIdForExactMatn(row.rawMatn);
    if (exactGroupId !== undefined) {
      book.join(row, exactGroupId);
      decide(
        row,
        "exact",
        exactGroupId,
        book.groupOf(exactGroupId).representativeRowIndex,
        1,
        null,
      );
      counts.exact += 1;
      counts.joinedExisting += 1;
      continue;
    }
    const foldedGroupId = book.groupIdForFoldedMatn(row.normalizedMatn);
    if (foldedGroupId !== undefined) {
      book.join(row, foldedGroupId);
      decide(
        row,
        "folded",
        foldedGroupId,
        book.groupOf(foldedGroupId).representativeRowIndex,
        1,
        null,
      );
      counts.folded += 1;
      counts.joinedExisting += 1;
      continue;
    }

    const searched = book.search(row);
    if (searched.truncated) counts.candidateCapHits += 1;
    const ranked = rankGroups(row, searched.values);
    if (ranked.length > 0) counts.scoredRows += 1;
    const top = ranked[0] ?? null;
    const second = ranked[1] ?? null;

    if (
      top !== null &&
      second !== null &&
      top.score >= bandThreshold &&
      top.score - second.score <= ambiguityMargin
    ) {
      quarantine(
        row,
        "ambiguous_best_match",
        `two groups within ${ambiguityMargin} of the top score (${top.score.toFixed(3)} vs ${second.score.toFixed(3)})`,
      );
      decide(row, "quarantined", null, null, top.score, top);
      counts.bandRows += 1;
      continue;
    }

    if (top !== null && top.score >= autoThreshold) {
      book.join(row, top.groupId);
      decide(row, "trigram", top.groupId, top.rowIndex, top.score, top);
      counts.trigram += 1;
      counts.joinedExisting += 1;
      continue;
    }

    if (top !== null && top.score >= bandThreshold) {
      counts.bandRows += 1;
      const verdict = await adjudicateBand(row, top);
      if (verdict === "ceiling") {
        decide(row, "band-unresolved", book.start(row), null, top.score, top);
        counts.bandUnresolved += 1;
        continue;
      }
      if (verdict === "uncertain") {
        quarantine(
          row,
          "model_uncertain",
          "the model returned an uncertain or unparseable verdict after one retry",
        );
        decide(row, "quarantined", null, null, top.score, top);
        continue;
      }
      if (verdict === "same") {
        book.join(row, top.groupId);
        decide(row, "model-same", top.groupId, top.rowIndex, top.score, top);
        counts.modelSame += 1;
        counts.joinedExisting += 1;
      } else {
        decide(row, "model-different", book.start(row), null, top.score, top);
        counts.modelDifferent += 1;
      }
      continue;
    }

    decide(row, "no-match", book.start(row), null, top?.score ?? null, top);
    counts.noMatch += 1;
  }

  counts.newGroups = book.groups.length;
  counts.coalescedRows = options.rows.length - quarantined.length - book.groups.length;
  model.calls = callBudget?.calls ?? 0;
  return {
    decisions,
    groups: book.snapshot(),
    quarantined,
    counts,
    model: {
      calls: model.calls,
      ceilingReached: model.ceilingReached,
      status:
        adjudicator === undefined ? "not-run" : model.ceilingReached ? "ceiling-reached" : "run",
    },
  };
}
