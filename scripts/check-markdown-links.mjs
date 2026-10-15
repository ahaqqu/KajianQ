#!/usr/bin/env bun
/**
 * Doc reference-resolution gate — the driver, not the contract: that is the
 * header of `./markdown-links/policy.mjs`. Exits non-zero and prints
 * `file:line -> target (reason)` for each dangling reference, plus any stale
 * allowlist entry.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLAIM_ROOTS,
  KNOWN_RETIRED,
  POLICY,
  ROOTS,
  isFileRelativeTarget,
} from "./markdown-links/policy.mjs";

/**
 * `dirname(fileURLToPath(import.meta.url))`, not Bun's `import.meta.dir`: this
 * module also runs under Vitest on Node, where `import.meta.dir` is undefined,
 * and rooting the gate in its own location keeps a caller's cwd from pointing it
 * at a different tree.
 */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const SPAN_RE = /`([^`\n]+)`/g;
export const ADR_ID_RE = /^adr\/(\d{4})$/;
const SKILL_NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Strip fenced code blocks before scanning: a link or span inside a fence is an
 * example, not a citation. Indented (4-space) blocks are deliberately not stripped
 * as code — only fences are — since real links live in nested lists.
 */
export function prose(text) {
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

/** Every inline code span on one line, with the index its backtick starts at. */
export function inlineCodeSpans(line) {
  const spans = [];
  for (const match of line.matchAll(SPAN_RE)) {
    const target = match[1].trim();
    if (target) spans.push({ target, index: match.index });
  }
  return spans;
}

export function makeTree(paths) {
  const files = new Set();
  const dirs = new Set();
  const rootFiles = new Set();
  for (const path of paths) {
    files.add(path);
    if (!path.includes("/")) rootFiles.add(path);
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join("/"));
  }
  return { files, dirs, rootFiles };
}

function isTracked(tree, path) {
  return tree.files.has(path) || tree.dirs.has(path);
}

/** A target's repo-relative form under `fromDir`, or null if it escapes the repo. */
export function toRepoPath(root, fromDir, target) {
  const abs = resolve(root, fromDir, target);
  if (abs === root) return "";
  return abs.startsWith(root + sep) ? abs.slice(root.length + 1) : null;
}

/**
 * WHAT PART OF A SPAN IS THE CLAIM — the span normaliser. A citation points
 * *into* its target, so the order is the contract: swallowed punctuation (it is
 * what hides the rest), then a fragment, then a line citation — `path:42-58,`,
 * `path#L24` and `path:42#L7` all reduce to `path`. Callers that resolve a span
 * must normalise with this too.
 */
export function normaliseSpanTarget(text) {
  return text
    .trim()
    .replace(/[.,;:!?'")\]]+$/, "") // punctuation the prose swallowed into the span
    .replace(/#.*$/, "") // `path#L24` — an in-file fragment
    .replace(/:\d+(?:-\d+)?$/, ""); // `path:42`, `path:42-58` — a line citation
}

/**
 * Is this code span a repo-path claim? See SCOPE RULES in the header — the order
 * of these checks is the contract. The normaliser runs first, so callers may pass
 * the raw span; callers that resolve it must normalise too.
 */
export function isPathClaim(text, tree) {
  const raw = text ?? "";
  // On the raw text, not the normalised one: trimming swallowed punctuation would
  // eat the third dot of `...` and turn a display label into a claim.
  if (/…|\.\.\./.test(raw)) return false; // elided display labels (class D)
  const target = normaliseSpanTarget(raw);
  if (!target) return false;
  if (/\s/.test(target)) return false; // `bun run lint`, command lines
  if (/[*?[\]{}]/.test(target)) return false; // `**/*.ts`
  if (/[<>]/.test(target)) return false; // `<slug>`, `<role>`, `<label>`
  if (/^(?:https?:|mailto:|tel:|#|\/\/)/.test(target)) return false; // URLs, anchors
  if (target.startsWith("/")) return false; // not repo-relative
  // `./`- and `..`-rooted targets are claims by their form, never by their
  // reading's first segment: re-testing the reading against CLAIM_ROOTS would
  // veto a target the link half reddens on. See SCOPE RULES.
  if (isFileRelativeTarget(target)) return true;
  if (!target.includes("/")) return tree.rootFiles.has(target);
  return CLAIM_ROOTS.includes(target.split("/")[0]);
}

/** A bare kebab-case token: candidate for the skill-name half. */
export function isSkillName(target) {
  return SKILL_NAME_RE.test(target);
}

/**
 * Is the span at `index` adjacent to the word `skill`? The marker is the claim; see SKILLS_RULE.
 */
export function skillMentionAt(line, name, index) {
  const before = line.slice(0, index);
  const after = line.slice(index);
  if (/\bskills?\s+$/i.test(before)) return true;
  // A literal comparison, not a `RegExp` built from the span text: a dynamic
  // regex over file content is a ReDoS surface the security scan blocks.
  const span = `\`${name}\``;
  if (!after.startsWith(span)) return false;
  return /^skills?\b/i.test(after.slice(span.length).replace(/^\s+/, ""));
}

/** `` `adr/0045` `` resolves against `adr/0045-*.md`; see class A in the header. */
export function adrIdResolves(target, adrNames) {
  const match = ADR_ID_RE.exec(target);
  return match !== null && adrNames.some((name) => name.startsWith(`${match[1]}-`));
}

/**
 * Judge a code span: the reading *and* the verdict, from one base rule, so the
 * path a finding reports and the key `git check-ignore` and the allowlist chain
 * look up cannot come from different rules.
 *
 * A `./`- or `..`-rooted target is read from the containing file's directory and
 * nowhere else, as the Markdown half reads it; any other target is read from the
 * repository root first, then from that directory, with `repoPath` naming the
 * reading that resolved — the root reading when neither did. `null` when the
 * reading escapes the repository.
 */
export function judgeClaim(target, fromDir, ctx) {
  const readings = isFileRelativeTarget(target)
    ? [toRepoPath(ctx.root, fromDir, target)]
    : [toRepoPath(ctx.root, "", target), toRepoPath(ctx.root, fromDir, target)];
  const hit = readings.find((path) => path && isTracked(ctx.tree, path));
  return {
    repoPath: hit ?? readings[0] ?? null,
    status: hit ? "ok" : adrIdResolves(target, ctx.adrNames) ? "adr-id" : "missing",
  };
}

/**
 * Scan documents into findings. Pure: `sources` carry their own text, and
 * `ctx` carries the tree, the ADR names, the skill directories and the root.
 *
 * @param {{relPath: string, text: string}[]} sources
 * @param {{root: string, tree: object, adrNames: string[], skillDirs: Set<string>}} ctx
 */
export function analyse(sources, ctx) {
  const findings = [];
  // The one place a finding is built: every shape carries the same fields, with
  // `repoPath` explicit, and the path-shaped kinds hand over `judgeClaim`'s pair.
  const record = (kind, at, { status, repoPath = null }) => {
    findings.push({ kind, ...at, repoPath, status });
  };
  for (const { relPath, text } of sources) {
    const dir = dirname(relPath);
    for (const [i, line] of prose(text).entries()) {
      const at = (target) => ({ file: relPath, line: i + 1, target });
      for (const match of line.matchAll(LINK_RE)) {
        const raw = match[1];
        // External, mailto and same-page anchors are out of scope — see the header.
        if (/^(?:https?:|mailto:|tel:|#|\/\/)/.test(raw)) continue;
        // A leading `/` resolves differently across Markdown renderers, so it is
        // a violation rather than a guess; a future one should be an explicit
        // decision.
        if (raw.startsWith("/")) {
          record("link", at(raw), { status: "root-absolute" });
          continue;
        }
        const [pathPart] = raw.split("#");
        if (!pathPart) continue; // pure anchor: `#section` handled above
        let destination;
        try {
          destination = decodeURIComponent(pathPart);
        } catch {
          // A malformed `%` escape cannot resolve, and the output contract is a
          // violation line per reference on the destination as written — never an
          // uncaught `URIError`.
          record("link", at(raw), { status: "malformed-encoding" });
          continue;
        }
        const rel = toRepoPath(ctx.root, dir, destination);
        record("link", at(raw), {
          // The repo-relative path whose absence is the violation, in the form
          // `git check-ignore` needs.
          repoPath: rel,
          status: rel && isTracked(ctx.tree, rel) ? "ok" : "missing",
        });
      }

      for (const { target: rawTarget, index } of inlineCodeSpans(line)) {
        // The claim test takes the raw span (its ellipsis rule needs the raw
        // dots); the reported target and the resolution take the normalised one.
        const target = normaliseSpanTarget(rawTarget);
        if (isSkillName(target) && skillMentionAt(line, rawTarget, index)) {
          record("skill", at(target), {
            repoPath: `.agents/skills/${target}/SKILL.md`,
            status: ctx.skillDirs.has(target) ? "ok" : "missing",
          });
          continue;
        }
        if (!isPathClaim(rawTarget, ctx.tree)) continue;
        // One reading, one verdict, one object — `judgeClaim` returns both.
        record("path", at(target), judgeClaim(target, dir, ctx));
      }
    }
  }
  return findings;
}

/** A status that means the target was found; anything else needs the policy. */
export const RESOLVED_STATUSES = new Set(["ok", "adr-id"]);

/**
 * The table in precedence order, highest `priority` first: precedence is a field,
 * not the array's source order, so permuting `POLICY` changes no verdict.
 */
export function policyOrder(table = POLICY) {
  return [...table].sort((a, b) => b.priority - a.priority);
}

/**
 * The one rule that governs a finding: the highest-priority match, never the
 * first. A shape no rule covers fails loud rather than taking the wrong chain.
 */
export function policyFor(finding, table = POLICY) {
  const rule = policyOrder(table).find((candidate) => candidate.match(finding));
  if (!rule) throw new Error(`no policy rule for ${finding.kind}/${finding.status}`);
  return rule;
}

/**
 * Apply the policy table to findings. Every missing reference — Markdown link or
 * code span, living doc or record — is offered the same exemption chain
 * (gitignored, then allowlisted), so neither shape can be red with no escape.
 * Dead claims inside records are counted, not enforced. Every allowlist entry
 * whose file the gate scanned but whose dead reference it did not match is a
 * violation too, so the list cannot rot.
 *
 * `files` is the set of documents the gate read: an entry naming a file outside
 * that corpus is not evaluable. `table` is the rule set, defaulting to `POLICY`.
 *
 * @param {object[]} findings from `analyse`
 * @param {{allowlist?: object[], ignored?: Set<string>, files?: Set<string>,
 *   table?: object[]}} [policy]
 */
export function adjudicate(findings, policy = {}) {
  const allowlist = policy.allowlist ?? KNOWN_RETIRED;
  const ignored = policy.ignored ?? new Set();
  const files = policy.files;
  const table = policy.table ?? POLICY;
  const violations = [];
  const counters = {
    links: 0,
    claims: 0,
    skills: 0,
    resolved: 0,
    recordsClaims: 0,
    recordsDead: 0,
    ignored: 0,
    allowlisted: 0,
  };
  const used = new Set();

  for (const finding of findings) {
    const rule = policyFor(finding, table);
    counters[rule.counter] += 1;
    if (rule.also) rule.also(finding, counters);

    if (rule.verdict === "violation") {
      violations.push({ ...finding, reason: rule.reason(finding) });
      continue;
    }
    if (finding.status !== "missing") {
      if (rule.countsResolved && RESOLVED_STATUSES.has(finding.status)) counters.resolved += 1;
      continue;
    }
    if (rule.verdict === "counted") continue; // a record's dead claim

    // THE ONE EXEMPTION CHAIN — shape-independent, which is the point.
    if (ignored.has(finding.repoPath)) {
      counters.ignored += 1;
      continue;
    }
    const entry = allowlist.find((e) => e.file === finding.file && e.target === finding.target);
    if (entry) {
      used.add(entry);
      counters.allowlisted += 1;
      continue;
    }
    violations.push({ ...finding, reason: rule.reason(finding) });
  }

  for (const entry of allowlist) {
    if (used.has(entry)) continue;
    if (files && !files.has(entry.file)) continue; // not this corpus — not evaluable
    violations.push({
      kind: "stale-allowlist",
      file: entry.file,
      line: null,
      target: entry.target,
      reason: `stale allowlist entry: no dead reference matches it (${entry.reason}) — delete it`,
    });
  }

  return { violations, counters };
}

/** Walk the scan roots for `.md` files. */
export function walk(path, out = []) {
  const st = statSync(path);
  if (st.isFile()) {
    if (path.endsWith(".md")) out.push(path);
    return out;
  }
  for (const name of readdirSync(path)) {
    // Vendored READMEs are not this repository's prose, and the node_modules
    // symlinks would report one upstream README once per dependent package.
    if (name === "node_modules" || name === ".scratch") continue;
    walk(join(path, name), out);
  }
  return out;
}

function git(root, args, input) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * A missing `adr/` or `.agents/skills/` means the directory is gone, not that the
 * rule is off: every reference is then reported dangling, never skipped.
 */
function listing(dir, options) {
  try {
    return readdirSync(dir, options);
  } catch {
    return [];
  }
}

/** The committed tree, from one `git ls-files`. */
export function buildContext(root) {
  let listed;
  try {
    listed = git(root, ["ls-files", "-z"]);
  } catch {
    console.error(
      "markdown-links: not a git checkout — this gate resolves references against the " +
        "committed tree, so it must run inside the repository (see the header).",
    );
    process.exit(1);
  }
  const tree = makeTree(listed.split("\0").filter(Boolean));
  const adrNames = listing(join(root, "adr"));
  const skillDirs = new Set(
    listing(join(root, ".agents", "skills"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && tree.files.has(`.agents/skills/${e.name}/SKILL.md`))
      .map((e) => e.name),
  );
  return { root, tree, adrNames, skillDirs };
}

/** Which of these targets does git ignore? One bulk `git check-ignore`. */
export function ignoredTargets(root, targets) {
  const unique = [...new Set(targets)];
  if (unique.length === 0) return new Set();
  try {
    const out = git(root, ["check-ignore", "--stdin"], unique.join("\n") + "\n");
    return new Set(out.split("\n").filter(Boolean));
  } catch {
    return new Set(); // exit 1: nothing is ignored
  }
}

/** Read the scan roots for `root`, the same way the CLI does. */
export function loadCorpus(root) {
  const files = ROOTS.map((r) => join(root, r))
    .filter((p) => existsSync(p))
    .flatMap((p) => walk(p));
  return {
    root,
    files,
    sources: files.map((file) => ({
      relPath: file.slice(root.length + 1),
      text: readFileSync(file, "utf8"),
    })),
  };
}

/**
 * The whole gate, as a function of the repository root: corpus, findings, policy,
 * verdict and counters. `main()` and the real-tree tests both go through it, so
 * neither can drift from the other.
 */
export function runGate(root) {
  const ctx = buildContext(root);
  const { files, sources } = loadCorpus(root);
  const findings = analyse(sources, ctx);
  const dead = findings.filter((f) => f.status === "missing");
  const policy = {
    files: new Set(sources.map((s) => s.relPath)),
    // Every dead reference, whichever shape it arrived in — one chain.
    ignored: ignoredTargets(root, dead.map((f) => f.repoPath).filter(Boolean)),
  };
  return { root, files, sources, findings, policy, ...adjudicate(findings, policy) };
}

/**
 * The OK line is part of the contract, not a log message: it names what was
 * checked, what resolved, and every exemption taken, so a green run cannot hide a
 * narrowing. The arithmetic closes: `links + claims + skills === resolved +
 * ignored + allowlisted`.
 */
export function formatOkLine(counters, fileCount) {
  return (
    `markdown-links: OK (${counters.links} relative links + ${counters.claims} code-span path ` +
    `claims + ${counters.skills} skill names checked across ${fileCount} files; ` +
    `${counters.resolved} resolve, ${counters.allowlisted} known-retired allowlisted, ` +
    `${counters.ignored} gitignored build paths skipped; ${counters.recordsClaims} record-file ` +
    `claims counted, ${counters.recordsDead} dead claims inside record files unchecked)`
  );
}

function main() {
  const { files, violations, counters } = runGate(ROOT);

  if (violations.length > 0) {
    console.error(
      `markdown-links: ${violations.length} dangling reference(s) across ${files.length} files\n`,
    );
    for (const v of violations) {
      const where = v.line === null ? v.file : `${v.file}:${v.line}`;
      console.error(`  ${where} -> ${v.target}  (${v.reason})`);
    }
    console.error("\nA dangling doc reference is a broken citation, not a typo: fix the path, or");
    console.error("restore the target. See this script's header for why it is a gate.");
    process.exit(1);
  }

  console.log(formatOkLine(counters, files.length));
}

// Run only when invoked as a script, not when imported by tests.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
