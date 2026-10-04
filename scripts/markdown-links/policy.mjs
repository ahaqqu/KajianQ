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
 * together (B1).
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
 *   `provision/vps/`). A root-relative code span is read against two bases —
 *   the repository root and the containing file's directory — and resolves if
 *   either finds it. `packages/infra/README.md` writes `scripts/db-migrate.mjs`
 *   meaning the package-relative `packages/infra/scripts/db-migrate.mjs`;
 *   a root-only rule would redden that honest reference.
 *
 *   A `..`-rooted span is read against one base and one only: the containing
 *   file's directory. That is the reading the Markdown half gives the identical
 *   destination, and one base is what removes the disagreement that failed
 *   **open** (#391, A1): with the root base also in play, a target that
 *   overshoots the file's directory and lands back inside the repository
 *   through the root directory's own name was `ok` as a span and `missing` as a
 *   link. One judge produces the reading and the verdict together
 *   (`judgeClaim`), so a finding cannot report the verdict of one rule beside
 *   the path of another. Markdown links keep their single, correct base for the
 *   same reason: a renderer resolves `(path)` against the containing file and
 *   nothing else, so accepting a root-relative fallback there would hide a link
 *   that is broken on GitHub.
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
 *   file's directory, the second base above, and that reading decides where it
 *   resolves — the root base is not consulted for this class, so the verdict and
 *   the reported `repoPath` come from one rule and cannot disagree (A1). The
 *   reading is deliberately not re-tested against CLAIM_ROOTS either, because
 *   the tracked-root rule is a substitute for the "is this a path?" signal that
 *   a `..`-rooted token already carries — retesting it would veto `../web/dist`
 *   (which reads as `web/dist`) while the link half reddens on the identical
 *   target. Before this rule the raw first segment `..` vetoed the whole class,
 *   so a dead `../../../docs/x.md` in a living doc stayed green while the
 *   identical target in link form was red: one target, two verdicts, and the
 *   disagreement failed **open**.
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
 *   Two `..` cases are named rather than silently dropped. A *bare* `..` — a
 *   span that is nothing but the two dots — is stripped by the span normaliser
 *   as swallowed punctuation, so the span half never claims it. `../` and
 *   everything under it do claim. The halves part company on that one token:
 *   `[x](..)` reddens in the link half, whose `toRepoPath` folds the repository
 *   root to `""` and reads it as missing — a reading that same half contradicts
 *   from a deeper directory, where `..` resolves to a tracked parent
 *   (`.agents/skills/ship/` → `.agents/skills`). Copying it would import the
 *   defect rather than the judgement, so it is declared here and pinned by a
 *   test instead; the link half's root reading is a neighbouring defect this
 *   change does not touch.
 *
 *   A *bare* `../` — the token with its slash, which `isFileRelativeTarget`
 *   claims by form like everything under `../` — is judged `missing` from a
 *   depth-1 directory. Its reading is the repository root, whose repo-relative
 *   form is the empty string, and an empty reading is not a tracked path. From a
 *   deeper directory the same token reads as the tracked parent and is `ok`.
 *   The Markdown half reaches the identical verdicts on the identical
 *   destinations (`""` is falsy there too, so the root reading is missing in
 *   both halves), which is why this half copies that reading rather than
 *   "fixing" it into a disagreement. Named because it is the one reading that
 *   looks as if it should resolve and does not.
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
 *       value of the asset handler's default. The divergence is real, it fails
 *       open, and it is **filed** as #396 rather than left as prose here — it
 *       needs its own decision, not this one.
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
 *   C — a living doc naming an artifact that is gone: three spans total, in
 *       `SPECS.md` and `docs/ARCHITECTURE.md`, each narrating its target's
 *       removal (`Dropped from template: packages/local-first`, `Before the
 *       move, apps/api/alchemy.run.ts …`). Covered by KNOWN_RETIRED, below.
 *
 *   D — elided display labels, handled by the ellipsis scope rule above.
 *
 * RECORDS_RULE — `adr/**` and `docs/VPS-CUTOVER-RECORD.md` are *records of a
 *   moment*, not living docs: a path in them is evidence of what was, not an
 *   instruction to a reader. A decision record that removed an artifact names
 *   it precisely *because* it removed it — a record has no present tense — and
 *   the cutover record is the executed log of a one-shot procedure. AGENTS.md
 *   forbids editing `adr/` to make a gate pass, so those spans cannot be
 *   repaired, only exempted — and an allowlist of every one of them, growing
 *   with each record, is not the "tiny, reasoned" kind this gate tolerates. This
 *   is the rule instead, stated with its cost:
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
 * KNOWN_RETIRED — an allowlist of three (file, target) pairs, one reason each,
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
 *   Which shape gets which rule is data in this module, not the order of the
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
 *   Deliberately NOT extended to "the `X` role". That marker names four
 *   different things: live harness roles (`.zcode/agents/<role>.md` — `qa`,
 *   `reviewer`, `fixer`), a role the workflow retired (its duties live with the
 *   senior implementer), a price pair in prose (`$0.14/$0.28`, caught only
 *   because the marker is lexical), and model-stage names (`embedder`, `cheap`,
 *   `decision-candidates`, `generator`, `kajianq`, …). The last two classes are a
 *   false-positive factory with no resolution target, which is why the marker is
 *   rejected as a whole — but the harness-role namespace
 *   (`.zcode/agents/<role>.md`) is a **second deliberately unchecked marker**,
 *   not an empty one, and this header says so rather than implying otherwise. A
 *   test pins that distinction.
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
 * The driver exports the classifier, resolver and gate functions — `loadCorpus`,
 * `runGate`, `formatOkLine` — for `tests/scripts/check-markdown-links.test.mjs`,
 * which drives the same functions the CLI does instead of a second copy of them;
 * the tables above are imported from this module by the tests that pin them.
 */

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
    file: "SPECS.md",
    target: "packages/local-first",
    reason:
      "§3.1 'Dropped from template' — the sentence's own subject is the pillar this repo dropped",
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
    // exist" of a decoded miss and never an uncaught `URIError`.
    //
    // The priority is the SOLE guard, not a second one beside a status test:
    // `link`'s matcher is `f.kind === "link"`, which matches this finding too,
    // and `link` is exemptible — so if this rule's priority were lost, the
    // malformed finding would fall to it, `adjudicate` would drop it before the
    // exemption chain (a status other than `missing` is never exempted, and
    // `malformed-encoding` is not in the driver's RESOLVED_STATUSES either), and
    // a document with a malformed link would pass at exit 0 with the reference
    // neither reported nor counted resolved. Narrowing `link`'s matcher to
    // `status === "missing"` cannot create the disjointness instead: `link` owns
    // the `links` counter and the resolved total for *every* link finding, so an
    // `ok` link would then match no rule and `policyFor` would throw.
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
