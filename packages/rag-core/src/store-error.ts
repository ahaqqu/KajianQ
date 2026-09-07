import { Data } from "effect";

/**
 * The persistence-seam failure taxonomy (ADR-0027 decision 7), mirroring
 * `ProviderErrorKind`: the engine owns its seam vocabulary, and adapters —
 * not consumers — map vendor exceptions into it. `StoreError` travels in
 * the `E` channel of every `RagStore`/`ObjectStore` method
 * (`Effect<A, StoreError, R>`); no error kind may travel via `throw` across
 * the seam.
 *
 * The taxonomy is CLOSED: exactly these five kinds, each carrying the
 * wrapped original in `cause`. Consumers switch on `kind` — never on
 * adapter classes or vendor exception types, which must not appear in seam
 * signatures at all. A new kind is a seam-contract change that requires an
 * ADR amendment, not a silent union extension.
 */
export type StoreErrorKind =
  /** Network/transport-level failure: connection error, fetch failure, DNS. */
  | "transport"
  /** The operation exceeded its deadline — transient, retryable-with-backoff. */
  | "timeout"
  /**
   * The store rejected the write as a data-integrity violation: a unique or
   * check constraint, a malformed/invalid value (e.g. wrong-dimension
   * vector, unparseable timestamp), or a FK violation. Deterministic: the
   * same input fails again — fix the data, do not retry.
   */
  | "constraint"
  /** The requested row/object/key does not exist (when null is not the answer). */
  | "not_found"
  /** The store is misconfigured: missing credentials, bad endpoint, bad URL. */
  | "config";

/**
 * The typed failure of a persistence-seam call, travelling in the Effect
 * `E` channel (ADR-0027 decision 7). Each kind wraps the original vendor
 * exception in `cause` — the taxonomy is the classification, `cause` is the
 * audit trail; neither replaces the other. Adapters map vendor exceptions
 * (Neon `NeonDbError`/`PostgresError`, S3 `S3ServiceException`, bare
 * `RangeError`s from value validation) into exactly one kind, inside the
 * adapter.
 */
export class StoreError extends Data.TaggedError("StoreError")<{
  readonly kind: StoreErrorKind;
  readonly cause: unknown;
}> {}
