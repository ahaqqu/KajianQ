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
 *     migration cannot smuggle domain vocabulary past a TS-only gate).
 *
 * The domain rule applies to both TS and SQL; the vendor and DB-client rules
 * apply to TS only (a SQL DDL file legitimately contains SQL, not a driver
 * import).
 *
 * Exits non-zero and prints each offending file:line so a violation fails CI
 * with a clear pointer instead of a silent trust regression.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ENGINE_PKGS = [
  "packages/rag-core",
  "packages/rag-ingest",
  "packages/eval",
  "packages/contracts",
  "packages/infra/src",
  "packages/infra/migrations",
];

const TS_EXTS = ["ts", "tsx", "mts", "cts"];
const SQL_EXTS = ["sql"];
const TS_EXT_RE = /\.(?:ts|tsx|mts|cts)$/;
const SQL_EXT_RE = /\.sql$/;

// The one place a DB driver import IS the point: the RagStore adapter's own
// integration tests, and the infra scripts that own migrations/probes against
// a real database. Nothing else may opt out — narrow allowlist, not a dir.
const DB_CLIENT_EXEMPT = new Set([
  "packages/infra/src/rag-store-neon.test.ts",
  "packages/infra/scripts/db-migrate.mjs",
  "packages/infra/scripts/pg-search-probe.mjs",
]);

const RULES = [
  {
    name: "Islamic-domain identifier in an engine package",
    // CONTEXT.md vocabulary — engine must receive these as opaque inputs.
    // `ayah` is added so a migration cannot encode Quran-verse references in
    // the engine schema (the concept graph with ayah_pair_id lives in the
    // domain pack now, per the ADR-0014 amendment).
    pattern:
      /madzhab|madhhab|hadith|hadis|quran|qur'an|kitab|isnad|sanad|sahih|dhaif|hasan|mutawatir|hanafi|maliki|syafii|shafi|hambali|hanbali|tafsir|fiqh|aqidah|tasawuf|sharh|matn\b|ayah/i,
    exts: [...TS_EXTS, ...SQL_EXTS],
  },
  {
    name: "vendor or model name outside config",
    pattern:
      /qwen|gemini|deepseek|kimi|moonshot|dashscope|anthropic|openai|cohere/i,
    exts: TS_EXTS,
  },
  {
    name: "direct database client outside the RagStore seam",
    // Match code-level coupling: an import of a DB driver, a pool/prepared
    // call, a tagged SQL query, or a dynamic import of `pg`. Doc comments
    // naming "pg"/"postgres" are not violations — the rule's target is
    // dependency, not vocabulary.
    pattern:
      /(@neondatabase|drizzle|\bfrom\s+["']pg["']|require\(["']pg["']\)|import\s*\(\s*["']pg["']\s*\)|new\s+pg\.|new\s+Pool\b|postgres\(|neon\(|createPool|\.prepare\()/i,
    exts: TS_EXTS,
    exempt: (f) => DB_CLIENT_EXEMPT.has(f),
  },
];

/** List engine-package source files, including not-yet-committed ones. */
function engineFiles() {
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

function matchesExt(file, exts) {
  return exts.some((e) => file.endsWith(`.${e}`));
}

let violations = 0;
for (const file of engineFiles()) {
  const text = readFileSync(file, "utf8");
  text.split("\n").forEach((line, i) => {
    for (const rule of RULES) {
      if (!matchesExt(file, rule.exts)) continue;
      if (rule.exempt?.(file)) continue;
      if (rule.pattern.test(line)) {
        violations += 1;
        console.error(
          `boundary: ${file}:${i + 1} — ${rule.name}\n  ${line.trim()}`,
        );
      }
    }
  });
}

if (violations > 0) {
  console.error(
    `\nboundary: ${violations} violation(s). Engine packages must stay ` +
      `domain/vendor/SQL-free; parameterize the concept instead (dars-pluggability).`,
  );
  process.exit(1);
}
console.log("boundary: engine packages clean (0 violations)");