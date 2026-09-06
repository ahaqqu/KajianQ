import { Duration, Effect, Schedule, ScheduleDecision, ScheduleInterval } from "effect";
import type { ProviderError } from "@app/rag-core";

/**
 * Retry/backoff policy for the provider fallback chain (ADR-0027 need 2).
 *
 * Policy shape (single anchorable definition, review C1):
 * - `rate_limited` — base 500 ms, doubling, max 2 retries per candidate: the
 *   vendor asked us to slow down, so back off slower and stop earlier.
 * - `transport` and `server` faults — base 50 ms, doubling, max 3 retries
 *   per candidate: transient I/O deserves a faster, larger budget.
 * - `bad_request` and `exhausted` — never retried: a malformed call or an
 *   exhausted chain will not improve by trying again.
 *
 * The checked-in default is `defaultRetrySchedule` (`perKindRetrySchedule(
 * "500 millis", "50 millis")`); wiring can override it per call site through
 * `ResolveOptions.retrySchedule` (tests inject a fast policy; production
 * keeps the default until per-vendor fields exist in the provider config
 * JSON). Per-vendor policy in config is a deliberate follow-up: it needs
 * `VendorSchema` fields validated at wiring time, not a silent code default.
 */

/**
 * The retry budget of one error kind: a base delay doubled on each retry of
 * that kind, capped at `maxRetries` attempts of that kind.
 */
type KindBudget = {
  kinds: readonly string[];
  base: Duration.DurationInput;
  maxRetries: number;
};

/**
 * Per-kind retry policy for one candidate. A `rate_limited` candidate backs
 * off slower and fewer times (the vendor asked us to slow down); transport
 * and server faults retry faster; `bad_request`/`exhausted` never retry.
 * Tests inject a faster schedule via `ResolveOptions.retrySchedule`.
 *
 * Implemented as one custom schedule rather than a union of `whileInput`
 * filters: in effect 3.22 a `whileInput` step advances its underlying arm
 * *before* testing the predicate, and a union persists both arms' state, so
 * errors of one kind would silently consume the other kind's budget
 * (review A2 — two transport faults followed by a 429 left the 429 with zero
 * retries). Here the kind is dispatched *before* any state advances, so each
 * kind's budget is consumed only by errors of that kind, and an error whose
 * kind matches no budget ends the retry immediately.
 */
export const perKindRetrySchedule = (
  rateLimitedBase: Duration.DurationInput,
  faultBase: Duration.DurationInput,
): Schedule.Schedule<unknown, ProviderError> => {
  const budgets: readonly KindBudget[] = [
    { kinds: ["rate_limited"], base: rateLimitedBase, maxRetries: 2 },
    { kinds: ["transport", "server"], base: faultBase, maxRetries: 3 },
  ];
  // State: one attempt counter per budget, indexed by budget. A kind that
  // matches no budget has no counter and never retries.
  return Schedule.makeWithState<ReadonlyArray<number>, ProviderError, unknown>(
    budgets.map(() => 0),
    (now, err, counts) => {
      const index = budgets.findIndex((b) => b.kinds.includes(err.kind));
      if (index < 0) {
        return Effect.succeed([counts, undefined, ScheduleDecision.done] as const);
      }
      const budget = budgets[index];
      const attempt = counts[index] ?? 0;
      if (budget === undefined || attempt >= budget.maxRetries) {
        return Effect.succeed([counts, undefined, ScheduleDecision.done] as const);
      }
      const baseMs = Duration.toMillis(budget.base);
      const delayMs = baseMs * 2 ** attempt;
      const next = counts.slice();
      next[index] = attempt + 1;
      return Effect.succeed([
        next,
        undefined,
        ScheduleDecision.continueWith(ScheduleInterval.after(now + delayMs)),
      ] as const);
    },
  );
};

/** The checked-in default retry policy (see the policy shape above). */
export const defaultRetrySchedule: Schedule.Schedule<unknown, ProviderError> = perKindRetrySchedule(
  "500 millis",
  "50 millis",
);
