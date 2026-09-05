#!/usr/bin/env bun
/**
 * Preflight for the Alchemy deploy scripts (ADR-0028).
 *
 * The alchemy CLI loads its Effect runtime peers lazily and fails mid-deploy
 * with a bare "Cannot find module" when they are missing — the failure that
 * motivated this check. Verify the toolchain resolves before a deploy starts
 * applying a plan.
 *
 * Usage: `bun apps/api/scripts/alchemy-preflight.mjs` (wired into the
 * apps/api `alchemy:*` package scripts). Exit 0 = proceed.
 */

const peers = ["@effect/platform-bun", "@effect/platform-node"];

for (const peer of peers) {
  try {
    await import(peer);
  } catch {
    console.error(
      `alchemy preflight: runtime peer "${peer}" is not resolvable — run \`bun install\` at the repo root (ADR-0028)`,
    );
    process.exit(1);
  }
}
console.log("alchemy preflight: runtime peers resolve");
