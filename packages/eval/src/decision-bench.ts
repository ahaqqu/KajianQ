import type { CitationCase, DecisionBenchFixture, RelevanceCase, RerankCase } from "@app/contracts";
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

/** One scored case: the expected truth, the model's judgment, pass/fail. */
export type CaseOutcome = {
  caseId: string;
  language: string;
  expected: string | number | boolean;
  got: string | number | boolean;
  passed: boolean;
};

/** Accuracy over one task's cases (null when none ran). */
export type TaskCell = {
  task: "relevance" | "rerank" | "citation";
  cases: number;
  accuracy: number | null;
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

/** Instruction templates the domain pack supplies (opaque strings here). */
export type DecisionBenchPrompts = {
  relevance: {
    instructions: (c: RelevanceCase) => string;
    criteria: { true: string; false: string };
  };
  rerank: {
    instructions: (c: RerankCase) => string;
    criteria: (c: RerankCase) => Record<string, string | null>;
  };
  citation: {
    instructions: (c: CitationCase) => string;
    criteria: { true: string; false: string };
  };
};
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

  const decide = async (
    id: string,
    language: string,
    state: string | Record<string, unknown> | unknown[],
    questions: Record<string, Parameters<Decider["decide"]>[0]["questions"][string]>,
    read: (
      answers: Record<string, { type: string } & Record<string, unknown>>,
    ) => string | number | boolean | undefined,
    expected: string | number | boolean,
    passed: (got: string | number | boolean | undefined) => boolean,
  ) => {
    if (wouldExceed()) {
      log?.warn("budget cap hit — bench aborted", { caseId: id });
      return;
    }
    const result = await Effect.runPromise(decider.decide({ state, questions }));
    onCost(result.cost);
    const got = read(result.answers as Record<string, { type: string } & Record<string, unknown>>);
    outcomes.push({ caseId: id, language, expected, got: got ?? "n/a", passed: passed(got) });
  };

  for (const c of fixture.relevance) {
    await decide(
      c.id,
      c.language,
      { query: c.query, passage: c.passage },
      {
        relevant: {
          type: "noul",
          instructions: prompts.relevance.instructions(c),
          criteria: prompts.relevance.criteria,
        },
      },
      (answers) => answers.relevant?.["noul"] as number | undefined,
      c.relevant,
      (got) => scoreRelevanceAnswer(got as number | undefined, c.relevant),
    );
  }

  for (const c of fixture.rerank) {
    const criteria: Record<string, string | null> = {};
    c.candidates.forEach((_, i) => {
      criteria[`c${i}`] = null;
    });
    await decide(
      c.id,
      c.language,
      { query: c.query, candidates: c.candidates },
      {
        best: {
          type: "choice",
          instructions: prompts.rerank.instructions(c),
          criteria: { ...criteria, ...prompts.rerank.criteria(c) },
        },
      },
      (answers) => answers.best?.["choice"] as string | undefined,
      `c${c.bestIndex}`,
      (got) => scoreRerankAnswer(got as string | undefined, c.bestIndex),
    );
  }

  for (const c of fixture.citation) {
    await decide(
      c.id,
      c.language,
      { claim: c.claim, passage: c.passage },
      {
        supports: {
          type: "noul",
          instructions: prompts.citation.instructions(c),
          criteria: prompts.citation.criteria,
        },
      },
      (answers) => answers.supports?.["noul"] as number | undefined,
      c.supports,
      (got) => scoreCitationAnswer(got as number | undefined, c.supports),
    );
  }

  return outcomes;
}
