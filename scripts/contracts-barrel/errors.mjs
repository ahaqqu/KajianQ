/**
 * The error the barrel gate throws, stated once so the scanner, the statement
 * reader and the rules all hand the caller the same shape: a message naming what
 * was read and where, never a bare parse slip or a stack trace.
 */

/** The error a caller sees; `message` carries the file and line it was found at. */
export class ContractsBarrelError extends Error {}
