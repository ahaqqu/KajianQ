/**
 * The study's model-call budget. The $50 cap is spent quality-first; what binds a
 * paid arm is the pre-registered call ceiling, because a runaway loop has no other
 * mechanical brake. The ceiling is enforced before a request is issued, so the
 * runner stops at the call, not at the invoice.
 */

/** Hard ceiling for the S1 model arm. No CLI flag may raise it. */
export const S1_MODEL_CALL_CEILING = 6000;

export class ModelCallCeilingError extends Error {
  readonly calls: number;
  readonly ceiling: number;

  constructor(calls: number, ceiling: number) {
    super(`model call ceiling reached (${calls}/${ceiling})`);
    this.name = "ModelCallCeilingError";
    this.calls = calls;
    this.ceiling = ceiling;
  }
}

export type CallBudget = {
  readonly ceiling: number;
  readonly calls: number;
  /** Reserve one call; throws before the call when the ceiling is already spent. */
  take(): void;
  remaining(): number;
};

export function createCallBudget(ceiling: number): CallBudget {
  if (!Number.isInteger(ceiling) || ceiling < 1) {
    throw new Error(`call budget needs a positive integer ceiling, got ${ceiling}`);
  }
  let calls = 0;
  return {
    ceiling,
    get calls(): number {
      return calls;
    },
    take(): void {
      if (calls >= ceiling) throw new ModelCallCeilingError(calls, ceiling);
      calls += 1;
    },
    remaining(): number {
      return ceiling - calls;
    },
  };
}

/**
 * Validate a requested ceiling. A request above the hard ceiling is an error, not
 * a silent clamp: raising the study budget is a code change with an owner decision,
 * never a flag an unattended run can set.
 */
export function resolveCallCeiling(requested: number | undefined): number {
  if (requested === undefined) return S1_MODEL_CALL_CEILING;
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error(`--max-calls must be a positive integer, got ${requested}`);
  }
  if (requested > S1_MODEL_CALL_CEILING) {
    throw new Error(`--max-calls ${requested} exceeds the hard ceiling ${S1_MODEL_CALL_CEILING}`);
  }
  return requested;
}
