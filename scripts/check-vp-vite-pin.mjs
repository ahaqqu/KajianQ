#!/usr/bin/env bun
// Vite+ version-coupling guard (ADR-0029, decision 5): apps/web's direct
// `vite` devDependency is the import site for vite.config.ts and the peer
// the Vite plugins resolve against, while `vp dev/build/preview` execute
// vp's own bundled Vite. The two must stay on the same revision or the
// config/plugins get compiled against a different Vite than the one that
// runs them. Wired into `bun run lint` so drift fails the blocking gate.
import { readFileSync } from "node:fs";

const vitePin = JSON.parse(
  readFileSync(new URL("../apps/web/package.json", import.meta.url), "utf8"),
).devDependencies.vite;
const bundledVite = readFileSync(
  new URL("../node_modules/vite-plus/dist/versions.js", import.meta.url),
  "utf8",
).match(/"vite": "([^"]+)"/)?.[1];

if (!vitePin || !bundledVite) {
  console.error(
    `vp-vite-pin: cannot read both versions (apps/web pin: ${vitePin ?? "missing"}, vp bundled: ${bundledVite ?? "missing"})`,
  );
  process.exit(1);
}
if (vitePin !== bundledVite) {
  console.error(
    `vp-vite-pin: apps/web vite ${vitePin} !== vite-plus bundled vite ${bundledVite} — align them (ADR-0029 decision 5) before bumping either`,
  );
  process.exit(1);
}
console.log(`vp-vite-pin OK (apps/web vite ${vitePin} === vite-plus bundled ${bundledVite})`);
