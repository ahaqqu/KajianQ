/**
 * Doc reference-resolution gate (Markdown links + inline code spans) — THE
 * CONTRACT, and the policy it states as data.
 *
 * This module is the gate's stated contract: the invariant, the resolution base,
 * every scope rule and class rule with its named cost, then the same rules as
 * data — the scanned roots, the claim roots, record membership, the allowlist
 * and the shape → rule matrix. The driver that applies them is
 * `../check-markdown-links.mjs`; this header is what a reviewer checks that
 * driver against, which is why the contract and the data it governs live
 * together.
 *
 * THE INVARIANT. A living document that routes a reader to a path that does
 * not exist must redden `bun run docs:links`. Why this is a gate and not a
 * nice-to-have: this repository's docs cite each other as *evidence* — an
 * Art. 30 TOMs row points at the executed cutover log, the privacy notice
 * points at the register's decisions, a skill points at the runbook it
 * implements. A dangling one of those is not a typo; it is a compliance claim
 * whose proof has gone missing, and nothing else in CI would notice. GitHub
 * renders a dead relative link as ordinary text, so a reader cannot tell they
 * are looking at a broken citation either. Repointing citations by hand and
 * verifying them by eye is the exact shape of check that rots.
 *
 * TWO SHAPES OF THE SAME CLAIM
 *
 *   1. `[text](relative/path)` — a Markdown link.
 *   2. `` `relative/path` `` — an inline code span naming a repo path, and
 *      `` `skill-name` skill `` — an inline code span naming a skill.
 *
 * Agent-facing prose cites files as code spans far more often than as links,
 * which is why shape 2 is judged at all.
 *
 * RESOLUTION BASE — the committed tree, never the working tree.
 *
 *   A reference resolves when its target is in the git index: a tracked file,
 *   or a tracked directory. A root-relative code span is read against two bases
 *   — the repository root and the containing file's directory — and resolves if
 *   either finds it. `packages/infra/README.md` writes `scripts/db-migrate.mjs`
 *   meaning the package-relative `packages/infra/scripts/db-migrate.mjs`;
 *   a root-only rule would redden that honest reference.
 *
 *   A `./`- or `..`-rooted span is read against one base and one only: the
 *   containing file's directory. That is the reading the Markdown half gives the
 *   identical destination, and one base is what removes the disagreement a
 *   second, root base creates: a target that overshoots the file's directory and
 *   lands back inside the repository through the root directory's own name would
 *   be `ok` as a span and `missing` as a link. One judge produces the reading and
 *   the verdict together (`judgeClaim`), so a finding cannot report the verdict
 *   of one rule beside the path of another. Markdown links keep their single base
 *   for the same reason: a renderer resolves `(path)` against the containing file
 *   and nothing else, so accepting a root-relative fallback there would hide a
 *   link that is broken on GitHub.
 *
 *   Why the index and not `existsSync`: `apps/web/dist/index.html` is cited by
 *   `docs/VPS-SETUP.md` and `docs/VPS-OPERATIONS.md` and is a *build output* —
 *   present after a build, absent in a fresh clone — so a filesystem-resolving
 *   gate would measure the caller's build state rather than the commit. A gate
 *   that is not the same for every caller is not evidence. Targets git ignores
 *   are counted and skipped (`gitignored build paths` in the OK line), derived
 *   from `.gitignore` rather than a hand-kept list.
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
 *   tracked root-level file name. A target written against the containing file
 *   instead (`./`, `../`) is a claim by that form, and the two paragraphs below
 *   say what it claims.
 *
 *   The span is normalised before any of that: a trailing line citation
 *   (`path:42`, `path:42-58`), an in-file fragment (`path#L24`) and punctuation
 *   the prose swallowed into the span (`docs/X.md,`) are not part of the path,
 *   so `docs/X.md:42` is a claim on `docs/X.md` and is checked as one
 *   (`normaliseSpanTarget`). This is the rule the link half already applied to
 *   its `#fragment`; a line citation is the sanctioned way to point at a line,
 *   so it must not redden a correct document.
 *
 *   A target that climbs out of its own directory — `..` alone, or anything
 *   under `../` — is a claim by its form. Its *reading* is the containing file's
 *   directory, the second base above, and that reading decides where it resolves
 *   — the root base is not consulted for this class, so the verdict and the
 *   reported `repoPath` come from one rule and cannot disagree. The reading is
 *   deliberately not re-tested against CLAIM_ROOTS either, because the
 *   tracked-root rule is a substitute for the "is this a path?" signal that a
 *   `..`-rooted token already carries — retesting it would veto `../web/dist`
 *   (which reads as `web/dist`) while the link half reddens on the identical
 *   target.
 *
 *   A target under `./` is a claim by its form too, read from that same one base.
 *   `./` is the explicit "beside this file" prefix, so the span half judges it
 *   exactly as the Markdown half judges the identical destination, and neither
 *   the root base nor CLAIM_ROOTS is consulted — either would give one target
 *   two verdicts. A *value* that looks like such a target — the asset handler's
 *   inline default in `apps/api/src/lib/server.ts`
 *   (`env.KAJIANQ_WEB_ROOT ?? "./apps/web/dist"`), narrated by
 *   `docs/VPS-SETUP.md` and `docs/VPS-OPERATIONS.md` — is written as a fenced
 *   literal, the one rendering this gate already reads as "a value, not a
 *   citation" in **both** shapes, so a reader still sees the exact literal and
 *   the gate takes no exemption for it. DECIDED: the alternative was a "known
 *   literal" allowlist of its own, a mechanism whose only job is to let a dead
 *   reference pass green. A literal is not a claim, and the fence is how both
 *   halves are told so at once.
 *
 *   COST, named: a `./`-rooted span that *is* a citation is judged from the
 *   containing file, so a dead one reddens — that is the point — and a live one
 *   resolves only where the reader's renderer would. `./` names the containing
 *   directory, never the repository root, in both halves; the root spelling of
 *   the same target is the CLAIM_ROOTS form with no prefix, which keeps its
 *   second, file-relative base.
 *
 *   ESCAPING TARGETS: a `..`-rooted target whose reading leaves the repository
 *   (`../../etc/passwd`) is a claim, and a missing one is a violation. That is
 *   what the Markdown-link half does with the identical destination —
 *   `toRepoPath` returns `null`, `repoPath` stays empty, and neither exemption
 *   is reachable — so the span half agrees with it rather than leaving a class
 *   that is neither judged nor declared. COST, named: an inline span naming a
 *   path outside this repository must be written inside a fence (an example, not
 *   a citation) or as prose, or it reddens. `~/.dsh/settings.yaml` is a
 *   different class and is unaffected: it is not `..`-rooted, and its first
 *   segment is not a tracked root.
 *
 *   Two `..` cases are named rather than silently dropped. A *bare* `..` — a
 *   span that is nothing but the two dots — is stripped by the span normaliser
 *   as swallowed punctuation, so the span half never claims it, while `../` and
 *   everything under it do claim. The halves part company on that one token:
 *   `[x](..)` reddens in the link half, whose `toRepoPath` folds the repository
 *   root to `""` and reads it as missing. The span half does not copy that
 *   reading; the exception is declared here and pinned by a test.
 *
 *   A *bare* `../` — the token with its slash, which `isFileRelativeTarget`
 *   claims by form like everything under `../` — is judged `missing` from a
 *   depth-1 directory. Its reading is the repository root, whose repo-relative
 *   form is the empty string, and an empty reading is not a tracked path. From a
 *   deeper directory the same token reads as the tracked parent and is `ok`.
 *   The Markdown half reaches the identical verdicts on the identical
 *   destinations (`""` is falsy there too). Named because it is the one reading
 *   that looks as if it should resolve and does not.
 *
 *   The *bare* `.` is the same declared exception one token shorter: the span
 *   normaliser strips a lone dot as swallowed punctuation, so the span half never
 *   claims it, while `[x](.)` reads as the containing directory and resolves
 *   there. The halves part company on the token exactly as they do on `..`, and
 *   a test pins both directions rather than leaving either to be discovered.
 *
 *   Each of those exclusions carries its class out of scope, deliberately:
 *     - whitespace → `bun run lint`, `git stash`, and every command line;
 *     - globs → `**\/*.ts`;  placeholders → `<slug>`;  URLs → `https://…`;
 *     - `~/.dsh/settings.yaml` is out by the tracked-root rule (its first
 *       segment is neither a tracked root nor a root-level file);
 *     - ellipsis → a truncated *display label*, never a path (`adr/0037-…`).
 *       Where such a label is the text of a Markdown link, the link's own target
 *       is still resolved below.
 *     - a span inside a fenced code block is an example, not a citation (the
 *       `prose()` filter this gate applies).
 *     - root-absolute or `~`-rooted targets, and prose that merely mentions a
 *       path outside backticks, are not repo-relative claims.
 *     - a `./`-rooted target is a claim read against the containing file, and a
 *       *value* that looks like one is written inside a fence (above).
 *
 *   COST, named: a bare file name that is *not* a tracked root-level file is
 *   not a claim, so `` `models.json` `` and `` `apply.sh` `` (both real files
 *   under subdirectories) stay prose, and a *deleted* root-level file named
 *   bare — `VPS-CUTOVER-RUNBOOK.md` — would not be caught. A wider "any bare
 *   dotted token" rule is a false-positive factory: such tokens are mostly
 *   version strings (`4.0.0-rc.113`), TS member expressions
 *   (`Effect.runPromise`) or model ids. A bare name only becomes a
 *   checked claim when it is a *path* (has a `/`) or is a tracked root file.
 *
 * CLASS RULES
 *
 *   A — ADR cited by number: `` `adr/0045` `` in the spec's §8 Record of
 *       Decisions. `adr/NNNN` with exactly four digits resolves when a file in
 *       `adr/` is named `NNNN-*.md`; existence is the whole test, because the
 *       gate resolves identifiers, not numbering. The four-digit requirement is
 *       the precision: `adr/004` and `adr/00455` are typos, not identifiers, and
 *       stay flagged.
 *
 *   B — an artifact its own decision retired: a record names the path it
 *       removed, so the span is evidence of what was, not an instruction to a
 *       reader (the executed cutover log is the same shape). RECORDS_RULE below
 *       covers the class; the dead-claim count it leaves behind is printed on
 *       every green run.
 *
 *   C — a living doc naming an artifact that is gone, each span narrating its
 *       target's removal (`Dropped from template: packages/local-first`, `Before
 *       the move, apps/api/alchemy.run.ts …`). Covered by KNOWN_RETIRED, below.
 *
 *   D — elided display labels, handled by the ellipsis scope rule above.
 *
 * RECORDS_RULE — `adr/**` and `docs/VPS-CUTOVER-RECORD.md` are *records of a
 *   moment*, not living docs: a path in them is evidence of what was, not an
 *   instruction to a reader. A decision record that removed an artifact names
 *   it precisely *because* it removed it, and the cutover record is the
 *   executed log of a one-shot procedure. A dead span in a record is usually
 *   the record's own evidence of what it removed: repair would make the record
 *   claim what it never claimed, deletion would erase the evidence, so the span
 *   is exempted rather than repaired.
 *
 *   THE DISPOSITION RULE — a dead code-span claim in a record is history
 *   unless the target moved. History is usually the record naming what it
 *   removed or superseded: a repointed or deleted mention would claim what the
 *   record never claimed, so the span is kept when no surviving artifact still
 *   carries the rule it named. A target that still exists at another path
 *   moved, and the span is repointed at the artifact that carries the rule now;
 *   a malformed span is a defect and is repaired like any other. The count is
 *   therefore not a backlog to drive to zero: it is a baseline, and a growing
 *   allowlist of every dead span is not the "tiny, reasoned" kind this gate
 *   tolerates. This is the rule instead, stated with its cost:
 *
 *     WHICH FILE IS A RECORD (the membership rule): `RECORD_DIRS` /
 *     `RECORD_FILES` may only list a document whose content is an executed log
 *     or a decision record — a file whose *past tense is the point*: the ADR
 *     that retired an artifact, the cutover that executed a procedure. A living
 *     how-to, a spec or a skill never joins it, because a reader is meant to act
 *     on those. Adding a file is a deliberate, reviewable line in the diff; a
 *     test asserts each member is a tracked path.
 *
 *     COST, named: dead code-span claims inside records are not failures. They
 *     are counted and printed on every green run (`N dead claims inside record
 *     files unchecked`), so the narrowing is visible and its growth is a
 *     reviewable diff, not a silent hole. The Markdown-link half still applies
 *     inside records — a record whose `[link](path)` rots is still red, and is
 *     still fixable — and `INITIAL_IDEA.md`, frozen history that nobody may
 *     edit, needs no exemption.
 *
 *   THE CLAUSE GAP, named: the class-A rule (`adrIdResolves`) resolves an ADR
 *   *identifier* against the tree — does a file `adr/NNNN-*.md` exist — and
 *   never a clause *label* inside the record it names: `adr/0045` resolves, and
 *   `adr/0045 decision 2` passes whether or not that record has a decision 2,
 *   because a clause written into the span is not a path claim at all. A bare
 *   `ADR-0013` identifier is not resolved either — only `adr/NNNN` is. A clause
 *   citation is therefore never vouched for by this gate; opening it is a
 *   reviewer's obligation, not this gate's.
 *
 * KNOWN_RETIRED — an allowlist of (file, target) pairs, one reason each, for the
 *   living-doc spans that survive the records rule. It is deliberately tiny and
 *   self-pruning: every entry must still match a dead reference or the gate fails
 *   with `stale allowlist entry`, so an entry cannot outlive the mention it
 *   silences. An entry matches the target **as the document writes it** — the
 *   normalised code span, or a link's destination — and either shape can be
 *   silenced by it. The count is printed in the OK line. Residual risk, named: an entry silences that (file, target)
 *   pair wherever it appears in that file, so if `SPECS.md` later routes a
 *   reader to `packages/local-first` as though it existed, the entry would hide
 *   it.
 *
 * THE POLICY TABLE — one shape → rule matrix, in `POLICY`
 *
 *   Which shape gets which rule is data in this module, not the order of the
 *   `if`s that encode it. Every rule names its counter and its verdict, and
 *   every *missing* reference — link or span, living doc or record — is offered
 *   the same chain: gitignored (derived from `.gitignore`, not from a list) →
 *   allowlisted (with a reason) → violation. A destination that cannot be
 *   decoded at all never reaches that chain: it is a violation of its own, with
 *   its own reason.
 *
 *   PRECEDENCE IS A FIELD, not the table's order: `policyFor` takes the matching
 *   rule with the highest `priority`, so permuting `POLICY` cannot change which
 *   rule a shape gets. That is why every rule carries a `priority` and why the
 *   `record` rule's predicate is disjoint from the link rules instead of merely
 *   sitting after them. Priorities are unique, so a tie cannot hand the decision
 *   back to source order; both properties are pinned by tests.
 *
 *   COST, named: a Markdown link to a gitignored build output is skipped and
 *   counted like a span, so a link a reader cannot follow in a fresh clone is
 *   not enforced. That is the price of the exemption being reachable for both
 *   halves at all; it is printed on every run.
 *
 * SKILLS_RULE — a backticked kebab-case token adjacent to the word `skill`
 *   (`the `code-review` skill`, `skill `manager``) must name a directory under
 *   `.agents/skills/` that contains a `SKILL.md`. The gate reports its own
 *   population — the OK line's `N skill names checked` — so this comment states
 *   the marker and the resolution rule, and no hand-kept census drifts here on
 *   the next doc edit.
 *
 *   Deliberately NOT extended to "the `X` role". That marker names several
 *   different things: live harness roles (`.zcode/agents/<role>.md` — `qa`,
 *   `reviewer`, `fixer`), a price pair in prose (caught only because the marker
 *   is lexical), and model-stage names (`embedder`, `cheap`,
 *   `decision-candidates`, `generator`, `kajianq`, …). The last classes are a
 *   false-positive factory with no resolution target, which is why the marker is
 *   rejected as a whole — but the harness-role namespace
 *   (`.zcode/agents/<role>.md`) is a **second deliberately unchecked marker**,
 *   not an empty one. A test pins that distinction.
 *
 *   COST, named: the marker *is* the claim, so a doc naming a skill that lives
 *   outside this repository (a harness-level skill such as `omarchy`) must not
 *   write it as `` `omarchy` skill ``. The failure message says so.
 *
 * Exits non-zero and prints `file:line -> target (reason)` for each dangling
 * reference, plus any stale allowlist entry. A Markdown destination whose
 * percent-encoding is malformed (`[pct](./100%.md)`) is one of those references:
 * it cannot resolve, so it is reported as a violation with its own reason
 * instead of escaping as an uncaught `URIError` with no line for the contributor
 * to act on.
 *
 * A GREEN RUN PRINTS WHAT IT DID NOT CHECK. The OK line names how many
 * references were *checked* and how many actually *resolved*, then every
 * exemption the run took (`N known-retired allowlisted`, `N gitignored build
 * paths skipped`) and the record narrowing (`N record-file claims counted, N
 * dead claims inside record files unchecked`). The checked total never counts an
 * exempted reference as if it had been proved.
 *
 * The driver exports the classifier, resolver and gate functions — `loadCorpus`,
 * `runGate`, `formatOkLine` — for `tests/scripts/check-markdown-links.test.mjs`,
 * which drives the same functions the CLI does; the tables above are imported
 * from this module by the tests that pin them.
 */

/**
 * Files scanned. `.agents/` and `.zcode/` are included deliberately: a skill that
 * points at a retired runbook sends the next agent somewhere that no longer
 * exists.
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
 * First path segments that make an inline code span a repo-path claim: every
 * tracked top-level directory of the repository. Living documents cite into
 * them — the deploy, staging and restore-drill workflows and
 * `.github/zap-rules.tsv` are named by `SPECS.md`, `docs/ARCHITECTURE.md`, the
 * Art. 30 record and the `ship` skill, and `AGENTS.md` routes every role to
 * `.githooks/` — so a new top-level directory is a new claim root: add it here,
 * or paths into it are unchecked. A hand-kept census of this namespace is a
 * snapshot of a corpus that keeps moving, so the gate's own OK line prints what
 * a run actually checked, and `check-markdown-links-tree.test.mjs` fails if this
 * list stops covering the tracked tree.
 */
export const CLAIM_ROOTS = [
  "apps",
  "packages",
  "scripts",
  "docs",
  "adr",
  "research",
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
 * Is this a target written against the containing file rather than against the
 * repository root — `./` or anything under it, `..` itself, or anything under
 * `../`? Both prefixes carry the "resolve me against this file's directory"
 * signal a renderer honours, and the resolver reads both against that one base
 * (see SCOPE RULES).
 *
 * `.` and `..` are in the predicate for completeness only: the span normaliser
 * strips a lone dot as swallowed punctuation before the claim test, so neither
 * reaches here from a span.
 *
 * It lives in this module, not in the driver, because it is a scope rule the
 * policy also states: the `path` rule's reason names the base this predicate
 * implies, and that reason and the resolver's reading must come from one
 * predicate, since a second copy is the disagreement this gate exists to stop.
 */
export function isFileRelativeTarget(target) {
  return target === "." || target.startsWith("./") || target === ".." || target.startsWith("../");
}

/** Is this document a record of a moment rather than a living doc? */
export function isRecord(relPath) {
  return (
    RECORD_DIRS.some((d) => relPath === d || relPath.startsWith(`${d}/`)) ||
    RECORD_FILES.includes(relPath)
  );
}

/**
 * The complete allowlist. Every entry must still match a dead reference, or
 * the gate reports it as stale — see the header.
 */
export const KNOWN_RETIRED = [
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

/**
 * THE POLICY TABLE — the shape → rule matrix, as data.
 *
 * A table rather than the order of `continue`s in `adjudicate`: a rule set
 * encoded as control flow is how the two halves of one claim drift apart.
 *
 * Each rule: `match` picks the finding, `counter` names the count it advances,
 * `priority` is its precedence — the highest matching rule wins, never the
 * first one in the array (the values must stay unique) — `verdict` is one of
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
    // A destination that cannot be decoded cannot resolve: a violation with its
    // own reason, never an uncaught `URIError`.
    //
    // The priority is the SOLE guard, not a second one beside a status test:
    // `link`'s matcher also matches this finding and is exemptible, so without
    // this rule's priority a malformed link would pass at exit 0, neither
    // reported nor counted resolved. Narrowing `link`'s matcher instead cannot
    // work: `link` owns the counter and the resolved total for every link
    // finding, so an `ok` link would match no rule and `policyFor` would throw.
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
    // Disjoint from the link rules above: a record's Markdown links stay enforced
    // (see RECORDS_RULE) and only its code-span claims are counted, so `record`
    // sits above `skill`/`path` by priority and is never resolved.
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
    // The reason names the base(s) the resolver actually consulted, from the same
    // predicate it uses: naming the root reading for a `./`- or `..`-rooted target
    // would split the verdict from the reason.
    reason: (f) =>
      isFileRelativeTarget(f.target)
        ? "code-span path: no such tracked path beside this file"
        : "code-span path: no such tracked path at the repo root or beside this file",
  },
];
