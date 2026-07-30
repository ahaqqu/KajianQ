#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const MAX_LINES = 300;
const MAX_DEPS = 5;
const roots = ["apps", "packages"];

// Exemptions: test files only (plus index.ts barrels for the import cap
// below). Every source file — app.ts, main.tsx, router.tsx, components —
// must fit the limits.
const skip = (p) =>
  p.includes("node_modules") ||
  p.includes("dist") ||
  p.includes(".wrangler") ||
  p.includes(".features-gen") ||
  p.endsWith(".test.ts") ||
  p.endsWith(".prop.test.ts");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

const files = roots.flatMap((r) => walk(join(ROOT, r)));
const violations = [];

for (const file of files) {
  if (skip(file)) continue;
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/).length;
  if (lines > MAX_LINES) {
    violations.push(`${relative(ROOT, file)}: ${lines} lines > ${MAX_LINES}`);
  }
  const importCount = [
    ...text.matchAll(/^import\s+.+from\s+['\"][^'\"]+['\"]/gm),
  ].length;
  if (importCount > MAX_DEPS && !file.endsWith("index.ts")) {
    // index re-exports allowed higher
    if (!file.includes(`${join("src", "index.ts")}`)) {
      violations.push(
        `${relative(ROOT, file)}: ${importCount} imports > ${MAX_DEPS}`,
      );
    }
  }
}

if (violations.length) {
  console.error("Agentic limits failed:\n" + violations.join("\n"));
  process.exit(1);
}
console.log(`Agentic limits OK (${files.length} files scanned)`);
