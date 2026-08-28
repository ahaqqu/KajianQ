#!/usr/bin/env bun
/**
 * Domain/vendor/SQL boundary gate (ADR-0005 scope, ADR-0008 seam, ADR-0009
 * allowlist). Engine packages must stay domain-agnostic and swappable: no
 * Islamic-domain identifiers, no vendor/model names, and no direct database
 * clients outside the RagStore adapter + migrations. The domain pack
 * (kajianq-domain) and apps/ are *outside* this gate by design — that is
 * where domain logic is allowed to live.
 *
 * What is scanned:
 *   - TypeScript/JS source (`.ts`/`.tsx`/`.mts`/`.cts`) under every engine
 *     package, AND
 *   - `.sql` migration files under `packages/infra/migrations` (so an engine
 *     migration cannot smuggle domain vocabulary past a TS-only gate), AND
 *   - `package.json` files under every engine package root. For each, the
 *     `dependencies` / `devDependencies` / `peerDependencies` name strings
 *     are checked against the vendor and DB-client rules — so adding
 *     `drizzle-orm` or `@neondatabase/serverless` to an engine package.json
 *     fails the gate. The Islamic-domain rule is NOT applied to dependency
 *     names (it targets source vocabulary, not package identifiers).
 *
 * The domain rule applies to both TS and SQL; the vendor and DB-client rules
 * apply to TS and to package.json dependency names (a SQL DDL file
 * legitimately contains SQL, not a driver import).
 *
 * Rules live in `scripts/boundary-rules.json` (auditable, one-line to extend);
 * this script loads that data and compiles each `pattern` into a RegExp.
 *
 * Exits non-zero and prints each offending file:line so a violation fails CI
 * with a clear pointer instead of a silent trust regression.
 *
 * Exports `compileRules`, `sourceLineViolations`, and `dependencyViolations`
 * for the negative/unit tests in `tests/scripts/check-boundary.test.mjs`.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const RULES_JSON = resolve(HERE, "boundary-rules.json");

// Source scan paths (TS + SQL only). `packages/infra/src` and `migrations` are
// scoped subpaths so infra scripts outside the seam are not swept in.
// `rate` and `hardening` are shared project-agnostic packages (AGENTS.md rule 1
// lists them alongside the engine packages), so the gate scans them whole.
const ENGINE_PKGS = [
  "packages/rag-core",
  "packages/rag-ingest",
  "packages/eval",
  "packages/contracts",
  "packages/infra/src",
  "packages/infra/migrations",
  "packages/rate",
  "packages/hardening",
];

// Package roots for the `package.json` dependency-name scan. Broader than the
// source paths so an engine package's own manifest is covered (e.g. the infra
// manifest lives at `packages/infra/package.json`, outside `infra/src`).
const ENGINE_PKG_ROOTS = [
  "packages/rag-core",
  "packages/rag-ingest",
  "packages/eval",
  "packages/contracts",
  "packages/infra",
  "packages/rate",
  "packages/hardening",
];

const TS_EXT_RE = /\.(?:ts|tsx|mts|cts)$/;
const SQL_EXT_RE = /\.sql$/;
const PKG_JSON_RE = /(?:^|\/)package\.json$/;

/** Load the raw rule definitions from the JSON data file. */
export function loadRules() {
  return JSON.parse(readFileSync(RULES_JSON, "utf8"));
}

/** Compile each JSON rule into a { regex, exts, deps, exempt } record. */
export function compileRules() {
  return loadRules().map((r) => ({
    name: r.name,
    // Patterns come from the checked-in `boundary-rules.json` (not user input)
    // and are compiled once at gate startup; the gate runs at build/CI time.
    // nosemgrep: detect-non-literal-regexp
    regex: new RegExp(r.pattern, r.flags ?? ""),
    exts: r.exts,
    deps: r.deps ?? false,
    exempt: new Set(r.exempt ?? []),
    pkgExempt: new Set(r.pkgExempt ?? []),
    justification: r.justification,
  }));
}

function matchesExt(file, exts) {
  return exts.some((e) => file.endsWith(`.${e}`));
}

/** Violations in a single source line of `file`, respecting exts + exempt. */
export function sourceLineViolations(line, file, rules = compileRules()) {
  const hits = [];
  for (const rule of rules) {
    if (!matchesExt(file, rule.exts)) continue;
    if (rule.exempt.has(file)) continue;
    if (rule.regex.test(line)) hits.push(rule.name);
  }
  return hits;
}

/**
 * Violations across a list of dependency-name strings. Only rules marked
 * `deps: true` (vendor + DB-client) run here — never the Islamic-domain rule.
 * `pkgFile` is the manifest path; rules whose `pkgExempt` contains it are
 * skipped (the infra manifest is the sanctioned adapter home). Source-file
 * `exempt` does not apply to dependency names.
 */
export function dependencyViolations(depNames, rules = compileRules(), pkgFile) {
  const depRules = rules.filter(
    (r) => r.deps && !(pkgFile && r.pkgExempt.has(pkgFile)),
  );
  const hits = [];
  for (const name of depNames) {
    for (const rule of depRules) {
      if (rule.regex.test(name)) hits.push({ name, rule: rule.name });
    }
  }
  return hits;
}

/** List engine-package source files (TS/SQL), including uncommitted ones. */
function engineSourceFiles() {
  const out = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", ...ENGINE_PKGS],
    { encoding: "utf8" },
  );
  return out
    .split("\n")
    .filter(Boolean)
    .filter((f) => TS_EXT_RE.test(f) || SQL_EXT_RE.test(f));
}

/** List engine-package `package.json` manifests, including uncommitted ones. */
function enginePackageJsons() {
  const out = execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      ...ENGINE_PKG_ROOTS,
    ],
    { encoding: "utf8" },
  );
  return out.split("\n").filter(Boolean).filter((f) => PKG_JSON_RE.test(f));
}

function dependencyNames(pkg) {
  const json = JSON.parse(readFileSync(pkg, "utf8"));
  const deps = [];
  for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
    const section = json[key];
    if (section && typeof section === "object") {
      deps.push(...Object.keys(section));
    }
  }
  return deps;
}

function main() {
  const rules = compileRules();
  let violations = 0;

  for (const file of engineSourceFiles()) {
    const text = readFileSync(file, "utf8");
    text.split("\n").forEach((line, i) => {
      for (const name of sourceLineViolations(line, file, rules)) {
        violations += 1;
        console.error(
          `boundary: ${file}:${i + 1} — ${name}\n  ${line.trim()}`,
        );
      }
    });
  }

  for (const file of enginePackageJsons()) {
    for (const hit of dependencyViolations(dependencyNames(file), rules, file)) {
      violations += 1;
      console.error(
        `boundary: ${file} — ${hit.rule} (dependency "${hit.name}")`,
      );
    }
  }

  if (violations > 0) {
    console.error(
      `\nboundary: ${violations} violation(s). Engine packages must stay ` +
        `domain/vendor/SQL-free; parameterize the concept instead (dars-pluggability).`,
    );
    process.exit(1);
  }
  console.log("boundary: engine packages clean (0 violations)");
}

// Run only when invoked as a script, not when imported by tests.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}