/**
 * The error the barrel gate throws, stated once so the loader and the rules hand
 * the caller the same shape: a message naming the module, the name and the loader's
 * own error where it had one — never a bare stack trace.
 */

/** The error a caller sees; `message` carries the file and line it was found at. */
export class ContractsBarrelError extends Error {}
