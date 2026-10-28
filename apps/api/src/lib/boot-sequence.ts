import type { Logger } from "@app/infra";

/**
 * The boot sequence's one ordering rule (ADR-0022 decision 3): the `model_configs`
 * mirror sync runs, within a bounded wait, BEFORE the socket binds. The admin detail
 * refuses a mirror that disagrees with the config, so the sequence may proceed with an
 * empty or stale mirror — it must not proceed with no listener.
 *
 * The deadline is the process-level bound, not the database's: a store that is
 * unreachable-but-not-failing cannot hold the boot open (the unit is `Type=simple`
 * with `Restart=on-failure`, which never restarts a hung process). The pool's
 * connect/statement timeouts are the complementary half, cancelling the underlying
 * work so it cannot outlive the deadline indefinitely.
 */
export const MODEL_CONFIG_BOOT_TIMEOUT_MS = 5_000;

/** The listener's drain handle, as `serveApi` returns it. */
export type BootHandle = { stop: () => Promise<void> };

export type BootSequenceInput = {
  env: Record<string, string | undefined>;
  /** The boot-time mirror sync: it reports store faults itself; a throw is still bounded. */
  sync: (env: Record<string, string | undefined>) => Promise<unknown>;
  /** Bind the listener. Called once, after the sync settles or its deadline expires. */
  serve: () => BootHandle;
  logger: Logger;
  timeoutMs?: number | undefined;
};

type SyncOutcome = { kind: "settled" } | { kind: "failed"; error: unknown };

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run the sync, then bind. The deadline expires the wait, never the process: a late
 * sync is still awaited by its own handlers (so a rejection cannot surface as an
 * unhandled one) and reports through its own `model_config.*` lines when it lands.
 */
export async function bootSequence(input: BootSequenceInput): Promise<BootHandle> {
  const timeoutMs = input.timeoutMs ?? MODEL_CONFIG_BOOT_TIMEOUT_MS;
  // Start the sync as a promise that ALWAYS has a rejection handler attached: after
  // the deadline it may settle — or reject — with nobody awaiting it.
  const outcome: Promise<SyncOutcome> = Promise.resolve()
    .then(() => input.sync(input.env))
    .then(
      () => ({ kind: "settled" as const }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });
  const result = await Promise.race([outcome, deadline]);
  clearTimeout(timer);
  if (result.kind === "timeout") {
    input.logger.warn("model_config.sync_skipped", { reason: "timeout", timeoutMs });
  } else if (result.kind === "failed") {
    input.logger.error("model_config.sync_failed", {
      reason: "unexpected",
      error: messageOf(result.error),
    });
  }
  return input.serve();
}
