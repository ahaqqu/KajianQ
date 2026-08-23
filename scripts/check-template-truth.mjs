#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();

// Template-truth gate: every dependency declared in any package.json must
// have at least one importer in repo source or config. A dependency without
// an importer is dead weight that gets cloned into every fork.
//
// The allowlist covers tooling whose usage is not a source `import` — CLI
// binaries, ambient types, config-key presets, and library-internal runtime
// peers. Every entry must carry a justification. An allowlisted package that
// gains a real importer makes its entry stale, and that fails the gate too.
const ALLOWLIST = new Map([
  ["typescript", "tsc binary invoked by the check/build scripts"],
  ["wrangler", "CLI invoked by the dev/build/deploy/db:migrate scripts"],
  ["size-limit", "CLI binary invoked by the size-limit script"],
  [
    "@size-limit/file",
    "size-limit preset resolved via the package.json size-limit key",
  ],
  ["@vitest/coverage-v8", "loaded by vitest when coverage.provider is v8"],
  ["@types/node", "ambient types for node:* builtins and process"],
  ["@types/react", "ambient JSX types (no import site)"],
  ["@types/react-dom", "ambient JSX types (no import site)"],
  ["fast-check", "runtime peer of @fast-check/vitest, which re-exports fc"],
  [
    "@hono/standard-validator",
    "runtime peer imported internally by hono-openapi dist, not app code",
  ],
  [
    "@standard-community/standard-json",
    "runtime peer imported internally by hono-openapi dist, not app code",
  ],
  [
    "@standard-community/standard-openapi",
    "runtime peer imported internally by hono-openapi dist, not app code",
  ],
  [
    "@valibot/to-json-schema",
    "dynamically imported by @standard-community/standard-json for Valibot schemas",
  ],
]);

const skipDir = (name) =>
  name === "node_modules" ||
  name === "dist" ||
  name === ".wrangler" ||
  name === ".features-gen" ||
  name === ".git";

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (skipDir(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (
      /\.(ts|tsx|js|mjs|css|json)$/.test(name) &&
      name !== "package.json"
    ) {
      out.push(p);
    }
  }
  return out;
}

// Source/config corpus: apps, packages, tests + root config files.
// Scripts are excluded: gate scripts quote allowlist names and must not count
// as importers.
const corpus = ["apps", "packages", "tests"].flatMap((r) =>
  walk(join(ROOT, r)),
);
for (const name of readdirSync(ROOT)) {
  if (/^(.+\.config\.(ts|js|mjs)|tsconfig.*\.json)$/.test(name)) {
    corpus.push(join(ROOT, name));
  }
}
const haystack = corpus.map((f) => readFileSync(f, "utf8")).join("\n");

const pkgJsonPaths = ["package.json"];
for (const scope of ["apps", "packages"]) {
  for (const name of readdirSync(join(ROOT, scope))) {
    const p = join(scope, name, "package.json");
    try {
      statSync(join(ROOT, p));
      pkgJsonPaths.push(p);
    } catch {
      // not a package directory
    }
  }
}

const importerOf = (name) =>
  // Look for the package name used as an import/module specifier, with an
  // optional subpath. We check quoted prefixes only (e.g. "hono" or "hono/"),
  // which is enough to distinguish an import from a bare word in prose.
  haystack.includes(`"${name}"`) ||
  haystack.includes(`'${name}'`) ||
  haystack.includes(`"${name}/`) ||
  haystack.includes(`'${name}/`);

const violations = [];
let depCount = 0;

for (const p of pkgJsonPaths) {
  const pkg = JSON.parse(readFileSync(join(ROOT, p), "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const name of Object.keys(deps)) {
    depCount += 1;
    const hasImporter = importerOf(name);
    const justification = ALLOWLIST.get(name);
    if (!hasImporter && justification === undefined) {
      violations.push(
        `${p}: "${name}" has no importer in source/config — remove it, or allowlist it with a justification`,
      );
    }
    if (hasImporter && justification !== undefined) {
      violations.push(
        `${p}: "${name}" has a real importer — its allowlist entry is stale ("${justification}"), remove the entry`,
      );
    }
  }
}

if (violations.length) {
  console.error("Template truth failed:\n" + violations.join("\n"));
  process.exit(1);
}
console.log(
  `Template truth OK (${depCount} deps across ${pkgJsonPaths.length} package.json files, ${corpus.length} files scanned)`,
);
