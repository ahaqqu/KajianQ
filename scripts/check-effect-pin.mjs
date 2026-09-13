#!/usr/bin/env bun
// Effect single-version guard (ADR-0027 Appendix C): the whole workspace
// resolves exactly ONE effect version. The root `overrides.effect` pin forces
// every consumer — including transitives that declare `effect` as an optional
// peer (the hono-openapi/`@standard-community` openapi toolchain) — onto the
// workspace pin; without it bun drifts such peers to a newer rc, mixing effect
// core versions in one install (the `Cannot find module 'effect/ByteSize'`
// failure class first observed with `@effect/platform-node-shared`). This
// check asserts the pin exists and that `bun.lock` contains no other effect
// version. Wired into `bun run lint` so skew fails the blocking gate.
import { readFileSync } from "node:fs";

const rootPkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lock = readFileSync(new URL("../bun.lock", import.meta.url), "utf8");

const pinned = rootPkg.overrides?.effect;
if (typeof pinned !== "string" || !/^[\d]/.test(pinned)) {
  console.error(
    "effect-pin: root package.json `overrides.effect` pin missing or not an exact version — " +
      "the workspace single-version invariant (ADR-0027 Appendix C) is unguarded",
  );
  process.exit(1);
}

// Distinct `effect@<version>` descriptors anywhere in the lock. Package names
// like `@effect/platform-node` never match (the `@` must directly follow
// "effect"), so every hit is a resolution of the `effect` package itself —
// including nested keys such as `@standard-community/standard-json/effect`,
// whose resolved value is exactly the skew this guard exists to catch.
const versions = [
  ...new Set([...lock.matchAll(/\beffect@(\d[^\s"\],}]*)/g)].map((m) => m[1])),
].sort();
if (versions.length !== 1 || versions[0] !== pinned) {
  console.error(
    `effect-pin: bun.lock resolves effect [${versions.join(", ")}] — expected exactly [${pinned}]. ` +
      "A second version is core-vs-consumer mixing (ADR-0027 Appendix C); " +
      "check the root `overrides.effect` pin covers the offending transitive",
  );
  process.exit(1);
}
console.log(`effect-pin OK (bun.lock resolves exactly one effect version: ${versions[0]})`);
