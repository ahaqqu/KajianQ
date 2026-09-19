import type { DecisionBenchFixture, DecisionBenchPrompts, DecisionTask } from "@app/contracts";
import type { CostRecord, Decider } from "@app/rag-core";
import { Effect } from "effect";

/**
 * Decision-bench scoring (ADR-0042): the domain-agnostic measurement
 * machinery for the multilingual decision-model gate. The engine owns the
 * metric math and the case loop; the fixture's passages, claims, and
 * language labels, and the per-task instruction templates all arrive from
 * the domain pack — this module never names a vendor, a model, or an
 * Islamic source (AGENTS.md rule 1).
 *
 * The gate metric is per-(task × language) accuracy, mirroring the #9
 * embedding gate's per-direction cells: a decision model that only judges
 * English well must fail the gate, exactly as an embedding model that only
 * aligns one language fails its direction floors.
 */

/** One scored case: the task it belongs to, the truth, the judgment. */
export type CaseOutcome = {
  caseId: string;
  task: DecisionTask;
  language: string;
  expected: string | number | boolean;
  got: string | number | boolean;
  passed: boolean;
};

/** The gate floors (ADR-0042): overall ≥ 0.85 AND every language ≥ 0.75. */
export const DECISION_GATE_FLOORS = {
  overall: 0.85,
  perLanguage: 0.75,
  /** Each task must have at least this many cases per language to be scored. */
  minCasesPerLanguage: 3,
} as const;

export type DecisionGate = {
  overallPass: boolean;
  failedLanguages: string[];
  gatePass: boolean;
};

/** Mean accuracy over outcomes (null when the list is empty). */
export function meanAccuracy(outcomes: readonly CaseOutcome[]): number | null {
  if (outcomes.length === 0) return null;
  return outcomes.filter((o) => o.passed).length / outcomes.length;
}

/** Group accuracy per language label, for the per-language floor. */
export function accuracyByLanguage(
  outcomes: readonly CaseOutcome[],
): Record<string, { cases: number; accuracy: number }> {
  const byLang = new Map<string, { passed: number; total: number }>();
  for (const o of outcomes) {
    const cell = byLang.get(o.language) ?? { passed: 0, total: 0 };
    cell.total += 1;
    if (o.passed) cell.passed += 1;
    byLang.set(o.language, cell);
  }
  const out: Record<string, { cases: number; accuracy: number }> = {};
  for (const [lang, { passed, total }] of byLang) {
    out[lang] = { cases: total, accuracy: passed / total };
  }
  return out;
}

/**
 * Group accuracy per task — outcomes carry their task label, so no
 * case-id convention is relied on (a renamed id can never silently
 * vanish from a task cell).
 */
export function accuracyByTask(
  outcomes: readonly CaseOutcome[],
): { task: DecisionTask; cases: number; accuracy: number | null }[] {
  return (["relevance", "rerank", "citation"] as const).map((task) => {
    const cells = outcomes.filter((o) => o.task === task);
    return {
      task,
      cases: cells.length,
      accuracy: cells.length === 0 ? null : cells.filter((o) => o.passed).length / cells.length,
    };
  });
}

/**
 * Evaluate the gate. Languages with fewer than `minCasesPerLanguage` scored
 * cases do not count for or against the per-language floor (a single-case
 * language would make the floor a coin flip) — but they are reported, so a
 * fixture that silently drops a language is visible in the report.
 */
export function evaluateDecisionGate(outcomes: readonly CaseOutcome[]): DecisionGate {
  const overall = meanAccuracy(outcomes);
  const perLanguage = accuracyByLanguage(outcomes);
  const failedLanguages = Object.entries(perLanguage)
    .filter(([lang, cell]) => cell.cases >= DECISION_GATE_FLOORS.minCasesPerLanguage)
    .filter(([lang, cell]) => cell.accuracy < DECISION_GATE_FLOORS.perLanguage)
    .map(([lang]) => lang);
  return {
    overallPass: (overall ?? 0) >= DECISION_GATE_FLOORS.overall,
    failedLanguages,
    gatePass: (overall ?? 0) >= DECISION_GATE_FLOORS.overall && failedLanguages.length === 0,
  };
}

export type { DecisionBenchPrompts };

/** The pure answer-reading logic, exported so tests pin the math. */
export function scoreRelevanceAnswer(noul: number | undefined, relevant: boolean): boolean {
  if (noul === undefined || !Number.isFinite(noul)) return false;
  return relevant ? noul >= 0.5 : noul < 0.5;
}

export function scoreRerankAnswer(choice: string | undefined, bestIndex: number): boolean {
  return choice === `c${bestIndex}`;
}

export function scoreCitationAnswer(noul: number | undefined, supports: boolean): boolean {
  if (noul === undefined || !Number.isFinite(noul)) return false;
  return supports ? noul >= 0.5 : noul < 0.5;
}

/** Run one full bench through a Decider; every call's cost is surfaced. */
export async function runDecisionBench({
  decider,
  fixture,
  prompts,
  onCost,
  wouldExceed,
  log,
}: {
  decider: Decider;
  fixture: DecisionBenchFixture;
  prompts: DecisionBenchPrompts;
  onCost: (cost: CostRecord) => void;
  wouldExceed: () => boolean;
  log?: { warn: (msg: string, fields?: Record<string, unknown>) => void };
}): Promise<CaseOutcome[]> {
  const outcomes: CaseOutcome[] = [];

  // One Noul question per case; the answer is read through the seam's typed
  // union — no re-cast of the wire shape.
  const runNoul = async (
    task: "relevance" | "citation",
    c: { id: string; language: string },
    state: Record<string, unknown>,
    question: { instructions: string; criteria: { true: string; false: string } },
    key: string,
    expected: boolean,
    score: (noul: number | undefined) => boolean,
  ) => {
    if (wouldExceed()) {
      log?.warn("budget cap hit — bench aborted", { caseId: c.id });
      return;
    }
    const result = await Effect.runPromise(
      decider.decide({
        state,
        questions: {
          [key]: { type: "noul", instructions: question.instructions, criteria: question.criteria },
        },
      }),
    );
    onCost(result.cost);
    const answer = result.answers[key];
    const noul = answer?.type === "noul" ? answer.noul : undefined;
    outcomes.push({
      caseId: c.id,
      task,
      language: c.language,
      expected,
      got: noul ?? "n/a",
      passed: score(noul),
    });
  };

  for (const c of fixture.relevance) {
    await runNoul(
      "relevance",
      c,
      { query: c.query, passage: c.passage },
      { instructions: prompts.relevance.instructions(c), criteria: prompts.relevance.criteria },
      "relevant",
      c.relevant,
      (noul) => scoreRelevanceAnswer(noul, c.relevant),
    );
  }

  for (const c of fixture.rerank) {
    if (wouldExceed()) {
      log?.warn("budget cap hit — bench aborted", { caseId: c.id });
      continue;
    }
    const criteria: Record<string, string | null> = {};
    c.candidates.forEach((_, i) => {
      criteria[`c${i}`] = null;
    });
    const result = await Effect.runPromise(
      decider.decide({
        state: { query: c.query, candidates: c.candidates },
        questions: {
          best: {
            type: "choice",
            instructions: prompts.rerank.instructions(c),
            criteria: { ...criteria, ...prompts.rerank.criteria(c) },
          },
        },
      }),
    );
    onCost(result.cost);
    const answer = result.answers.best;
    const choice = answer?.type === "choice" ? answer.choice : undefined;
    outcomes.push({
      caseId: c.id,
      task: "rerank",
      language: c.language,
      expected: `c${c.bestIndex}`,
      got: choice ?? "n/a",
      passed: scoreRerankAnswer(choice, c.bestIndex),
    });
  }

  for (const c of fixture.citation) {
    await runNoul(
      "citation",
      c,
      { claim: c.claim, passage: c.passage },
      { instructions: prompts.citation.instructions(c), criteria: prompts.citation.criteria },
      "supports",
      c.supports,
      (noul) => scoreCitationAnswer(noul, c.supports),
    );
  }

  return outcomes;
}
