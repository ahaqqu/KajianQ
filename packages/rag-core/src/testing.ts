import { Cause, Effect, Exit, Option, Result } from "effect";

/**
 * Shared Effect test utilities (the `./testing` export).
 *
 * The failure-extraction idiom lives in exactly one place because it is
 * version-sensitive: Effect v4 replaced v3's `Cause.failureOption` with
 * `Cause.findFail` — a `Result` whose success carries the first typed `Fail`
 * reason (ADR-0027 Appendix C). The next Effect rename that touches this
 * idiom is a one-site change, not a sweep across every suite.
 */

/**
 * Extract the first typed failure from an exit; `none` when the exit
 * succeeded (or failed without a typed `Fail` reason, e.g. pure interrupt).
 */
export const failureOf = <E>(exit: Exit.Exit<unknown, E>): Option.Option<E> => {
  if (Exit.isFailure(exit)) {
    const fail = Cause.findFail(exit.cause);
    if (Result.isSuccess(fail)) return Option.some(fail.success.error);
  }
  return Option.none<E>();
};

/**
 * Run an effect that must fail, returning the typed failure itself. Throws
 * when the effect succeeds or fails without a typed failure, so a test
 * cannot silently skip its assertions.
 */
export const runFail = async <A, E>(effect: Effect.Effect<A, E, never>): Promise<E> => {
  const failure = failureOf(await Effect.runPromiseExit(effect));
  if (Option.isNone(failure)) throw new Error("expected the effect to fail");
  return failure.value;
};
