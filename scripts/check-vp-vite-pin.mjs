#!/usr/bin/env bun
// Vite+ version-coupling guard (ADR-0029, decision 5): apps/web's direct
// `vite` devDependency is the import site for vite.config.ts and the peer
// the Vite plugins resolve against, while `vp dev/build/preview` execute
// vp's own bundled Vite. The two must stay on the same revision or the
// config/plugins get compiled against a different Vite than the one that
// runs them. The same coupling holds for Vitest: `vp test` executes vp's
// bundled Vitest while the root `vitest`/`@vitest/coverage-v8` pins are
// what vitest.config.ts and the coverage tooling compile against. Wired
// into `bun run lint` so drift fails the blocking gate.
import { readFileSync } from "node:fs";

const webPkg = JSON.parse(
  readFileSync(new URL("../apps/web/package.json", import.meta.url), "utf8"),
);
const rootPkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const versions = readFileSync(
  new URL("../node_modules/vite-plus/dist/versions.js", import.meta.url),
  "utf8",
);

const vitePin = webPkg.devDependencies.vite;
const bundledVite = versions.match(/"vite": "([^"]+)"/)?.[1];
const vitestPin = rootPkg.devDependencies.vitest;
const coveragePin = rootPkg.devDependencies["@vitest/coverage-v8"];
const bundledVitest = versions.match(/"vitest": "([^"]+)"/)?.[1];

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

if (!vitestPin || !coveragePin || !bundledVitest) {
  console.error(
    `vp-vitest-pin: cannot read all versions (root vitest: ${vitestPin ?? "missing"}, root @vitest/coverage-v8: ${coveragePin ?? "missing"}, vp bundled: ${bundledVitest ?? "missing"})`,
  );
  process.exit(1);
}
if (vitestPin !== bundledVitest || coveragePin !== bundledVitest) {
  console.error(
    `vp-vitest-pin: root vitest ${vitestPin} / @vitest/coverage-v8 ${coveragePin} !== vite-plus bundled vitest ${bundledVitest} — align them (ADR-0029 decision 5) before bumping either`,
  );
  process.exit(1);
}
console.log(`vp-vitest-pin OK (root vitest ${vitestPin} === vite-plus bundled ${bundledVitest})`);
