#!/usr/bin/env bun
// Vite+ version-coupling guard. `vite-plus` (vp) ships its own Vite and
// Vitest and runs them for `vp dev/build/preview/test`, so every name the
// project pins separately has to name the revision vp carries:
//
//  - `overrides.vite` aliases Vite to the `@voidzero-dev/vite-plus-core`
//    revision `vite-plus` itself depends on. Packages that resolve `vite`
//    directly — Vitest's own dependency edge, and any plugin or peer that
//    declares it — then compile against the same Vite the `vp` commands
//    execute.
//  - `overrides.vitest` keeps one Vitest copy in the graph. vp documents
//    that without it a dependency or workspace package can pull a different
//    Vitest than the bundled runner and split its internals (mocks, `expect`,
//    runner state).
//  - `@vitest/coverage-v8` is the v8 provider selected by `vitest.config.ts`.
//    vp does not ship it — its own coverage entry re-exports `vitest/coverage`
//    — and Vitest declares it an exact-version peer, so it must track the
//    Vitest vp bundles.
//
// Wired into `bun run lint` so drift fails the blocking gate.
import { readFileSync } from "node:fs";

const rootPkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const vpPkg = JSON.parse(
  readFileSync(new URL("../node_modules/vite-plus/package.json", import.meta.url), "utf8"),
);
const versions = readFileSync(
  new URL("../node_modules/vite-plus/dist/versions.js", import.meta.url),
  "utf8",
);

// Both specs are npm aliases of the form `npm:@scope/name@<version>`.
const aliasVersion = (spec) => spec?.match(/@([^@]+)$/)?.[1];

const bundledVite = versions.match(/"vite": "([^"]+)"/)?.[1];
const bundledVitest = versions.match(/"vitest": "([^"]+)"/)?.[1];
const vpCore = vpPkg.dependencies?.["@voidzero-dev/vite-plus-core"];
const projectViteAlias = aliasVersion(rootPkg.overrides?.vite);
const projectVitest = rootPkg.overrides?.vitest;
const coveragePin = rootPkg.devDependencies?.["@vitest/coverage-v8"];

if (!bundledVite || !vpCore || !projectViteAlias) {
  console.error(
    `vp-vite-pin: cannot read all vite revisions (vp bundled: ${bundledVite ?? "missing"}, vp core: ${vpCore ?? "missing"}, overrides.vite: ${projectViteAlias ?? "missing"})`,
  );
  process.exit(1);
}
if (projectViteAlias !== vpCore) {
  console.error(
    `vp-vite-pin: overrides.vite aliases @voidzero-dev/vite-plus-core@${projectViteAlias} but vite-plus depends on ${vpCore} (bundling vite ${bundledVite}) — move them together`,
  );
  process.exit(1);
}
console.log(`vp-vite-pin OK (overrides.vite @voidzero-dev/vite-plus-core@${projectViteAlias})`);

if (!bundledVitest || !projectVitest || !coveragePin) {
  console.error(
    `vp-vitest-pin: cannot read all versions (overrides.vitest: ${projectVitest ?? "missing"}, @vitest/coverage-v8: ${coveragePin ?? "missing"}, vp bundled: ${bundledVitest ?? "missing"})`,
  );
  process.exit(1);
}
if (projectVitest !== bundledVitest || coveragePin !== bundledVitest) {
  console.error(
    `vp-vitest-pin: overrides.vitest ${projectVitest} / @vitest/coverage-v8 ${coveragePin} !== vite-plus bundled vitest ${bundledVitest} — align them before bumping either`,
  );
  process.exit(1);
}
console.log(`vp-vitest-pin OK (vitest ${bundledVitest} === vite-plus bundled)`);
