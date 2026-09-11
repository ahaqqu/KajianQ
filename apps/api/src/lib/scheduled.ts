import { createLogger } from "@app/infra";
import { createRagStoreFromEnv, ChatConfigError } from "./chat-wiring";

/**
 * The Worker's scheduled handler body (ADR-0017, ticket #10): expire
 * anonymous sessions on a cron.
 *
 * Expiry is a storage-reclamation concern, not a correctness one —
 * `resolveUserId` already rejects expired rows on read — so a failed cleanup
 * must never take the Worker down or page anyone: it logs and returns. The
 * cron expression lives in the deploy topology (`apps/api/alchemy.run.ts`).
 *
 * Kept out of `index.ts` so the behavior is unit-testable without a Worker
 * runtime: the entrypoint wires this function to Cloudflare's event shape.
 */

export type ScheduledEnv = Record<string, string | undefined>;

export type ScheduledResult = {
  /** Rows removed, or null when the store was not configured / the call failed. */
  deleted: number | null;
  ok: boolean;
};

/**
 * Delete session rows whose TTL has passed. Returns a summary rather than
 * throwing: the scheduled path has no client to fail to.
 */
export async function cleanupExpiredSessions(env: ScheduledEnv): Promise<ScheduledResult> {
  const logger = createLogger({ service: "api", route: "scheduled" });
  let store;
  try {
    store = createRagStoreFromEnv(env);
  } catch (err) {
    if (err instanceof ChatConfigError) {
      // No database binding in this environment (local dev, a stage without
      // Neon): the feature is disabled, not broken.
      logger.warn("scheduled.cleanup_skipped", { missing: err.missing ?? "unknown" });
      return { deleted: null, ok: false };
    }
    throw err;
  }
  try {
    // The store's Effect signature bridges here through the domain's runner
    // (the API's single effect bridge point, ADR-0027 decision 3).
    const { runStoreEffect } = await import("@app/kajianq-domain");
    const deleted = await runStoreEffect<number>(store.cleanupExpiredSessions());
    logger.info("scheduled.sessions_cleaned", { deleted });
    return { deleted, ok: true };
  } catch (err) {
    // A transient Neon fault must not fail the cron run: log and let the next
    // tick retry (the rows are still there, still harmless).
    logger.error("scheduled.cleanup_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { deleted: null, ok: false };
  }
}
