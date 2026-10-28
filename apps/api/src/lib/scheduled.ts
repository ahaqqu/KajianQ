import { createLogger } from "@app/infra";
import type { RagStore } from "@app/infra";
import type { StoreBridge } from "@app/kajianq-domain";
import { createRagStoreFromEnv, ChatConfigError } from "./chat-wiring";

/**
 * The anonymous-session reclamation body (ADR-0017; ADR-0044 decision 6):
 * expire sessions on a schedule.
 *
 * Expiry is a storage-reclamation concern, not a correctness one —
 * `resolveUserId` already rejects expired rows on read — so a failed cleanup
 * must never take serving down or page anyone: it logs and returns.
 *
 * Runtime-agnostic by design: the schedule's source of truth is the systemd
 * timer `provision/vps/systemd/kajianq-cron.timer` (the retention value the
 * privacy notice's "30-day inactivity" row depends on), whose
 * `kajianq-cron.service` invokes the dedicated entry
 * `apps/api/src/cleanup.ts`, which calls this function. Verification of that
 * retention value starts at the timer, not here.
 *
 * Kept as its own injectable-deps module so the behavior is unit-testable
 * without a host runtime: `deps` lets a test supply the store + bridge (the
 * production defaults are the real wiring).
 */

export type ScheduledEnv = Record<string, string | undefined>;

/** One retention call's Effect, as the seam spells it — the store owns the type, so this
 * module never names the effect runtime. */
type RetentionCall = ReturnType<RagStore["cleanupExpiredSessions"]>;

export type ScheduledResult = {
  /** Rows removed, or null when the store was not configured / the call failed. */
  deleted: number | null;
  /** Admin access records past the retention window that were removed, or null on a
   * failure — the log's own window, applied by the store (ADR-0064). */
  adminLogDeleted: number | null;
  /** Revoked admin sessions whose token had already expired, or null on a failure.
   * The denylist's rows are reclaimable on the token's own schedule. */
  revocationsDeleted: number | null;
  ok: boolean;
};

export type ScheduledDeps = {
  /** Resolve the store from env; defaults to the real `RagStore` wiring. */
  createStore?: (env: ScheduledEnv) => RagStore;
  /** Bridge one store Effect to a promise; defaults to the domain's runner. */
  runStore?: StoreBridge;
};

/**
 * Delete session rows whose TTL has passed. Returns a summary rather than
 * throwing: the scheduled path has no client to fail to.
 */
export async function cleanupExpiredSessions(
  env: ScheduledEnv,
  deps: ScheduledDeps = {},
): Promise<ScheduledResult> {
  const logger = createLogger({ service: "api", route: "scheduled" });
  const createStore = deps.createStore ?? createRagStoreFromEnv;
  let store: RagStore;
  try {
    store = createStore(env);
  } catch (err) {
    if (err instanceof ChatConfigError) {
      // No database binding in this environment (local dev, an environment without
      // a configured store): the feature is disabled, not broken.
      logger.warn("scheduled.cleanup_skipped", { missing: err.missing ?? "unknown" });
      return { deleted: null, adminLogDeleted: null, revocationsDeleted: null, ok: false };
    }
    throw err;
  }
  // The store's Effect signature bridges here through the domain's runner (the API's
  // single effect bridge point, ADR-0027 decision 3). Imported lazily so the
  // entrypoint's cold-start path does not pull the domain in.
  const runStore = deps.runStore ?? (await import("@app/kajianq-domain")).runStoreEffect;

  /**
   * One retention step, with its OWN error boundary: the two windows are independent
   * obligations, and a persistent fault in the session cleanup must not silently stop
   * enforcing the access log's published 90 days. A failed or non-numeric step is
   * logged and reported as null (a store that resolves to a non-number is a contract
   * violation worth seeing, not a count to report as "0 removed"), never thrown.
   */
  const step = async (
    effect: RetentionCall,
    names: { failed: string; unexpected: string; done: string },
  ): Promise<number | null> => {
    try {
      const removed = await runStore(effect);
      if (typeof removed !== "number") {
        logger.error(names.unexpected, { value: String(removed) });
        return null;
      }
      logger.info(names.done, { deleted: removed });
      return removed;
    } catch (err) {
      // A transient store fault must not fail the cron run, and must not stop the
      // other retention step: log and let the next tick retry (the rows are still
      // there, still harmless).
      logger.error(names.failed, {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };

  const deleted = await step(store.cleanupExpiredSessions(), {
    failed: "scheduled.cleanup_failed",
    unexpected: "scheduled.cleanup_unexpected_result",
    done: "scheduled.sessions_cleaned",
  });
  // The admin access log's retention window, applied by the store's own guard: an
  // append-only table whose published retention is only true if something deletes by
  // it. It runs whatever the session cleanup answered.
  const adminLogDeleted = await step(store.purgeAdminAccessLog(), {
    failed: "scheduled.admin_log_failed",
    unexpected: "scheduled.admin_log_unexpected_result",
    done: "scheduled.admin_log_purged",
  });
  // The revocation denylist's expired rows. Same independent boundary as the log: a
  // logout must not stop working because an earlier purge fault persisted, and the rows
  // are harmless while they wait for the next tick.
  const revocationsDeleted = await step(store.purgeAdminSessionRevocations(), {
    failed: "scheduled.admin_session_revocations_failed",
    unexpected: "scheduled.admin_session_revocations_unexpected_result",
    done: "scheduled.admin_session_revocations_purged",
  });
  return {
    deleted,
    adminLogDeleted,
    revocationsDeleted,
    ok: deleted !== null && adminLogDeleted !== null && revocationsDeleted !== null,
  };
}
