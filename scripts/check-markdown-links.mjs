#!/usr/bin/env bun
/**
 * Doc reference-resolution gate (Markdown links + inline code spans).
 *
 * THE INVARIANT. A living document that routes a reader to a path that does
 * not exist must redden `bun run docs:links`. Why this is a gate and not a
 * nice-to-have: this repository's docs cite each other as *evidence* — an
 * Art. 30 TOMs row points at the executed cutover log, the privacy notice
 * points at the register's decisions, a skill points at the runbook it
 * implements. A dangling one of those is not a typo; it is a compliance claim
 * whose proof has gone missing, and nothing else in CI would notice. GitHub
 * renders a dead relative link as ordinary text, so a reader cannot tell they
 * are looking at a broken citation either.
 *
 * This exists because the docs were consolidated (the VPS set was reduced to a
 * setup guide, an operations manual, and the evidence record) and every
 * deletion had to repoint its citations. Without this gate that repointing is
 * done by hand and verified by eye — the exact shape of check that rots.
 *
 * TWO SHAPES OF THE SAME CLAIM
 *
 *   1. `[text](relative/path)` — a Markdown link.
 *   2. `` `relative/path` `` — an inline code span naming a repo path, and
 *      `` `skill-name` skill `` — an inline code span naming a skill.
 *
 * Shape 2 was invisible until #368: agent-facing prose cites files as code
 * spans far more often than as links, and `AGENTS.md` routed every role to two
 * skills deleted in #133 while this gate stayed green. #367 repointed those
 * three references by hand; this gate is what would have caught them.
 *
 * RESOLUTION BASE — the committed tree, never the working tree.
 *
 *   A reference resolves when its target is in the git index: a tracked file,
 *   or a tracked directory (`apps/`, `.agents/skills/manager/`,
 *   `provision/vps/`). Two bases are tried for a code span — the repository
 *   root and the containing file's directory — and the span resolves if
 *   either finds it. `packages/infra/README.md` writes `scripts/db-migrate.mjs`
 *   meaning the package-relative `packages/infra/scripts/db-migrate.mjs`;
 *   a root-only rule would redden that honest reference. Markdown links keep
 *   their single, correct base: a renderer resolves `(path)` against the
 *   containing file and nothing else, so accepting a root-relative fallback
 *   there would hide a link that is broken on GitHub.
 *
 *   Why the index and not `existsSync`: `apps/web/dist/index.html` is cited by
 *   `docs/VPS-SETUP.md` and `docs/VPS-OPERATIONS.md` and is a *build output* —
 *   present after `bun run build:web`, absent in a fresh clone. A
 *   filesystem-resolving gate would be green for whoever just ran
 *   `bun run size-limit` and red in CI, so its verdict would measure the
 *   caller's build state rather than the commit. A gate that is not the same
 *   for every caller is not evidence. Targets git ignores are counted and
 *   skipped (`gitignored build paths` in the OK line), derived from
 *   `.gitignore` rather than a hand-kept list.
 *
 *   COST, named: a new file must be `git add`ed before the gate can see it,
 *   and a tracked file deleted from the working tree without being staged
 *   still counts as present. Both are the same rule working as intended —
 *   the gate resolves the commit, not the checkout.
 *
 * SCOPE RULES — what is a claim, and what is deliberately not
 *
 *   A code span is a repo-path claim when its text has no whitespace, no glob
 *   character (`*?[]{}`), no template placeholder (`<slug>`, `<role>`,
 *   `<label>`), no URL/anchor prefix (`https:`, `mailto:`, `tel:`, `#`, `//`),
 *   no ellipsis (`…`, `...`), and either starts with a tracked root — every
 *   top-level directory of the tree, listed in CLAIM_ROOTS — or is exactly a
 *   tracked root-level file name.
 *
 *   Each of those exclusions carries its class out of scope, deliberately:
 *     - whitespace → `bun run lint`, `git stash`, and every command line;
 *     - globs → `**\/*.ts`;  placeholders → `<slug>`;  URLs → `https://…`;
 *     - `~/.dsh/settings.yaml` is out by the tracked-root rule (its first
 *       segment is neither a tracked root nor a root-level file);
 *     - ellipsis → a truncated *display label*, never a path: class D of the
 *       #368 corpus (`adr/0037-…`, 5 spans). Where such a label is the text of
 *       a Markdown link, the link's own target is still resolved below.
 *     - a span inside a fenced code block is an example, not a citation (the
 *       `prose()` filter this gate has always applied).
 *     - root-absolute or `~`-rooted targets, and prose that merely mentions a
 *       path outside backticks, are not repo-relative claims.
 *
 *   COST, named: a bare file name that is *not* a tracked root-level file is
 *   not a claim, so `` `models.json` `` and `` `apply.sh` `` (both real files
 *   under subdirectories) stay prose, and a *deleted* root-level file named
 *   bare — `VPS-CUTOVER-RUNBOOK.md` — would not be caught. Measured, a wider
 *   "any bare dotted token" rule is a false-positive factory: 300+ such tokens
 *   are version strings (`4.0.0-rc.113`), TS member expressions
 *   (`Effect.runPromise`) or model ids (`glm-5.3`). A bare name only becomes a
 *   checked claim when it is a *path* (has a `/`) or is a tracked root file.
 *
 * CLASS RULES (the #368 corpus map, re-derived at 07cb2914 — see the PR body)
 *
 *   A — ADR cited by number: `` `adr/0045` `` in the spec's §8 Record of
 *       Decisions. `adr/NNNN` with exactly four digits resolves when at least
 *       one file in `adr/` is named `NNNN-*.md`. The four-digit requirement is
 *       the precision: `adr/004` and `adr/00455` are typos, not identifiers,
 *       and stay flagged. "At least one" rather than "exactly one" because the
 *       gate resolves identifiers, not numbering: `adr/0005` is deliberately
 *       carried by two files — the operative monorepo ADR and a
 *       template-heritage near-duplicate that declares itself superseded by
 *       ADR-0023 and states that the number `0005` belongs to the monorepo ADR.
 *       The spec's §8 row points at the operative one, and the identifier is
 *       real under either reading; a stricter rule would fail a correct row
 *       over a record the repository keeps on purpose. All 49 class-A spans
 *       resolve.
 *
 *   B — an artifact its own ADR retired: 43 spans across 13 files inside `adr/` at
 *       the time of writing (ADR-0030 names `scripts/template-sync/` because it
 *       retired it). RECORDS_RULE below covers the class.
 *
 *   C — a living doc naming an artifact that is gone: four spans total, in
 *       `SPECS.md` and `docs/ARCHITECTURE.md`, each narrating its target's
 *       removal (`Dropped from template: packages/local-first`, `Before the
 *       move, apps/api/alchemy.run.ts …`). Covered by KNOWN_RETIRED, below.
 *
 *   D — elided display labels, handled by the ellipsis scope rule above.
 *
 * RECORDS_RULE — `adr/**` and `docs/VPS-CUTOVER-RECORD.md` are *records of a
 *   moment*, not living docs: a path in them is evidence of what was, not an
 *   instruction to a reader. ADR-0030 names `scripts/template-sync/` precisely
 *   *because* it retired it; the cutover record is the executed log of a
 *   one-shot procedure. AGENTS.md forbids editing `adr/` to make a gate pass,
 *   so those 40 spans cannot be repaired, only exempted — and an allowlist of
 *   40 entries across 13 files is not the "tiny, reasoned" kind this gate
 *   tolerates. This is the rule instead, stated with its cost:
 *
 *     COST, named: dead code-span claims inside records are not failures. They
 *     are counted and printed on every green run (`N dead claims inside record
 *     files unchecked`), so the narrowing is visible and its growth is a
 *     reviewable diff, not a silent hole. The Markdown-link half still applies
 *     inside records — a record whose `[link](path)` rots is still red, and is
 *     still fixable — and `INITIAL_IDEA.md`, frozen history that nobody may
 *     edit, needs no exemption: it carries no dead claim today.
 *
 * KNOWN_RETIRED — an allowlist of four (file, target) pairs, one reason each,
 *   for the class-C living-doc spans that survive the records rule. It is
 *   deliberately tiny and self-pruning: every entry must still match a dead
 *   reference or the gate fails with `stale allowlist entry`, so an entry
 *   cannot outlive the mention it silences. The count is printed in the OK
 *   line. Residual risk, named: an entry silences that (file, target) pair
 *   wherever it appears in that file, so if `SPECS.md` later routes a reader to
 *   `packages/local-first` as though it existed, the entry would hide it.
 *
 * SKILLS_RULE — a backticked kebab-case token adjacent to the word `skill`
 *   (`the `code-review` skill`, `skill `manager``) must name a directory under
 *   `.agents/skills/` that contains a `SKILL.md`. This is the half that would
 *   have caught #367 mechanically: both of its dead references were
 *   `` `agentic-workflow` skill ``-shaped. Measured at 07cb2914: 29 such
 *   references across the scanned roots — 23 in living docs, 6 in records —
 *   every one of them resolving.
 *
 *   Deliberately NOT extended to "the `X` role": that marker has 21 unresolved
 *   hits which are all model-stage role names (`cheap`, `embedder`,
 *   `generator`), i.e. a false-positive factory.
 *
 *   COST, named: the marker *is* the claim, so a doc naming a skill that lives
 *   outside this repository (a harness-level skill such as `omarchy`) must not
 *   write it as `` `omarchy` skill ``. The failure message says so.
 *
 * Exits non-zero and prints `file:line -> target (reason)` for each dangling
 * reference, plus any stale allowlist entry.
 *
 * Exports the classifier, resolver and adjudicator for the unit tests in
 * `tests/scripts/check-markdown-links.test.mjs`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `dirname(fileURLToPath(import.meta.url))` rather than Bun's `import.meta.dir`:
 * this module is imported by `tests/scripts/check-markdown-links.test.mjs`,
 * which runs under Vitest on Node, where `import.meta.dir` is undefined.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Files scanned. `.agents/` and `.zcode/` are included deliberately: a skill
 * that points at a retired runbook sends the next agent somewhere that no
 * longer exists, which is how a repo teaches a stale procedure to an
 * autonomous worker.
 */
export const ROOTS = [
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

/**
 * First path segments that make an inline code span a repo-path claim. This is
 * every tracked top-level directory of the repository — the ticket's list plus
 * `.github/` and `.githooks/`, which carry no such span today and cost nothing
 * to include. A new top-level directory is a new claim root: add it here, or
 * paths into it are unchecked. `tests/scripts/check-markdown-links.test.mjs`
 * fails if this list stops covering the tracked tree, so that gap cannot open
 * silently.
 */
export const CLAIM_ROOTS = [
  "apps",
  "packages",
  "scripts",
  "docs",
  "adr",
  ".agents",
  ".zcode",
  ".githooks",
  ".github",
  "provision",
  "tests",
  "NOTICES",
];

/** Directories and files whose code spans are records of a moment. */
export const RECORD_DIRS = ["adr"];
export const RECORD_FILES = ["docs/VPS-CUTOVER-RECORD.md"];

/**
 * The complete allowlist. Every entry must still match a dead reference, or
 * the gate reports it as stale — see the header.
 */
export const KNOWN_RETIRED = [
  {
    file: "SPECS.md",
    target: "packages/local-first",
    reason:
      "§3.1 'Dropped from template' — the sentence's own subject is the pillar this repo dropped",
  },
  {
    file: "SPECS.md",
    target: "apps/api/alchemy.run.ts",
    reason:
      "§8 ADR-0028 row — records that the lifecycle this file owned was superseded by ADR-0044",
  },
  {
    file: "docs/ARCHITECTURE.md",
    target: "packages/local-first",
    reason: "'Deviated from the template' — names the local-first pillar as deliberately dropped",
  },
  {
    file: "docs/ARCHITECTURE.md",
    target: "apps/api/alchemy.run.ts",
    reason: "'Before the move' — past-tense reference to the retired app-file hosting path",
  },
];

const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const SPAN_RE = /`([^`\n]+)`/g;
export const ADR_ID_RE = /^adr\/(\d{4})$/;
const SKILL_NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Strip fenced code blocks before scanning. A markdown link written inside a
 * fence is an example, not a citation — this file's own header would otherwise
 * be scanned as prose. Indented (4-space) blocks are not stripped: this
 * repository uses fences throughout, and treating indentation as code would
 * silently skip real links in nested list items.
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
 * Is this code span a repo-path claim? See SCOPE RULES in the header — the
 * order of these checks is the contract, and each one names its class.
 */
export function isPathClaim(target, tree) {
  if (!target) return false;
  if (/\s/.test(target)) return false; // `bun run lint`, command lines
  if (/[*?[\]{}]/.test(target)) return false; // `**/*.ts`
  if (/[<>]/.test(target)) return false; // `<slug>`, `<role>`, `<label>`
  if (/^(?:https?:|mailto:|tel:|#|\/\/)/.test(target)) return false; // URLs, anchors
  if (/…|\.\.\./.test(target)) return false; // elided display labels (class D)
  if (target.startsWith("/")) return false; // not repo-relative
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
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const before = line.slice(0, index);
  const after = line.slice(index);
  return (
    /\bskills?\s+$/i.test(before) || new RegExp("^`" + escaped + "`\\s*skills?\\b", "i").test(after)
  );
}

/** Is this document a record of a moment rather than a living doc? */
export function isRecord(relPath) {
  return (
    RECORD_DIRS.some((d) => relPath === d || relPath.startsWith(`${d}/`)) ||
    RECORD_FILES.includes(relPath)
  );
}

/** `` `adr/0045` `` resolves against `adr/0045-*.md`; see class A in the header. */
export function adrIdResolves(target, adrNames) {
  const match = ADR_ID_RE.exec(target);
  return match !== null && adrNames.some((name) => name.startsWith(`${match[1]}-`));
}

/**
 * Resolve a code span: the repo root first, then the containing file's
 * directory. `"tracked"` or `"missing"` — the two bases are both honest
 * readings of a repo-relative path, and a target neither finds is dead under
 * either.
 */
export function resolveClaim(target, fromDir, ctx) {
  const viaRoot = toRepoPath(ctx.root, "", target);
  if (viaRoot && isTracked(ctx.tree, viaRoot)) return "tracked";
  const viaFile = toRepoPath(ctx.root, fromDir, target);
  if (viaFile && isTracked(ctx.tree, viaFile)) return "tracked";
  return "missing";
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
  for (const { relPath, text } of sources) {
    const dir = dirname(relPath);
    for (const [i, line] of prose(text).entries()) {
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
          findings.push({
            kind: "link",
            file: relPath,
            line: i + 1,
            target: raw,
            status: "root-absolute",
          });
          continue;
        }
        const [pathPart] = raw.split("#");
        if (!pathPart) continue; // pure anchor: `#section` handled above
        const rel = toRepoPath(ctx.root, dir, decodeURIComponent(pathPart));
        findings.push({
          kind: "link",
          file: relPath,
          line: i + 1,
          target: raw,
          status: rel && isTracked(ctx.tree, rel) ? "ok" : "missing",
        });
      }

      for (const { target, index } of inlineCodeSpans(line)) {
        if (isSkillName(target) && skillMentionAt(line, target, index)) {
          findings.push({
            kind: "skill",
            file: relPath,
            line: i + 1,
            target,
            status: ctx.skillDirs.has(target) ? "ok" : "missing",
          });
          continue;
        }
        if (!isPathClaim(target, ctx.tree)) continue;
        const status =
          resolveClaim(target, dir, ctx) === "tracked"
            ? "ok"
            : adrIdResolves(target, ctx.adrNames)
              ? "adr-id"
              : "missing";
        findings.push({ kind: "path", file: relPath, line: i + 1, target, status });
      }
    }
  }
  return findings;
}

/**
 * Apply the policy rules to findings: records are counted, not enforced;
 * `ignored` targets are build outputs; the allowlist silences named
 * exceptions; anything still missing is a violation. Every allowlist entry
 * whose file the gate scanned but whose dead reference it did not match is a
 * violation too, so the list cannot rot.
 *
 * `files` is the set of documents the gate read. An entry naming a file that is
 * not in that corpus (a fixture checkout, say) cannot be evaluated and is not
 * reported stale — but the same entry against the real corpus is, which is the
 * property that keeps the list honest.
 *
 * @param {object[]} findings from `analyse`
 * @param {{allowlist?: object[], ignored?: Set<string>, files?: Set<string>}} [policy]
 */
export function adjudicate(findings, policy = {}) {
  const allowlist = policy.allowlist ?? KNOWN_RETIRED;
  const ignored = policy.ignored ?? new Set();
  const files = policy.files;
  const violations = [];
  const counters = {
    links: 0,
    claims: 0,
    skills: 0,
    recordsClaims: 0,
    recordsDead: 0,
    ignored: 0,
    allowlisted: 0,
  };
  const used = new Set();

  for (const finding of findings) {
    if (finding.kind === "link") {
      counters.links += 1;
      if (finding.status === "root-absolute") {
        violations.push({
          ...finding,
          reason: "root-absolute path (resolve it relative to the file instead)",
        });
      } else if (finding.status === "missing") {
        violations.push({ ...finding, reason: "target does not exist" });
      }
      continue;
    }

    if (isRecord(finding.file)) {
      counters.recordsClaims += 1;
      if (finding.status === "missing") counters.recordsDead += 1;
      continue;
    }

    if (finding.kind === "skill") counters.skills += 1;
    else counters.claims += 1;
    if (finding.status !== "missing") continue;

    if (ignored.has(finding.target)) {
      counters.ignored += 1;
      continue;
    }

    const entry = allowlist.find((e) => e.file === finding.file && e.target === finding.target);
    if (entry) {
      used.add(entry);
      counters.allowlisted += 1;
      continue;
    }

    violations.push({
      ...finding,
      reason:
        finding.kind === "skill"
          ? `skill name: no .agents/skills/${finding.target}/SKILL.md`
          : "code-span path: no such tracked path at the repo root or beside this file",
    });
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

function main() {
  const ctx = buildContext(ROOT);
  const files = ROOTS.map((r) => join(ROOT, r))
    .filter((p) => existsSync(p))
    .flatMap((p) => walk(p));
  const sources = files.map((file) => ({
    relPath: file.slice(ROOT.length + 1),
    text: readFileSync(file, "utf8"),
  }));

  const findings = analyse(sources, ctx);
  const dead = findings.filter((f) => f.kind !== "link" && f.status === "missing");
  const { violations, counters } = adjudicate(findings, {
    files: new Set(sources.map((s) => s.relPath)),
    ignored: ignoredTargets(
      ROOT,
      dead.filter((f) => f.kind === "path").map((f) => f.target),
    ),
  });

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

  console.log(
    `markdown-links: OK (${counters.links} relative links + ${counters.claims} code-span path ` +
      `claims + ${counters.skills} skill names resolve across ${files.length} files; ` +
      `${counters.allowlisted} known-retired allowlisted; ${counters.ignored} gitignored build ` +
      `paths skipped; ${counters.recordsDead} dead claims inside record files unchecked)`,
  );
}

// Run only when invoked as a script, not when imported by tests.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
