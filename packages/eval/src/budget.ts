/**
 * Budget accumulator (#8): the hard env cap `EVAL_BUDGET_MICRO_USD` covering
 * BOTH the harness's own LLM calls and the pipeline costs recorded in each
 * answer trace it triggers. Exceeding the cap aborts the run — spend over a
 * budget is a defect, not a warning.
 */

export class BudgetExceededError extends Error {
  constructor(
    readonly capMicroUsd: number,
    readonly spentMicroUsd: number,
  ) {
    super(
      `eval budget exceeded: spent ${spentMicroUsd} of ${capMicroUsd} micro-USD — aborting run`,
    );
  }
}

export type BudgetInput = {
  /** Hard cap in micro-USD; undefined/0 = unlimited (explicit opt-out). */
  capMicroUsd?: number;
};

export class Budget {
  private spent = 0;

  constructor(private readonly capMicroUsd?: number) {}

  /** Record spend; returns the running total. */
  add(costMicroUsd: number): number {
    this.spent += costMicroUsd;
    return this.spent;
  }

  /** Total recorded spend so far. */
  get total(): number {
    return this.spent;
  }

  /** Whether recording `additional` would exceed the cap (when capped). */
  wouldExceed(additional = 0): boolean {
    if (this.capMicroUsd === undefined || this.capMicroUsd <= 0) return false;
    return this.spent + additional > this.capMicroUsd;
  }

  /**
   * Throw `BudgetExceededError` when the cap is hit; the harness checks this
   * before each question and after each cost record.
   */
  check(additional = 0): void {
    if (this.wouldExceed(additional)) {
      throw new BudgetExceededError(this.capMicroUsd ?? 0, this.spent);
    }
  }
}

/** Parse the env cap (micro-USD, integer). Absent/empty = unlimited. */
export function budgetCapFromEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`EVAL_BUDGET_MICRO_USD must be a non-negative integer, got "${raw}"`);
  }
  return n;
}
