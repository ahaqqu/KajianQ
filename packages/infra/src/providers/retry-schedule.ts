import { Cause, Duration, Effect, Schedule } from "effect";
import type { ProviderError } from "@app/rag-core";

/**
 * Retry/backoff policy for the provider fallback chain.
 *
 * Policy shape:
 * - `rate_limited` — base 500 ms, doubling, max 2 retries per candidate: the
 *   vendor asked us to slow down, so back off slower and stop earlier.
 * - `transport` and `server` faults — base 50 ms, doubling, max 3 retries
 *   per candidate: transient I/O deserves a faster, larger budget.
 * - `bad_request` and `exhausted` — never retried: a malformed call or an
 *   exhausted chain will not improve by trying again.
 *
 * The checked-in default is `defaultRetrySchedule` (`perKindRetrySchedule(
 * "500 millis", "50 millis")`); wiring can override it per call site through
 * `ResolveOptions.retrySchedule`.
 */

/** The retry budget of one error kind: a base delay doubled per retry, capped at `maxRetries`. */
type KindBudget = {
  kinds: readonly string[];
  base: Duration.Input;
  maxRetries: number;
};

/** Per-kind retry counts; the interactive defaults are the fallbacks. */
export type RetryBudgets = {
  /** Retries for `rate_limited` (default 2). */
  rateLimitedRetries?: number;
  /** Retries for `transport`/`server` (default 3). */
  faultRetries?: number;
};

/**
 * Per-kind retry policy for one candidate: the kind is dispatched before any
 * state advances, so each kind's budget is consumed only by errors of that
 * kind, and an error whose kind matches no budget ends the retry immediately.
 */
export const perKindRetrySchedule = (
  rateLimitedBase: Duration.Input,
  faultBase: Duration.Input,
  budgets: RetryBudgets = {},
): Schedule.Schedule<unknown, ProviderError> => {
  const perKind: readonly KindBudget[] = [
    { kinds: ["rate_limited"], base: rateLimitedBase, maxRetries: budgets.rateLimitedRetries ?? 2 },
    { kinds: ["transport", "server"], base: faultBase, maxRetries: budgets.faultRetries ?? 3 },
  ];
  // The attempt counter lives on the budget entry itself, so a kind that
  // matches no budget has no entry and never retries — the `undefined` guard
  // below IS that invariant. The step effect re-runs per retry driver, so the
  // counters are fresh per run.
  return Schedule.fromStep(
    Effect.sync(() => {
      const state = perKind.map((budget) => ({ budget, attempts: 0 }));
      return (_now: number, err: ProviderError) => {
        const entry = state.find((e) => e.budget.kinds.includes(err.kind));
        if (entry === undefined || entry.attempts >= entry.budget.maxRetries) {
          return Cause.done(undefined);
        }
        const delayMs = Duration.toMillis(entry.budget.base) * 2 ** entry.attempts;
        entry.attempts += 1;
        return Effect.succeed([undefined, Duration.millis(delayMs)] as [
          undefined,
          Duration.Duration,
        ]);
      };
    }),
  );
};

/** The checked-in default retry policy. */
export const defaultRetrySchedule: Schedule.Schedule<unknown, ProviderError> = perKindRetrySchedule(
  "500 millis",
  "50 millis",
);

/**
 * The batch-job retry policy (`ResolveOptions.retrySchedule` at an offline
 * call site: the corpus ingest CLIs).
 *
 * Why it differs from the interactive default: to a chat request a 429 means
 * "come back later" and a short backoff is right, since a user is waiting. To
 * a batch job the same 429 usually means the vendor's per-minute window,
 * which clears in tens of seconds; a rate-limited candidate therefore gets a
 * 5 s base with 5 retries, riding that window out while still failing a
 * genuine quota exhaustion (a daily cap, a revoked plan) in minutes rather
 * than hanging. Transport/server faults keep a short base.
 */
/** The batch policy's per-kind budgets, as data for tests and operators. */
export const BATCH_RETRY_BUDGETS: Required<RetryBudgets> = {
  rateLimitedRetries: 5,
  faultRetries: 5,
};

export const batchRetrySchedule: Schedule.Schedule<unknown, ProviderError> = perKindRetrySchedule(
  "5 seconds",
  "250 millis",
  BATCH_RETRY_BUDGETS,
);
