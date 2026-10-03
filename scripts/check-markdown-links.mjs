#!/usr/bin/env bun
/**
 * Doc reference-resolution gate — the driver.
 *
 * THE CONTRACT, in full, is the header of `./markdown-links/policy.mjs`: the
 * invariant, the resolution base, every scope rule and class rule with its named
 * cost, and the policy data below it. Read that header to know what this gate
 * enforces and what it deliberately does not; read this file for how it runs.
 *
 * This half is the mechanism: read the scan roots (the committed tree — never
 * the working tree), parse prose and inline code spans, judge each reference
 * through `judgeClaim` (one reading, one verdict), and adjudicate the findings
 * against the policy table. Exits non-zero and prints `file:line -> target
 * (reason)` for each dangling reference, plus any stale allowlist entry.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAIM_ROOTS, KNOWN_RETIRED, POLICY, ROOTS } from "./markdown-links/policy.mjs";

/**
 * `dirname(fileURLToPath(import.meta.url))` rather than Bun's `import.meta.dir`:
 * this module is imported by `tests/scripts/check-markdown-links.test.mjs`,
 * which runs under Vitest on Node, where `import.meta.dir` is undefined.
 *
 * The gate is self-rooting — it reads its repository from its own location, so a
 * caller's cwd cannot point it at a different tree — and this line is what
 * carries that, not the layout beside it.
 */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const SPAN_RE = /`([^`\n]+)`/g;
export const ADR_ID_RE = /^adr\/(\d{4})$/;
const SKILL_NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Strip fenced code blocks before scanning. A link or code span written inside
 * a fence is an example, not a citation — a doc that illustrates a shape must
 * be able to do so without claiming the path in it exists. Indented (4-space)
 * blocks are not stripped: this repository uses fences throughout, and treating
 * indentation as code would silently skip real links in nested list items.
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

/** The tracked tree as three sets: files, their ancestor directories, root files. */
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
 * WHAT PART OF A SPAN IS THE CLAIM — the span normaliser.
 *
 * Prose swallows punctuation into an inline span, and a citation carries a
 * pointer into its target. Neither is part of the path, and neither may turn a
 * good reference red: `docs/X.md,`, `docs/X.md#L24` and `scripts/x.mjs:42-58`
 * are claims on `docs/X.md` and `scripts/x.mjs`. This mirrors the link half,
 * which strips its `#fragment` before resolving. Without it the two halves
 * disagree, and a line citation — the sanctioned way to point at a line — would
 * block every PR that used one.
 *
 * The order is the contract: swallowed punctuation first (it is what hides the
 * rest), then a fragment, then a line citation — so `path:42-58,`,
 * `path#L24,` and even `path:42#L7` all reduce to `path`. The ellipsis rule in
 * `isPathClaim` is tested on the *raw* text, before this runs, because trimming
 * a trailing `.` would eat the third dot of `...` and turn a display label into
 * a path (class D).
 *
 * A caller that resolves a span must normalise with this too, or it will
 * resolve the citation; `analyse` is the one that matters and it does.
 */
export function normaliseSpanTarget(text) {
  return text
    .trim()
    .replace(/[.,;:!?'")\]]+$/, "") // punctuation the prose swallowed into the span
    .replace(/#.*$/, "") // `path#L24` — an in-file fragment
    .replace(/:\d+(?:-\d+)?$/, ""); // `path:42`, `path:42-58` — a line citation
}

/**
 * Is this a target written against the containing file rather than against the
 * repository root — `..` itself, or anything under `../`? See SCOPE RULES.
 */
export function isFileRelativeTarget(target) {
  return target === ".." || target.startsWith("../");
}

/**
 * Is this code span a repo-path claim? See SCOPE RULES in the header — the
 * order of these checks is the contract, and each one names its class. The
 * text is normalised first (`normaliseSpanTarget`), so callers may pass the raw
 * span; callers that then *resolve* it must normalise as well.
 */
export function isPathClaim(text, tree) {
  const raw = text ?? "";
  // On the raw text, not the normalised one: trimming swallowed punctuation
  // would eat the third dot of `...`, and a display label would come back as a
  // claim on `adr/0043-`.
  if (/…|\.\.\./.test(raw)) return false; // elided display labels (class D)
  const target = normaliseSpanTarget(raw);
  if (!target) return false;
  if (/\s/.test(target)) return false; // `bun run lint`, command lines
  if (/[*?[\]{}]/.test(target)) return false; // `**/*.ts`
  if (/[<>]/.test(target)) return false; // `<slug>`, `<role>`, `<label>`
  if (/^(?:https?:|mailto:|tel:|#|\/\/)/.test(target)) return false; // URLs, anchors
  if (target.startsWith("/")) return false; // not repo-relative
  // `..`-rooted: a claim by its form, never by its reading's first segment. The
  // rules above already reject every non-path shape, and re-testing the reading
  // against CLAIM_ROOTS would veto a target the link half reddens on (from
  // `adr/`, `../web/dist` reads as `web/dist`, and `web` is not a tracked root).
  // See SCOPE RULES — #391.
  if (isFileRelativeTarget(target)) return true;
  if (!target.includes("/")) return tree.rootFiles.has(target);
  return CLAIM_ROOTS.includes(target.split("/")[0]);
}

/** A bare kebab-case token: candidate for the skill-name half. */
export function isSkillName(target) {
  return SKILL_NAME_RE.test(target);
}

/**
 * Is the span at `index` on `line` adjacent to the word `skill` — either
 * `` `x` skill `` or `skill `x``? The marker is the claim; see SKILLS_RULE.
 */
export function skillMentionAt(line, name, index) {
  const before = line.slice(0, index);
  const after = line.slice(index);
  if (/\bskills?\s+$/i.test(before)) return true;
  // A literal comparison, not a `RegExp` built from the span text: skill names
  // are `[a-z0-9-]+` so there is nothing to escape, and a dynamic regex over
  // file content is a ReDoS surface (Semgrep
  // javascript.lang.security.audit.detect-non-literal-regexp blocks it).
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
 * Judge a code span: the reading *and* the verdict, from one base rule. What
 * `toRepoPath` returns under that rule is the path the finding reports and the
 * key `git check-ignore` and the allowlist chain look up, so the two can never
 * come from different rules (B2) — the disagreement that let a re-entry target
 * be `ok` as a span and `missing` as a link, and let a finding carry `status ok`
 * beside a `repoPath` that does not exist (A1).
 *
 * The base rule, chosen once, here:
 *   - a `..`-rooted target is read from the containing file's directory and
 *     nowhere else, exactly as the Markdown half reads the identical
 *     destination (see SCOPE RULES);
 *   - every other target is read from the repository root first, then from the
 *     containing file's directory — the second base the header blesses for the
 *     `packages/infra/README.md` control. `repoPath` names the reading that
 *     actually resolved, falling back to the root reading so a dead target still
 *     reports the form the exemptions look up.
 *
 * `null` when the reading escapes the repository (#391): a target naming a path
 * outside it, which neither exemption can reach.
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
  /**
   * The one place a finding is built: every shape carries the same fields, with
   * `repoPath` explicit rather than present-or-absent by branch. A branch names
   * the shape it saw and, for the two path-shaped kinds, hands over the
   * `{ repoPath, status }` pair `judgeClaim` produced — it never assembles one
   * from a status read here and a path read there.
   */
  const record = (kind, at, { status, repoPath = null }) => {
    findings.push({ kind, ...at, repoPath, status });
  };
  for (const { relPath, text } of sources) {
    const dir = dirname(relPath);
    for (const [i, line] of prose(text).entries()) {
      const at = (target) => ({ file: relPath, line: i + 1, target });
      for (const match of line.matchAll(LINK_RE)) {
        const raw = match[1];
        // External, protocol-relative, mailto, and same-page anchors are out
        // of scope — see the header.
        if (/^(?:https?:|mailto:|tel:|#|\/\/)/.test(raw)) continue;
        // A leading `/` means "relative to the repository root" in most
        // Markdown renderers used with a `base`, but GitHub resolves it to the
        // domain root. Rather than guess, treat it as a violation: this repo has
        // none, and a future one should be an explicit decision.
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
          // #392: a malformed `%` escape cannot resolve, and the output
          // contract is a violation line per reference — never an uncaught
          // `URIError` with no `file:line -> target` to act on. Reported on the
          // destination as the document wrote it, which is what a reader sees.
          record("link", at(raw), { status: "malformed-encoding" });
          continue;
        }
        const rel = toRepoPath(ctx.root, dir, destination);
        record("link", at(raw), {
          // The repo-relative path whose absence is the violation — the form
          // `git check-ignore` needs, and the key the exemption chain looks up.
          repoPath: rel,
          status: rel && isTracked(ctx.tree, rel) ? "ok" : "missing",
        });
      }

      for (const { target: rawTarget, index } of inlineCodeSpans(line)) {
        // The claim test takes the raw span (its ellipsis rule needs the raw
        // dots); the reported target and the resolution take the normalised
        // one — `docs/X.md:42` is a claim on `docs/X.md`.
        const target = normaliseSpanTarget(rawTarget);
        if (isSkillName(target) && skillMentionAt(line, rawTarget, index)) {
          record("skill", at(target), {
            repoPath: `.agents/skills/${target}/SKILL.md`,
            status: ctx.skillDirs.has(target) ? "ok" : "missing",
          });
          continue;
        }
        if (!isPathClaim(rawTarget, ctx.tree)) continue;
        // One reading, one verdict, one object — `judgeClaim` decides the base
        // and returns both, so this kind cannot report them from two rules.
        record("path", at(target), judgeClaim(target, dir, ctx));
      }
    }
  }
  return findings;
}

/** A status that means the target was found; anything else needs the policy. */
export const RESOLVED_STATUSES = new Set(["ok", "adr-id"]);

/**
 * The table in precedence order — highest `priority` first. Precedence is a
 * field, not the array's source order, so permuting `POLICY` cannot change which
 * rule a shape gets; a test runs the adjudicator over a reversed table and
 * asserts identical verdicts.
 */
export function policyOrder(table = POLICY) {
  return [...table].sort((a, b) => b.priority - a.priority);
}

/**
 * The one rule that governs a finding: the highest-priority match, never the
 * first. A shape no rule covers fails loud rather than silently taking the wrong
 * chain.
 */
export function policyFor(finding, table = POLICY) {
  const rule = policyOrder(table).find((candidate) => candidate.match(finding));
  if (!rule) throw new Error(`no policy rule for ${finding.kind}/${finding.status}`);
  return rule;
}

/**
 * Apply the policy table to findings. Every missing reference — Markdown link
 * or code span, living doc or record — is offered the same exemption chain
 * (gitignored, then allowlisted), so neither shape can be red with no escape.
 * Dead claims inside records are counted, not enforced. Every allowlist entry
 * whose file the gate scanned but whose dead reference it did not match is a
 * violation too, so the list cannot rot.
 *
 * `files` is the set of documents the gate read. An entry naming a file that is
 * not in that corpus (a fixture checkout, say) cannot be evaluated and is not
 * reported stale — but the same entry against the real corpus is, which is the
 * property that keeps the list honest.
 *
 * `table` is the rule set, defaulting to `POLICY`; it exists so a test can hand
 * this function a permuted table and prove the verdicts do not move (B5).
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
    // Vendored READMEs are not this repository's prose: `node_modules` holds
    // third-party packages whose own internal links are theirs to keep, and
    // `packages/*/node_modules/@app/*` symlinks would report each upstream
    // README once per dependent package.
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
 * A missing `adr/` or `.agents/skills/` means the directory is gone, not that
 * the rule is off: with no names to match, every `adr/NNNN` and every skill
 * mention is reported as dangling. Failing loud is the point.
 */
function listing(dir, options) {
  try {
    return readdirSync(dir, options);
  } catch {
    return [];
  }
}

/** The committed tree: one `git ls-files`, then one `git check-ignore` for the dead ends. */
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
 * The whole gate, as a function of the repository root: the corpus, the
 * findings, the policy that judged them, the verdict and the counters. `main()`
 * prints this and the real-tree tests assert on it, so the suite cannot keep
 * passing against wiring the CLI no longer has — the driver used to exist twice
 * (`main()` and the tests' `realScan()`), and the tests' copy was free to drift.
 */
export function runGate(root) {
  const ctx = buildContext(root);
  const { files, sources } = loadCorpus(root);
  const findings = analyse(sources, ctx);
  const dead = findings.filter((f) => f.status === "missing");
  const policy = {
    files: new Set(sources.map((s) => s.relPath)),
    // Every dead reference, whichever shape it arrived in — one chain (A1).
    ignored: ignoredTargets(root, dead.map((f) => f.repoPath).filter(Boolean)),
  };
  return { root, files, sources, findings, policy, ...adjudicate(findings, policy) };
}

/**
 * The OK line is part of the contract, not a log message: it names what was
 * checked, what actually resolved, and every exemption the run took, so a green
 * run cannot hide a narrowing. On a green run the arithmetic closes —
 * `links + claims + skills === resolved + ignored + allowlisted` — and a test
 * asserts exactly that.
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
