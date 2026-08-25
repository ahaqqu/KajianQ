import type { Logger } from "./logger";
import type { SqlRunner } from "./rag-store-neon";

/**
 * Operational logging wiring for the Neon RagStore adapter (issue #63 item 5),
 * kept out of the adapter proper so its import surface stays small and the
 * default path stays dependency-free.
 */

/** Default threshold above which a query logs a `slow_query` warning. */
export const DEFAULT_SLOW_QUERY_MS = 1_000;

/**
 * Optional operational wiring for the Neon adapter. Both knobs default to
 * "off": with no `logger` the adapter is fully silent, so it stays usable in
 * tests and in consumers that do their own observability.
 */
export type NeonRagStoreOptions = {
  /**
   * Structured logger for slow/failed queries (ops observability). This is
   * deliberately NOT the answer Trace (ADR-0007): log fields carry only the
   * operation kind and duration — never SQL text or bound values, so no user
   * content can leak into logs through this path.
   */
  logger?: Logger;
  /** Queries taking ≥ this many ms log a warn. Default: 1000 ms. */
  slowQueryMs?: number;
};

/**
 * Wrap a runner so each call records its duration, warning on slow queries
 * and logging-then-rethrowing failures. Fields are bounded to `{op, ms}` by
 * design; the error object itself is not serialized into fields.
 */
export function instrumentRunner(
  sql: SqlRunner,
  logger: Logger,
  slowQueryMs: number,
): SqlRunner {
  const timed = async (
    op: string,
    run: () => Promise<unknown[]>,
  ): Promise<unknown[]> => {
    const startedAt = Date.now();
    try {
      const rows = await run();
      const ms = Date.now() - startedAt;
      if (ms >= slowQueryMs) {
        logger.warn("rag_store.slow_query", { op, ms });
      }
      return rows;
    } catch (error) {
      logger.error("rag_store.query_failed", {
        op,
        ms: Date.now() - startedAt,
      });
      throw error;
    }
  };
  const instrumented = ((strings, ...values) =>
    timed("template", () => sql(strings, ...values))) as SqlRunner;
  instrumented.query = (text, params) =>
    timed("query", () => sql.query(text, params));
  instrumented.transaction = (queries) =>
    timed("transaction", () => sql.transaction(queries));
  return instrumented;
}
