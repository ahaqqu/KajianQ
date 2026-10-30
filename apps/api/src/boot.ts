#!/usr/bin/env bun
/**
 * boot.ts — the Bun serving entry point (ADR-0044).
 *
 *   bun run apps/api/src/boot.ts
 *
 * This is what the host configuration's `kajianq-api.service` (ahaqqu/vps)
 * executes on the VPS: a plain Bun server behind nginx.
 * Configuration comes from the environment, which systemd supplies through
 * `EnvironmentFile=/etc/kajianq/api.env` — no secret is ever an argv value.
 *
 * The process exits non-zero on a bind failure so systemd's `Restart=on-failure`
 * takes over rather than leaving a half-configured instance up.
 */
import { createLogger, type Logger } from "@app/infra";
import { createApi } from "./app";
import { bootSequence, type BootHandle } from "./lib/boot-sequence";
import { syncModelConfigMirror } from "./lib/model-config-boot";
import { serveApi } from "./lib/server";

export type StartApiDeps = {
  sync?: (env: Record<string, string | undefined>) => Promise<unknown>;
  serve?: () => BootHandle;
  logger?: Logger;
  timeoutMs?: number;
};

/**
 * The process's one boot ordering: the `model_configs` mirror sync runs — bounded by
 * `MODEL_CONFIG_BOOT_TIMEOUT_MS` — before the socket binds, so an admin read never
 * starts against a mirror the deployment has not populated and a hung store cannot
 * keep the process alive without a listener. A store fault is logged by the sync and
 * does not block serving: the admin detail refuses a mirror that disagrees with the
 * config, so stale identity/price is unreadable rather than silently served.
 *
 * Exported so a test can observe the ordering without binding a socket; the process
 * entry below is the only thing `import.meta.main` runs.
 */
export async function startApi(
  env: Record<string, string | undefined> = process.env,
  deps: StartApiDeps = {},
): Promise<BootHandle> {
  const logger = deps.logger ?? createLogger({ service: "api", route: "bootstrap" });
  return bootSequence({
    env,
    // One logger for the boot and the sync, so `model_config.*` and the ordering log
    // land in the same stream.
    sync: deps.sync ?? ((syncEnv) => syncModelConfigMirror(syncEnv, { logger })),
    serve: deps.serve ?? (() => serveApi({ api: createApi() })),
    logger,
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
  });
}

if (import.meta.main) {
  const { stop } = await startApi();

  // SIGTERM is what systemd sends on `systemctl restart` / `stop`. Draining the
  // listener means in-flight answers (SSE streams can run up to the proxy's
  // 300 s read timeout) are allowed to finish instead of being cut mid-answer,
  // bounded by DRAIN_TIMEOUT_MS (server.ts) — the number `kajianq-api.service`'s
  // `TimeoutStopSec=300s` matches, so the restart's ceiling is recorded rather
  // than implied by systemd's 90 s default.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      void stop().then(() => process.exit(0));
    });
  }
}
