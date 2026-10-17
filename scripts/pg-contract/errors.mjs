/**
 * The errors the contract gate throws, stated once so the policy, the report reader
 * and the driver all hand the caller the same shape: a message and an exit code,
 * never a bare stack trace.
 */

/** The error a caller sees; never a bare stack trace. */
export class PgContractError extends Error {
  /** 1 marks a failing gate; 2 marks usage or unreadable input. */
  exitCode = 1;
}

/** Raised by the driver's argument parsing: a usage error, not a failing gate. */
export class UsageError extends PgContractError {
  exitCode = 2;
}
