/**
 * How the ingestion CLI reports a failure.
 *
 * A `StoreError` is an `Error` whose `message` is empty: the reason lives in its
 * `kind` and in the wrapped `cause`. The CLI prints this description instead of
 * `error.message`, so a pending migration reads as a schema error naming the
 * missing table, a bad password reads as a config error, and no failure ever
 * reaches the operator as a blank line. The cause chain is walked a few levels so
 * a driver error wrapped inside another still names itself.
 */

import { StoreError } from "@app/infra";

const CAUSE_DEPTH = 3;

/** The text of one thrown value, including its Postgres SQLSTATE when it carries one. */
function causeText(cause: unknown, depth = 0): string {
  if (cause === undefined || cause === null) return "no cause";
  if (typeof cause === "string") return cause.trim() === "" ? "(blank cause)" : cause;
  if (cause instanceof Error) {
    const message = cause.message.trim() === "" ? cause.name : cause.message;
    const code = (cause as Error & { code?: unknown }).code;
    const withCode =
      typeof code === "string" && code.trim() !== "" ? `${message} (code ${code})` : message;
    const nested = (cause as Error & { cause?: unknown }).cause;
    if (nested === undefined || nested === cause || depth >= CAUSE_DEPTH) return withCode;
    return `${withCode} — caused by: ${causeText(nested, depth + 1)}`;
  }
  try {
    return JSON.stringify(cause) ?? String(cause);
  } catch {
    return String(cause);
  }
}

/** A non-empty, kind-bearing description of any thrown value. */
export function describeIngestError(error: unknown): string {
  if (error instanceof StoreError) {
    return `StoreError (${error.kind}): ${causeText(error.cause)}`;
  }
  if (error instanceof Error) {
    return error.message.trim() === "" ? error.name : error.message;
  }
  return causeText(error);
}
