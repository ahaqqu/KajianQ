#!/usr/bin/env bun
/**
 * boot.ts — the Bun serving entry point (#181, ADR-0044).
 *
 *   bun run apps/api/src/boot.ts
 *
 * This is what `provision/vps/systemd/kajianq-api.service` executes on the
 * VPS: a plain Bun server behind nginx, replacing the Cloudflare Worker entry.
 * Configuration comes from the environment, which systemd supplies through
 * `EnvironmentFile=/etc/kajianq/api.env` — no secret is ever an argv value.
 *
 * The process exits non-zero on a bind failure so systemd's `Restart=on-failure`
 * takes over rather than leaving a half-configured instance up.
 */
import { createApi } from "./app";
import { serveApi } from "./lib/server";

const { stop } = serveApi({ api: createApi() });

// SIGTERM is what systemd sends on `systemctl restart` / `stop`. Draining the
// listener means in-flight answers (SSE streams can run up to the proxy's
// 300 s read timeout) are allowed to finish instead of being cut mid-answer.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void stop().then(() => process.exit(0));
  });
}
