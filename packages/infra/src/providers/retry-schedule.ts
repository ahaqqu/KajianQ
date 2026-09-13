import { Cause, Duration, Effect, Schedule } from "effect";
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
  base: Duration.Input;
  maxRetries: number;
};

/** Per-kind retry counts; the interactive defaults are the fallbacks. */
export type RetryBudgets = {
  /** Retries for `rate_limited` (default 2 — ≈1.5 s of backoff). */
  rateLimitedRetries?: number;
  /** Retries for `transport`/`server` (default 3). */
  faultRetries?: number;
};

/**
 * Per-kind retry policy for one candidate. A `rate_limited` candidate backs
 * off slower and fewer times (the vendor asked us to slow down); transport
 * and server faults retry faster; `bad_request`/`exhausted` never retry.
 * Tests inject a faster schedule via `ResolveOptions.retrySchedule`.
 *
 * Implemented as one custom schedule rather than a union of predicate-filtered
 * schedules: a unioned arm advances its own state even when the *other* arm's
 * predicate matched, so errors of one kind would silently consume the other
 * kind's budget (review A2 — two transport faults followed by a 429 left the
 * 429 with zero retries). Here the kind is dispatched *before* any state
 * advances, so each kind's budget is consumed only by errors of that kind, and
 * an error whose kind matches no budget ends the retry immediately.
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
  // State: the attempt counter lives on the budget entry itself, so a kind
  // that matches no budget has no entry and never retries — the single
  // `undefined` guard below IS that invariant, not defensiveness. Effect v4
  // builds custom schedules on `Schedule.fromStep` (the v3 `makeWithState` /
  // `ScheduleDecision` / `ScheduleInterval` API is gone): the step effect
  // runs once per retry driver, so the counters are fresh per run, each step
  // returns the next `[output, delay]` pair, and completion is `Cause.done`.
  return Schedule.fromStep(
    Effect.sync(() => {
      const state = perKind.map((budget) => ({ budget, attempts: 0 }));
      return (_now: number, err: ProviderError) => {
        const entry = state.find((e) => e.budget.kinds.includes(err.kind));
        if (entry === undefined || entry.attempts >= entry.budget.maxRetries) {
          return Cause.done(undefined);
        }
        // v3's makeWithState threaded the state through the return tuple;
        // the v4 closure holds it, so the counter mutates in place (the
        // step effect re-runs per retry driver, giving fresh counters).
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

/** The checked-in default retry policy (see the policy shape above). */
export const defaultRetrySchedule: Schedule.Schedule<unknown, ProviderError> = perKindRetrySchedule(
  "500 millis",
  "50 millis",
);

/**
 * The batch-job retry policy (`ResolveOptions.retrySchedule` at an offline
 * call site: the corpus ingest CLIs).
 *
 * Why it differs from the interactive default: to a chat request a 429 means
 * "come back later", and ≈1.5 s of backoff is the right answer — a user is
 * waiting. To a batch job the same 429 usually means "you hit the vendor's
 * per-minute window", which clears in tens of seconds; giving up after 1.5 s
 * throws the whole run away. That is not hypothetical: the staging corpus
 * ingest died on its **first** embedding batch when the free tier's
 * per-minute token window was exceeded, after roughly 1.5 s of retries.
 *
 * Budget: a rate-limited candidate gets 5 s, 10 s, 20 s, 40 s, 80 s — 155 s of
 * backoff, which rides out a per-minute window while still failing a genuine
 * quota exhaustion (a daily cap, a revoked plan) in minutes rather than
 * hanging. Transport/server faults keep a short base with one extra try.
 */
/**
 * The batch policy's per-kind budgets, as data: a test can pin the numbers
 * without sleeping through 155 s of real backoff, and an operator can read the
 * policy without decoding the schedule combinator.
 */
export const BATCH_RETRY_BUDGETS: Required<RetryBudgets> = {
  rateLimitedRetries: 5,
  faultRetries: 5,
};

export const batchRetrySchedule: Schedule.Schedule<unknown, ProviderError> = perKindRetrySchedule(
  "5 seconds",
  "250 millis",
  BATCH_RETRY_BUDGETS,
);
