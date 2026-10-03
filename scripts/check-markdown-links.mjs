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
 *   a root-only rule would redden that honest reference. The claim test reads a
 *   target the same way, and that is the point: a `..`-rooted span is a claim
 *   whose *reading* is the containing file's directory, so it reaches the
 *   file-relative base instead of being vetoed on a raw first segment (`..`)
 *   that is not a tracked root (#391). Markdown links keep
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
 *   The span is normalised before any of that: a trailing line citation
 *   (`path:42`, `path:42-58`), an in-file fragment (`path#L24`) and punctuation
 *   the prose swallowed into the span (`docs/X.md,`) are not part of the path,
 *   so `docs/X.md:42` is a claim on `docs/X.md` and is checked as one
 *   (`normaliseSpanTarget`). This is the rule the link half already applied to
 *   its `#fragment`; without it the two halves disagreed, and a line citation —
 *   the sanctioned way to point at a line — would redden a correct document.
 *
 *   A target that climbs out of its own directory — `..` alone, or anything
 *   under `../` — is a claim by its form (#391). Its *reading* is the containing
 *   file's directory, the second base above, and that is what decides where it
 *   resolves; the reading is deliberately not re-tested against CLAIM_ROOTS,
 *   because the tracked-root rule is a substitute for the "is this a path?"
 *   signal that a `..`-rooted token already carries — retesting it would veto
 *   `../web/dist` (which reads as `web/dist`) while the link half reddens on the
 *   identical target. Before this rule the raw first segment `..` vetoed the
 *   whole class, so a dead `../../../docs/x.md` in a living doc stayed green
 *   while the identical target in link form was red: one target, two verdicts,
 *   and the disagreement failed **open**.
 *
 *   ESCAPING TARGETS — decided, not inherited: a `..`-rooted target whose
 *   reading leaves the repository (`../../etc/passwd`) is a claim, and a missing
 *   one is a violation. That is what the Markdown-link half already does with
 *   the identical destination — `toRepoPath` returns `null`, `repoPath` stays
 *   empty, and neither exemption is reachable — so the span half agrees with it
 *   rather than leaving a class that is neither judged nor declared. COST,
 *   named: an inline span naming a path outside this repository must be written
 *   inside a fence (an example, not a citation) or as prose, or it reddens.
 *   `~/.dsh/settings.yaml` is a different class and is unaffected: it is not
 *   `..`-rooted, and its first segment is not a tracked root.
 *
 *   The one `..` case that stays out, named so it is not silently dropped: a
 *   *bare* `..` — a span that is nothing but the two dots — is stripped by the
 *   span normaliser as swallowed punctuation, so the span half never claims it.
 *   `../` and everything under it do claim. The halves part company on that one
 *   token: `[x](..)` reddens in the link half, whose `toRepoPath` folds the
 *   repository root to `""` and reads it as missing — a reading that same half
 *   contradicts from a deeper directory, where `..` resolves to a tracked parent
 *   (`.agents/skills/ship/` → `.agents/skills`). Copying it would import the
 *   defect rather than the judgement, so it is declared here and pinned by a
 *   test instead; the link half's root reading is a neighbouring defect this
 *   change does not touch.
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
 *     - a `./`-rooted span (`./apps/web/dist`) is out by the same tracked-root
 *       rule. The link half reddens on the identical destination; widening it
 *       here would redden two correct documents, `docs/VPS-SETUP.md` and
 *       `docs/VPS-OPERATIONS.md`, which quote `./apps/web/dist` as the *literal*
 *       value of the asset handler's default. Declared, not silently dropped —
 *       the divergence is real and needs its own decision, not this one.
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
 *   B — an artifact its own ADR retired: 43 spans across the 13 files of `adr/`
 *       at the time of writing (ADR-0030 names `scripts/template-sync/` because
 *       it retired it), plus 2 in the executed cutover log — 45 dead claims over
 *       14 record files in total. RECORDS_RULE below covers the class.
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
 *   so those 45 spans cannot be repaired, only exempted — and an allowlist of
 *   45 entries across 14 files is not the "tiny, reasoned" kind this gate
 *   tolerates. This is the rule instead, stated with its cost:
 *
 *     WHICH FILE IS A RECORD (the membership rule): `RECORD_DIRS` /
 *     `RECORD_FILES` may only list a document whose content is an executed log
 *     or a decision record — a file whose *past tense is the point*: the ADR
 *     that retired an artifact, the cutover that executed a procedure. A living
 *     how-to, a spec or a skill never joins it, because a reader is meant to act
 *     on those. Adding a file is a deliberate, reviewable line in the diff, and
 *     the dead count printed on every run is what makes the narrowing's growth
 *     visible; a test asserts each member is a tracked path.
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
 *   cannot outlive the mention it silences. An entry matches the target **as
 *   the document writes it** — the normalised code span, or a link's
 *   destination — and either shape can be silenced by it. The count is printed
 *   in the OK line. Residual risk, named: an entry silences that (file, target)
 *   pair wherever it appears in that file, so if `SPECS.md` later routes a
 *   reader to `packages/local-first` as though it existed, the entry would hide
 *   it.
 *
 * THE POLICY TABLE — one shape → rule matrix, in `POLICY`
 *
 *   Which shape gets which rule is data in this script, not the order of the
 *   `if`s that used to encode it. That order was a defect generator: the
 *   Markdown-link half was handled first and `continue`d, so the gitignore and
 *   allowlist exemptions were unreachable for links — a link to a build output
 *   was red with no escape, while the identical target in a code span was
 *   skipped and counted. Now every rule names its counter and its verdict, and
 *   every *missing* reference — link or span, living doc or record — is offered
 *   the same chain: gitignored (derived from `.gitignore`, not from a list) →
 *   allowlisted (with a reason) → violation. A destination that cannot be
 *   decoded at all never reaches that chain: it is a violation of its own, with
 *   its own reason (#392).
 *
 *   PRECEDENCE IS A FIELD, not the table's order: `policyFor` takes the matching
 *   rule with the highest `priority`, so permuting `POLICY` cannot change which
 *   rule a shape gets. That is why every rule carries a `priority` and why the
 *   `record` rule's predicate is disjoint from the link rules instead of merely
 *   sitting after them: the array's first match used to decide, and moving
 *   `record` to the head — a pure reorder, no logic touched — stopped the 19
 *   Markdown links inside `adr/**` and the cutover log from being checked while
 *   the gate still printed OK and exited 0 (finding B5). Priorities are unique,
 *   so a tie cannot hand the decision back to source order; both properties are
 *   pinned by tests.
 *
 *   COST, named: a Markdown link to a gitignored build output is skipped and
 *   counted like a span, so a link a reader cannot follow in a fresh clone is
 *   not enforced. That is the price of the exemption being reachable for both
 *   halves at all; it is printed on every run, and a test pins both verdicts.
 *
 * SKILLS_RULE — a backticked kebab-case token adjacent to the word `skill`
 *   (`the `code-review` skill`, `skill `manager``) must name a directory under
 *   `.agents/skills/` that contains a `SKILL.md`. This is the half that would
 *   have caught #367 mechanically: both of its dead references were
 *   `` `agentic-workflow` skill ``-shaped. Measured at 07cb2914: 28 such
 *   references across the scanned roots — 23 in living docs, 5 in records —
 *   every one of them resolving.
 *
 *   Deliberately NOT extended to "the `X` role". Measured at 07cb2914, that
 *   marker has 37 hits over 11 distinct names, and they name three different
 *   things: 16 hits are live harness roles (`.zcode/agents/<role>.md` — `qa`,
 *   `reviewer`, `fixer`), 2 name `test-implementer`, a role ADR-0032 retired,
 *   and the remaining 19 are model-stage names (`embedder`, `cheap`,
 *   `decision-candidates`, `generator`, `kajianq`, …). The third class is a
 *   false-positive factory with no resolution target, which is why the marker
 *   is rejected as a whole — but the harness-role namespace
 *   (`.zcode/agents/<role>.md`) is a **second deliberately unchecked marker**,
 *   not an empty one, and this header says so rather than implying otherwise.
 *   A test pins that distinction.
 *
 *   COST, named: the marker *is* the claim, so a doc naming a skill that lives
 *   outside this repository (a harness-level skill such as `omarchy`) must not
 *   write it as `` `omarchy` skill ``. The failure message says so.
 *
 * Exits non-zero and prints `file:line -> target (reason)` for each dangling
 * reference, plus any stale allowlist entry. A Markdown destination whose
 * percent-encoding is malformed (`[pct](./100%.md)`) is one of those references:
 * it cannot resolve, so it is reported as a violation with its own reason
 * instead of escaping as an uncaught `URIError` that prints a stack trace and
 * no line for the contributor to act on (#392).
 *
 * A GREEN RUN PRINTS WHAT IT DID NOT CHECK. The OK line names how many
 * references were *checked* and how many actually *resolved*, then every
 * exemption the run took (`N known-retired allowlisted`, `N gitignored build
 * paths skipped`) and the record narrowing (`N record-file claims counted, N
 * dead claims inside record files unchecked`). "resolve" used to be the verb for
 * the checked total, which counted the exempted references as if they had been
 * proved.
 *
 * Exports the classifier, resolver, policy and gate driver — `loadCorpus`,
 * `runGate`, `formatOkLine` — for `tests/scripts/check-markdown-links.test.mjs`,
 * which drives the same function the CLI does instead of a second copy of it.
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
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
 * `.github/` and `.githooks/`, which the list omitted and which turned out to
 * carry 18 live references: 17 code-span path claims (16 under `.github/`, 1
 * under `.githooks/`) and one Markdown link, with 11 more claims inside records,
 * 3 of them dead. Counted with this gate's own `link`/`path`/`record` rules at
 * `b6827d0`; the targets are the deploy, staging and restore-drill workflows and
 * `.github/zap-rules.tsv`, cited by `SPECS.md`, `docs/ARCHITECTURE.md`, the
 * Art. 30 record and the `ship` skill. A new top-level directory is a new
 * claim root: add it here, or paths into it are unchecked.
 * `tests/scripts/check-markdown-links.test.mjs` fails if this list stops
 * covering the tracked tree, so that gap cannot open silently.
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
 * The repo-relative path a reference is *judged by*: the reading the resolution
 * contract uses. A target written against the repository root is read from the
 * root; a `..`-rooted one is read from the containing file's directory, the
 * second base the contract blesses. `null` when that reading escapes the
 * repository — a target naming a path outside it (#391).
 */
export function claimPath(root, fromDir, target) {
  return isFileRelativeTarget(target)
    ? toRepoPath(root, fromDir, target)
    : toRepoPath(root, "", target);
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
        let destination;
        try {
          destination = decodeURIComponent(pathPart);
        } catch {
          // #392: a malformed `%` escape cannot resolve, and the output
          // contract is a violation line per reference — never an uncaught
          // `URIError` with no `file:line -> target` to act on. Reported on the
          // destination as the document wrote it, which is what a reader sees.
          findings.push({
            kind: "link",
            file: relPath,
            line: i + 1,
            target: raw,
            repoPath: null,
            status: "malformed-encoding",
          });
          continue;
        }
        const rel = toRepoPath(ctx.root, dir, destination);
        findings.push({
          kind: "link",
          file: relPath,
          line: i + 1,
          target: raw,
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
          findings.push({
            kind: "skill",
            file: relPath,
            line: i + 1,
            target,
            repoPath: `.agents/skills/${target}/SKILL.md`,
            status: ctx.skillDirs.has(target) ? "ok" : "missing",
          });
          continue;
        }
        if (!isPathClaim(rawTarget, ctx.tree)) continue;
        const status =
          resolveClaim(target, dir, ctx) === "tracked"
            ? "ok"
            : adrIdResolves(target, ctx.adrNames)
              ? "adr-id"
              : "missing";
        findings.push({
          kind: "path",
          file: relPath,
          line: i + 1,
          target,
          // The reading the resolver judged — the root for a root-relative
          // target, the containing file's directory for a `..`-rooted one. That
          // is the form `git check-ignore` needs and the key the exemption chain
          // looks up, so both halves of one target reach the same chain.
          repoPath: claimPath(ctx.root, dir, target),
          status,
        });
      }
    }
  }
  return findings;
}

/** A status that means the target was found; anything else needs the policy. */
export const RESOLVED_STATUSES = new Set(["ok", "adr-id"]);

/**
 * THE POLICY TABLE — the shape → rule matrix, as data.
 *
 * This is deliberately a table rather than the order of `continue`s in
 * `adjudicate`: a rule set encoded as control flow is how the two halves of one
 * claim drifted apart in review (the code-span half consulted the gitignore and
 * allowlist exemptions; the Markdown-link half — handled by an earlier `if` —
 * could not reach them, so a link to a build output was red with no escape).
 *
 * Each rule: `match` picks the finding, `counter` names the count it advances,
 * `priority` is its precedence — the highest matching rule wins, never the
 * first one in the array (see PRECEDENCE above; the values must stay unique),
 * `verdict` is one of
 *   - `counted`    — never a violation (a record's dead claim, a resolving target);
 *   - `violation`  — always a violation, exemption chain not consulted;
 *   - `exemptible` — a *missing* target goes through the one chain below:
 *                    gitignored → allowlisted → violation.
 * `countsResolved: false` keeps a rule's findings out of the OK line's resolving
 * total (record claims are reported separately). A test asserts this table
 * covers every shape `analyse` can emit.
 */
export const POLICY = [
  {
    id: "link-root-absolute",
    priority: 40,
    match: (f) => f.kind === "link" && f.status === "root-absolute",
    counter: "links",
    verdict: "violation",
    reason: () => "root-absolute path (resolve it relative to the file instead)",
  },
  {
    // #392: the destination as written could not be decoded, so the reference
    // cannot resolve. A violation with its own reason, not the "target does not
    // exist" of a decoded miss and never an uncaught `URIError`. Above `link` by
    // priority, disjoint from it by `status`, so the malformed shape can never
    // fall to the wrong rule.
    id: "link-malformed-encoding",
    priority: 35,
    match: (f) => f.kind === "link" && f.status === "malformed-encoding",
    counter: "links",
    verdict: "violation",
    reason: () => "malformed percent-encoding in the link destination (write %25 for a literal %)",
  },
  {
    id: "link",
    priority: 30,
    match: (f) => f.kind === "link",
    counter: "links",
    verdict: "exemptible",
    countsResolved: true,
    reason: () => "target does not exist",
  },
  {
    // Disjoint from the link rules above, because a record's Markdown links stay
    // enforced (see RECORDS_RULE): only its code-span claims are counted. Above
    // `skill`/`path` by priority, so a record claim is never resolved — its
    // count is reported separately.
    id: "record",
    priority: 20,
    match: (f) => f.kind !== "link" && isRecord(f.file),
    counter: "recordsClaims",
    verdict: "counted",
    countsResolved: false,
    reason: () => "record of a moment: counted, not enforced",
    also: (finding, counters) => {
      if (finding.status === "missing") counters.recordsDead += 1;
    },
  },
  {
    id: "skill",
    priority: 10,
    match: (f) => f.kind === "skill",
    counter: "skills",
    verdict: "exemptible",
    countsResolved: true,
    reason: (f) => `skill name: no .agents/skills/${f.target}/SKILL.md`,
  },
  {
    id: "path",
    priority: 0,
    match: (f) => f.kind === "path",
    counter: "claims",
    verdict: "exemptible",
    countsResolved: true,
    reason: () => "code-span path: no such tracked path at the repo root or beside this file",
  },
];

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
