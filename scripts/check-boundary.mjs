#!/usr/bin/env bun
/**
 * Domain/vendor/SQL boundary gate (ADR-0005 scope, ADR-0008 seam, ADR-0009
 * allowlist). Engine packages must stay domain-agnostic and swappable: no
 * Islamic-domain identifiers, no vendor/model names, and no direct database
 * clients. The domain pack (kajianq-domain) and apps/ are *outside* this gate
 * by design — that is where domain logic is allowed to live.
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
];

const RULES = [
  {
    name: "Islamic-domain identifier in an engine package",
    // CONTEXT.md vocabulary — engine must receive these as opaque inputs.
    pattern:
      /madzhab|madhhab|hadith|hadis|quran|qur'an|kitab|isnad|sanad|sahih|dhaif|hasan|mutawatir|hanafi|maliki|syafii|shafi|hambali|hanbali|tafsir|fiqh|aqidah|tasawuf|sharh|matn\b/i,
  },
  {
    name: "vendor or model name outside config",
    pattern:
      /qwen|gemini|deepseek|kimi|moonshot|dashscope|anthropic|openai|cohere/i,
  },
  {
    name: "direct database client outside the RagStore seam",
    // Match code-level coupling: an import of a DB driver, a pool/prepared
    // call, or a tagged SQL query. Doc comments naming "pg"/"postgres" are
    // not violations — the rule's target is dependency, not vocabulary.
    pattern:
      /(@neondatabase|drizzle|\bfrom\s+["']pg["']|require\(["']pg["']\)|new\s+pg\.|postgres\(|createPool|\.prepare\()/i,
    // Rule exempts one place where a driver import IS the point: the RagStore
    // adapter's own integration tests under packages/infra, which verify the
    // seam against a real database. Nothing else may opt out.
    exempt: (f) =>
      /^packages\/infra\/src\/.*\.test\.ts$/.test(f) ||
      /^packages\/infra\/scripts\//.test(f),
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
    .filter((f) => /\.(ts|tsx|mts|cts)$/.test(f));
}

let violations = 0;
for (const file of engineFiles()) {
  const text = readFileSync(file, "utf8");
  text.split("\n").forEach((line, i) => {
    for (const rule of RULES) {
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
