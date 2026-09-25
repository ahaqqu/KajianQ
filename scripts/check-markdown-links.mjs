#!/usr/bin/env bun
/**
 * Markdown link-resolution gate.
 *
 * Every relative link in a tracked `.md` file must resolve to a file that
 * exists. Why this is a gate and not a nice-to-have: this repository's docs
 * cite each other as *evidence* — an Art. 30 TOMs row points at the executed
 * cutover log, the privacy notice points at the register's decisions, a skill
 * points at the runbook it implements. A dangling one of those is not a typo;
 * it is a compliance claim whose proof has gone missing, and nothing else in
 * CI would notice. GitHub renders a dead relative link as ordinary text, so a
 * reader cannot tell they are looking at a broken citation either.
 *
 * This exists because the docs were consolidated (the VPS set was reduced to a
 * setup guide, an operations manual, and the evidence record) and every
 * deletion had to repoint its citations. Without this gate that repointing is
 * done by hand and verified by eye — the exact shape of check that rots.
 *
 * Scope: only relative targets. External URLs are not fetched (a network
 * dependency in a gate is a flaky gate, and link rot on the open web is not
 * this repository's to police), and pure `#anchor` links are not resolved
 * against generated heading slugs.
 *
 * Also checks the docs' own cross-references to non-Markdown files, because a
 * doc that points at `provision/vps/deploy/deploy.sh` is making the same
 * verifiable claim as one that points at another doc — and AGENTS.md's "every
 * doc claim has code" is only checkable if the path is real.
 *
 * Exits non-zero and prints `file:line -> target` for each dangling link.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

/**
 * Roots that carry agent- or human-facing prose. `.agents/` and `.zcode/` are
 * included deliberately: a skill that points at a retired runbook sends the
 * next agent somewhere that no longer exists, which is how a repo teaches a
 * stale procedure to an autonomous worker.
 */
const ROOTS = [
  "README.md",
  "AGENTS.md",
  "CONTEXT.md",
  "SPECS.md",
  "INITIAL_IDEA.md",
  "docs",
  "adr",
  "NOTICES",
  ".agents",
  ".zcode",
  "packages",
];

function walk(path, out = []) {
  const st = statSync(path);
  if (st.isFile()) {
    if (path.endsWith(".md")) out.push(path);
    return out;
  }
  for (const name of readdirSync(path)) {
    // Vendored READMEs are not this repository's prose: `node_modules` holds
    // third-party packages whose own internal links are theirs to keep, and
    // `packages/*/node_modules/@app/*` symlinks would report each upstream
    // README once per dependent package.
    if (name === "node_modules" || name === ".scratch") continue;
    walk(join(path, name), out);
  }
  return out;
}

const files = ROOTS.map((r) => join(ROOT, r))
  .filter((p) => existsSync(p))
  .flatMap((p) => walk(p));

/**
 * Strip fenced code blocks before scanning. A markdown link written inside a
 * fence is an example, not a citation — this file's own header would otherwise
 * be scanned as prose. Indented (4-space) blocks are not stripped: this
 * repository uses fences throughout, and treating indentation as code would
 * silently skip real links in nested list items.
 */
function prose(text) {
  const out = [];
  let inFence = false;
  let fenceMarker = null;
  for (const line of text.split("\n")) {
    const fence = /^\s*(```+|~~~+)/.exec(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1][0];
      } else if (fence[1][0] === fenceMarker) {
        inFence = false;
        fenceMarker = null;
      }
      out.push("");
      continue;
    }
    out.push(inFence ? "" : line);
  }
  return out;
}

const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

const violations = [];
let checked = 0;

for (const file of files) {
  const lines = prose(readFileSync(file, "utf8"));
  const dir = dirname(file);

  for (const [i, line] of lines.entries()) {
    for (const match of line.matchAll(LINK_RE)) {
      const raw = match[1];
      // External, protocol-relative, mailto, and same-page anchors are out of
      // scope — see the header.
      if (/^(https?:|mailto:|tel:|#|\/\/)/.test(raw)) continue;
      // A leading `/` means "relative to the repository root" in most
      // Markdown renderers used with a `base`, but GitHub resolves it to the
      // domain root. Rather than guess, treat it as a violation: this repo has
      // none, and a future one should be an explicit decision.
      if (raw.startsWith("/")) {
        violations.push({
          file,
          line: i + 1,
          target: raw,
          reason: "root-absolute path (resolve it relative to the file instead)",
        });
        continue;
      }

      const [pathPart] = raw.split("#");
      if (!pathPart) continue; // pure anchor: `#section` handled above
      checked += 1;

      const target = resolve(dir, decodeURIComponent(pathPart));
      if (!existsSync(target)) {
        violations.push({ file, line: i + 1, target: raw, reason: "target does not exist" });
      }
    }
  }
}

if (violations.length > 0) {
  console.error(
    `markdown-links: ${violations.length} dangling link(s) across ${files.length} files\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file.replace(`${ROOT}/`, "")}:${v.line} -> ${v.target}  (${v.reason})`);
  }
  console.error("\nA dangling doc link is a broken citation, not a typo: fix the path, or");
  console.error("restore the target. See this script's header for why it is a gate.");
  process.exit(1);
}

console.log(`markdown-links: OK (${checked} relative links across ${files.length} files resolve)`);
