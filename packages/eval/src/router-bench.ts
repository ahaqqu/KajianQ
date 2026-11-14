import type { RouterBenchFixture, RouterCase } from "@app/contracts";
import type { CostRecord, Provider } from "@app/rag-core";
import { Effect } from "effect";

/**
 * Router-bench case loop (ADR-0042 discipline, cheap-role tasks): the
 * domain-agnostic measurement machinery for the router-classification gate.
 * The engine owns the metric math and the case loop; the question text,
 * prior turns, and the intent/category vocabularies arrive from the domain
 * pack's fixture, and the call construction and reply reading arrive as
 * adapters — this module never names a vendor, a model, or an Islamic
 * source, and never re-implements the production prompt (the adapters are
 * the production prompt builder and the production reply reader).
 *
 * Gate floors are the decision bench's (ADR-0042), applied per case: a
 * router that misroutes one language must fail the gate, exactly as a
 * decision model that only judges one language fails its floors.
 */

/** The per-case adapters the composition root supplies from the domain pack. */
export type RouterBenchAdapters = {
  /**
   * The production call builder: turns the router stage would send, with the
   * sampling the stage pins. The bench sends fixture text — never a user's
   * words — so the call is explicitly a non-personal-data caller (ADR-0043).
   */
  buildCall: (c: RouterCase) => {
    turns: readonly { role: string; content: string }[];
    options?: Record<string, unknown>;
  };
  /**
   * The production reply reader: the same path the router stage narrows a
   * raw reply with. `undefined` means the reply was unusable — the state the
   * stage's deterministic fallback covers, and the bench scores as a miss.
   */
  readReply: (text: string) =>
    | {
        intent?: string;
        category?: string;
        needsPrinciple?: boolean;
        principleTags?: readonly string[];
      }
    | undefined;
};

/** One scored case: the asserted expectation, the reply's classification, the verdict. */
export type RouterCaseOutcome = {
  caseId: string;
  language: string;
  expected: string;
  got: string;
  passed: boolean;
  cost?: CostRecord;
};

const NA = "n/a";

/** Score one case: every asserted field must match the reply's classification. */
export function scoreRouterCase(
  expected: RouterCase["expected"],
  reply: ReturnType<RouterBenchAdapters["readReply"]>,
): boolean {
  if (reply === undefined) return false;
  if (reply.intent !== expected.intent) return false;
  if (expected.category !== undefined && reply.category !== expected.category) return false;
  if (expected.needsPrinciple !== undefined && reply.needsPrinciple !== expected.needsPrinciple) {
    return false;
  }
  if (expected.principleTags !== undefined) {
    const got = reply.principleTags ?? [];
    for (const tag of expected.principleTags) {
      if (!got.includes(tag)) return false;
    }
  }
  return true;
}

/** Run one full routing bench through a Provider; every call's cost is surfaced. */
export async function runRouterBench({
  provider,
  fixture,
  adapters,
  onCost,
  onOutcome,
  wouldExceed,
  log,
}: {
  provider: Provider;
  fixture: RouterBenchFixture;
  adapters: RouterBenchAdapters;
  onCost: (cost: CostRecord) => void;
  /** Surfaced per scored case so a caller can preserve partial evidence. */
  onOutcome?: (outcome: RouterCaseOutcome) => void;
  wouldExceed: () => boolean;
  log?: { warn: (msg: string, fields?: Record<string, unknown>) => void };
}): Promise<RouterCaseOutcome[]> {
  const outcomes: RouterCaseOutcome[] = [];

  for (const c of fixture.cases) {
    if (wouldExceed()) {
      log?.warn("budget cap hit — bench aborted", { caseId: c.id });
      break;
    }
    const call = adapters.buildCall(c);
    const result = await Effect.runPromise(
      provider.generate({
        turns: call.turns,
        // Gate fixture text is authored content, never a user's words — the
        // bench is explicitly a non-personal-data caller (ADR-0043).
        personalData: false,
        ...(call.options !== undefined ? { options: call.options } : {}),
      }),
    );
    onCost(result.cost);
    const reply = adapters.readReply(result.text);
    const got =
      reply === undefined
        ? NA
        : JSON.stringify({
            intent: reply.intent ?? null,
            category: reply.category ?? null,
            needsPrinciple: reply.needsPrinciple ?? null,
            principleTags: reply.principleTags ?? null,
          });
    const outcome: RouterCaseOutcome = {
      caseId: c.id,
      language: c.language,
      expected: JSON.stringify(c.expected),
      got,
      passed: scoreRouterCase(c.expected, reply),
      cost: result.cost,
    };
    outcomes.push(outcome);
    onOutcome?.(outcome);
  }

  return outcomes;
}
