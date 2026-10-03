import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  ADR_ID_RE,
  CLAIM_ROOTS,
  KNOWN_RETIRED,
  POLICY,
  RECORD_DIRS,
  RECORD_FILES,
  RESOLVED_STATUSES,
  ROOT,
  adjudicate,
  adrIdResolves,
  analyse,
  buildContext,
  formatOkLine,
  ignoredTargets,
  inlineCodeSpans,
  isPathClaim,
  isRecord,
  isSkillName,
  loadCorpus,
  makeTree,
  normaliseSpanTarget,
  policyFor,
  policyOrder,
  prose,
  resolveClaim,
  runGate,
  skillMentionAt,
  toRepoPath,
} from "../../scripts/check-markdown-links.mjs";

// `ROOT` comes from the gate's own `import.meta.url`, never `process.cwd()`:
// the suite must judge the repository under test, not the directory a runner
// happened to start in.
const SCRIPT = resolve(ROOT, "scripts/check-markdown-links.mjs");
const CLI = SCRIPT;
const FAKE_ROOT = "/repo";

/**
 * Every pure case builds a synthetic tree and never touches the filesystem —
 * the classifier, the resolver and the adjudicator are the contract, and the
 * CLI fixtures at the bottom prove the wiring end to end.
 */
function ctxOf({ paths = [], adr = [], skills = [], root = FAKE_ROOT } = {}) {
  return { root, tree: makeTree(paths), adrNames: adr, skillDirs: new Set(skills) };
}

function scan(text, options = {}) {
  const { relPath = "docs/living.md", allowlist = [], ignored, files, ...treeOptions } = options;
  const ctx = ctxOf(treeOptions);
  const findings = analyse([{ relPath, text }], ctx);
  return adjudicate(findings, { allowlist, ignored, files });
}

function targets(result) {
  return result.violations.map((v) => v.target);
}

describe("markdown-links — scope rules (#368)", () => {
  const tree = makeTree(["AGENTS.md", "package.json", "docs/a.md", "apps/web/index.html"]);

  it("claims a repo-relative path under a tracked root", () => {
    expect(isPathClaim("packages/rag-core/src/run.ts", tree)).toBe(true);
    expect(isPathClaim("docs/ARCHITECTURE.md", tree)).toBe(true);
    expect(isPathClaim(".agents/skills/manager/SKILL.md", tree)).toBe(true);
    // A directory reference keeps its trailing slash in prose, and is a claim.
    expect(isPathClaim("provision/vps/", tree)).toBe(true);
  });

  it("claims a bare token only when it is a tracked root-level file", () => {
    expect(isPathClaim("AGENTS.md", tree)).toBe(true);
    expect(isPathClaim("package.json", tree)).toBe(true);
    // COST, stated in the header: a bare prose filename that lives in a
    // subdirectory is not a claim — 300+ such tokens are version strings,
    // member expressions and model ids, so a wider rule is a false-positive
    // factory.
    expect(isPathClaim("notes.md", tree)).toBe(false);
    expect(isPathClaim("models.json", tree)).toBe(false);
    expect(isPathClaim("4.0.0-rc.113", tree)).toBe(false);
    expect(isPathClaim("Effect.runPromise", tree)).toBe(false);
  });

  it("leaves `~`-rooted host paths, commands, URLs, globs and placeholders alone", () => {
    for (const target of [
      "~/.dsh/settings.yaml",
      "bun run lint",
      "git stash",
      "https://github.com/ahaqqu/KajianQ/issues/368",
      "mailto:owner@example.com",
      "#anchor",
      "//cdn.example.com/x",
      "**/*.ts",
      "apps/**/*.ts",
      "<slug>",
      "<role>",
      "<label>",
      "/etc/hosts",
    ]) {
      expect(isPathClaim(target, tree), target).toBe(false);
    }
  });

  it("treats an elided label as a display label, not a path (class D)", () => {
    expect(isPathClaim("adr/0037-…", tree)).toBe(false);
    expect(isPathClaim("adr/0043-...", tree)).toBe(false);
  });

  it("reads a line citation, a fragment or swallowed punctuation as the path (A6)", () => {
    // A6: a citation points *into* a path. `path:42`, `path:42-58`, `path#L24`
    // and `path,` are all claims on `path` — the link half already stripped its
    // `#fragment`, and without the same rule here a doc that cites a line (the
    // sanctioned form) reddens on a target that exists.
    const aTree = makeTree(["docs/a.md", "README.md"]);
    for (const raw of [
      "docs/a.md:42",
      "docs/a.md:42-58",
      "docs/a.md#L24",
      "docs/a.md,",
      "docs/a.md).",
    ]) {
      expect(normaliseSpanTarget(raw), raw).toBe("docs/a.md");
      expect(isPathClaim(raw, aTree), raw).toBe(true);
    }
    // A directory keeps its trailing slash; a line citation on a dead path is
    // still dead, reported on the stripped claim.
    expect(normaliseSpanTarget("provision/vps/")).toBe("provision/vps/");
    expect(targets(scan("See `docs/gone.md:42-58,`.", { paths: ["docs/a.md"] }))).toEqual([
      "docs/gone.md",
    ]);
  });

  it("never reads a code span inside a fenced block", () => {
    const text = ["# Doc", "```ts", "import x from 'apps/foo.ts';", "```", "after"].join("\n");
    expect(prose(text)[2]).toBe("");
    expect(scan(text, { paths: [] }).violations).toEqual([]);
  });

  it("does not flag a prose line that merely mentions a path", () => {
    const text = "See docs/ARCHITECTURE.md and packages/rag-core/src/run.ts for the detail.";
    expect(scan(text).violations).toEqual([]);
  });

  it("extracts every inline span on a line with the index it starts at", () => {
    const spans = inlineCodeSpans("run `bun run lint` then `docs/a.md`");
    expect(spans.map((s) => s.target)).toEqual(["bun run lint", "docs/a.md"]);
    expect(spans[1].index).toBe("run `bun run lint` then ".length);
  });

  it("claims a `..`-rooted target by its form, never by its reading (#391)", () => {
    // #391: the class used to be vetoed on the raw first segment, so it never
    // reached `resolveClaim`'s file-relative base — the base the header blesses
    // for the `packages/infra/README.md` control. A `..`-rooted token that
    // survived the lexical rules is a path by its form; its *reading* decides
    // where it resolves, not whether it is a claim.
    const tree = makeTree(["README.md", "docs/a.md", "packages/infra/README.md"]);
    expect(isPathClaim("../docs/a.md", tree)).toBe(true);
    expect(isPathClaim("../../../docs/a.md", tree)).toBe(true);
    expect(isPathClaim("../", tree)).toBe(true);
    // A *bare* `..` is the declared exception: the span normaliser strips it as
    // swallowed punctuation, so the span half never claims it while the link
    // half reddens on it. Pinned in the invariant table below and named in the
    // header's SCOPE RULES.
    expect(normaliseSpanTarget("..")).toBe("");
    expect(isPathClaim("..", tree)).toBe(false);
    // The reading's first segment (`web`) is not a tracked root, and the class
    // is still a claim: re-testing the reading would veto a target the link
    // half reddens on (`../web/dist` from `adr/`, an ADR-0028 site).
    expect(isPathClaim("../web/dist", tree)).toBe(true);
    // The lexical scope rules run first, so a `..`-rooted non-path stays out.
    for (const target of ["../a b.md", "../*.ts", "../<slug>", "../adr/0037-…"]) {
      expect(isPathClaim(target, tree), target).toBe(false);
    }
    // ...and the normaliser runs before the claim test, so a line citation or an
    // in-file fragment into a `..`-relative path is still a claim on the path.
    expect(isPathClaim("../../../docs/a.md:42-58", tree)).toBe(true);
    expect(isPathClaim("../../../docs/a.md#L24", tree)).toBe(true);
    // ...and a `~`-rooted host path is still a different class.
    expect(isPathClaim("~/.dsh/settings.yaml", tree)).toBe(false);
  });

  it("counts a `..` span that resolves through the file-relative base (#391)", () => {
    const result = scan("See `../docs/a.md`.", {
      relPath: "docs/living.md",
      paths: ["docs/a.md"],
    });
    expect(result.violations).toEqual([]);
    expect(result.counters.claims).toBe(1);
    expect(result.counters.resolved).toBe(1);
  });

  it("flags a dead `..` span on a living doc — the fail-open #391 closed", () => {
    const result = scan("The runbook is `../../../docs/VPS-ABSENT.md`.", {
      relPath: ".agents/skills/ship/SKILL.md",
      paths: ["docs/a.md"],
    });
    expect(targets(result)).toEqual(["../../../docs/VPS-ABSENT.md"]);
    expect(result.violations[0].kind).toBe("path");
    expect(result.violations[0].reason).toContain("no such tracked path");
    // The reading the resolver judged, not the root reading — the form the
    // gitignore/allowlist chain looks up.
    expect(result.violations[0].repoPath).toBe("docs/VPS-ABSENT.md");
  });

  it("judges one target the same way in both shapes — the #391 invariant", () => {
    // The invariant this ticket exists for, as a table: for each target the
    // Markdown link and the inline code span must reach the *same* status. The
    // shapes may word their reasons differently; they may not disagree on
    // whether the target is there.
    const ctx = ctxOf({ paths: ["docs/a.md", "README.md"] });
    const relPath = "docs/living.md";
    for (const [target, expected] of [
      ["../docs/a.md", "ok"],
      ["../README.md", "ok"],
      ["../docs/gone.md", "missing"],
      ["../web/dist", "missing"],
      ["../..", "missing"],
      ["../../etc/hosts", "missing"], // escaping: the decision, pinned below
    ]) {
      const span = analyse([{ relPath, text: `See \`${target}\`.` }], ctx);
      const link = analyse([{ relPath, text: `See [x](${target}).` }], ctx);
      expect(
        span.map((f) => f.status),
        `span ${target}`,
      ).toEqual([expected]);
      expect(
        link.map((f) => f.status),
        `link ${target}`,
      ).toEqual([expected]);
    }

    // The one declared exception, pinned rather than hidden: a bare `..` is
    // nothing but punctuation, so the span normaliser strips it and the span
    // half never claims it — while `[x](..)` reddens in the link half, whose
    // `toRepoPath` folds the repository root to `""` and reads it as missing.
    // That reading is not copied into the span half: the link half contradicts
    // it from a deeper directory, where `..` resolves to a tracked parent
    // (`.agents/skills/ship/` → `.agents/skills`). Named in the header's SCOPE
    // RULES and reported for the re-verification round.
    expect(analyse([{ relPath, text: "See `..`." }], ctx)).toEqual([]);
    expect(analyse([{ relPath, text: "See [x](..)." }], ctx).map((f) => f.status)).toEqual([
      "missing",
    ]);
  });

  it("reddens on an escaping target in both shapes — decided, not inherited (#391)", () => {
    // The decision recorded in the header's SCOPE RULES: a `..`-rooted target
    // whose reading leaves the repository is a claim, and a missing one is a
    // violation. Evidence, not assumption: the Markdown half already judges the
    // identical destination missing (`toRepoPath` → null, so no exemption is
    // reachable) and prints it.
    const result = scan(["`../../../../etc/passwd`", "[t](../../../../etc/passwd)"].join("\n"), {
      relPath: ".agents/skills/ship/SKILL.md",
      paths: [],
    });
    expect(targets(result)).toEqual(["../../../../etc/passwd", "../../../../etc/passwd"]);
    expect(result.violations.map((v) => v.kind)).toEqual(["path", "link"]);
    expect(result.violations[0].reason).toContain("no such tracked path");
    expect(result.violations[1].reason).toBe("target does not exist");
    // Escaping readings are `null`, so neither shape can reach the ignore chain.
    expect(result.violations.map((v) => v.repoPath)).toEqual([null, null]);
    expect(result.counters.ignored).toBe(0);
  });

  it("counts a dead `..` span inside a record instead of enforcing it (#391)", () => {
    // The two live `..` span sites in the corpus are both ADR-0028's
    // `../web/dist`: claim-ness changes, enforcement does not — the record rule
    // counts them, and the OK line prints the count on every green run.
    const result = scan("Output lives in `../web/dist`.", {
      relPath: "adr/0028-alchemy-iac-cloudflare.md",
      paths: [],
    });
    expect(result.violations).toEqual([]);
    expect(result.counters.claims).toBe(0);
    expect(result.counters.recordsClaims).toBe(1);
    expect(result.counters.recordsDead).toBe(1);
  });

  it("never lets the `..` rule read a span inside a fence", () => {
    // TRAP: the class is claimed by form, so the fence rule has to run first —
    // an example that shows the shape must stay inert.
    const text = ["# Doc", "```md", "`../../../docs/absent.md`", "```"].join("\n");
    expect(scan(text, { relPath: ".agents/skills/ship/SKILL.md", paths: [] }).violations).toEqual(
      [],
    );
  });

  it("keeps a `./`-rooted span out of scope, as the header declares", () => {
    // DECLARED, not silently dropped: `./apps/web/dist` in docs/VPS-SETUP.md and
    // docs/VPS-OPERATIONS.md quotes the asset handler's *default literal*, so
    // widening this class would redden two correct documents. The divergence
    // from the link half is real and is named in the header's SCOPE RULES.
    const tree = makeTree(["docs/a.md", "apps/web/dist/index.html"]);
    expect(isPathClaim("./apps/web/dist", tree)).toBe(false);
    expect(isPathClaim("./docs/a.md", tree)).toBe(false);
    const span = scan("The default is `./apps/web/dist`.", {
      relPath: "docs/VPS-OPERATIONS.md",
      paths: ["docs/a.md"],
    });
    expect(span.violations).toEqual([]);
    // ...while the identical destination in link form is the link half's call.
    const link = scan("The default is [x](./apps/web/dist).", {
      relPath: "docs/VPS-OPERATIONS.md",
      paths: ["docs/a.md"],
    });
    expect(targets(link)).toEqual(["./apps/web/dist"]);
  });

  it("offers a `..` span the same gitignore exemption as its link form (A1)", () => {
    // TRAP: this pins the reading `repoPath` carries. With a root reading the
    // span's repoPath is null, `git check-ignore` is never asked, and the span
    // reddens while the identical link is skipped and counted — the A1 class.
    const ignored = new Set(["apps/web/dist/index.html"]);
    const opts = { relPath: "docs/living.md", paths: [], ignored };
    const span = scan("The deploy needs `../apps/web/dist/index.html`.", opts);
    expect(span.violations).toEqual([]);
    expect(span.counters.ignored).toBe(1);
    const link = scan("The deploy needs [x](../apps/web/dist/index.html).", opts);
    expect(link.violations).toEqual([]);
    expect(link.counters.ignored).toBe(1);
  });

  it("reports a malformed percent-encoded destination instead of dying (#392)", () => {
    // #392: `decodeURIComponent` threw, so the run printed a Bun stack trace and
    // no `file:line -> target` line — the output contract broken even though the
    // exit code was already non-zero.
    const result = scan("See [pct](./100%.md).", { paths: [] });
    expect(targets(result)).toEqual(["./100%.md"]);
    expect(result.violations[0].kind).toBe("link");
    expect(result.violations[0].reason).toContain("malformed percent-encoding");
    expect(result.counters.links).toBe(1);
  });

  it("still decodes well-formed percent-encoding — the guard is not a bypass", () => {
    expect(
      scan("See [ok](./a%20b.md).", { relPath: "docs/living.md", paths: ["docs/a b.md"] })
        .violations,
    ).toEqual([]);
    // A literal `%` in a file name is written `%25` and resolves to `100%.md`.
    expect(
      scan("See [pct](./100%25.md).", { relPath: "docs/living.md", paths: ["docs/100%.md"] })
        .violations,
    ).toEqual([]);
  });
});

describe("markdown-links — resolution base", () => {
  it("resolves a root-relative claim against the repo root", () => {
    const ctx = ctxOf({ paths: ["scripts/check-boundary.mjs"] });
    expect(resolveClaim("scripts/check-boundary.mjs", "docs", ctx)).toBe("tracked");
  });

  it("resolves a package-relative claim against the containing file", () => {
    // packages/infra/README.md writes `scripts/db-migrate.mjs` meaning
    // packages/infra/scripts/db-migrate.mjs. A root-only rule invents a
    // false positive here.
    const result = scan("Run `scripts/db-migrate.mjs` to migrate.", {
      relPath: "packages/infra/README.md",
      paths: ["packages/infra/scripts/db-migrate.mjs"],
    });
    expect(result.violations).toEqual([]);
    expect(result.counters.claims).toBe(1);
  });

  it("flags a target that neither base finds", () => {
    const result = scan("Run `scripts/gone.mjs` to migrate.", {
      relPath: "packages/infra/README.md",
      paths: ["packages/infra/scripts/db-migrate.mjs"],
    });
    expect(targets(result)).toEqual(["scripts/gone.mjs"]);
  });

  it("gives Markdown links the file-only base a renderer uses", () => {
    // TRAP: the root fallback must not leak into the link half. GitHub
    // resolves [x](scripts/a.mjs) against docs/, where nothing exists.
    const result = scan("See [the gate](scripts/check-boundary.mjs).", {
      relPath: "docs/living.md",
      paths: ["scripts/check-boundary.mjs"],
    });
    expect(targets(result)).toEqual(["scripts/check-boundary.mjs"]);
    expect(result.violations[0].reason).toBe("target does not exist");
  });

  it("still accepts a link written beside its target", () => {
    const result = scan("See [the gate](check-boundary.mjs).", {
      relPath: "docs/living.md",
      paths: ["docs/check-boundary.mjs"],
    });
    expect(result.violations).toEqual([]);
  });

  it("keeps the root-absolute link verdict", () => {
    const result = scan("See [x](/docs/a.md).", {
      relPath: "docs/living.md",
      paths: ["docs/a.md"],
    });
    expect(result.violations[0].reason).toBe(
      "root-absolute path (resolve it relative to the file instead)",
    );
  });

  it("refuses a target that escapes the repository", () => {
    expect(toRepoPath(FAKE_ROOT, "docs", "../../etc/hosts")).toBeNull();
  });
});

describe("markdown-links — the committed tree, not the working tree", () => {
  it("flags a path that exists only as an untracked build output", () => {
    // The gate resolves the commit, so the verdict cannot depend on whether
    // the caller just ran `bun run build:web`. apps/web/dist/index.html is
    // absent from the index and is caught.
    const result = scan("The deploy needs `apps/web/dist/index.html`.", { paths: ["docs/a.md"] });
    expect(targets(result)).toEqual(["apps/web/dist/index.html"]);
  });

  it("skips a target git ignores, and counts it", () => {
    const ignored = new Set(["apps/web/dist/index.html"]);
    const result = scan("The deploy needs `apps/web/dist/index.html`.", {
      paths: ["docs/a.md"],
      ignored,
    });
    expect(result.violations).toEqual([]);
    expect(result.counters.ignored).toBe(1);
  });

  it("offers a Markdown link the same exemption chain as a code span (A1)", () => {
    // A1: the link half used to be handled first and `continue`d, so the
    // gitignore and allowlist exemptions were structurally unreachable for it —
    // a link to a build output was red with no escape, while the identical
    // target in a code span was skipped and counted.
    const relPath = "docs/living.md";
    const text = "The deploy needs [the bundle](../apps/web/dist/index.html).";
    const opts = { relPath, paths: ["docs/a.md"] };

    // Gitignored: skipped and counted, exactly like the span half...
    const ignored = scan(text, { ...opts, ignored: new Set(["apps/web/dist/index.html"]) });
    expect(ignored.violations).toEqual([]);
    expect(ignored.counters.ignored).toBe(1);

    // ...and the escape is real: without an exemption the same link is red.
    const bare = scan(text, opts);
    expect(targets(bare)).toEqual(["../apps/web/dist/index.html"]);
    expect(bare.violations[0].repoPath).toBe("apps/web/dist/index.html");

    // An allowlist entry silences it too, on the destination as written.
    const allowlisted = scan(text, {
      ...opts,
      allowlist: [
        {
          file: relPath,
          target: "../apps/web/dist/index.html",
          reason: "the deploy guide cites the build output it tells you to produce",
        },
      ],
    });
    expect(allowlisted.violations).toEqual([]);
    expect(allowlisted.counters.allowlisted).toBe(1);
  });

  it("routes every missing reference through one chain (B1)", () => {
    // B1: which shape gets which rule is data in `POLICY`, not the order of
    // `continue`s. Every shape `analyse` emits must have a rule, and a shape
    // that has none fails loud instead of silently getting the wrong chain.
    const ctx = ctxOf({ paths: ["docs/a.md"], skills: [] });
    const findings = [
      ...analyse(
        [
          {
            relPath: "docs/living.md",
            text: [
              "A [dead link](gone.md).",
              "A [root-absolute link](/docs/a.md).",
              "A [good link](a.md).",
              "A [malformed link](./100%.md).",
              "Retired `packages/gone/`.",
              "The `no-such-skill` skill.",
            ].join("\n"),
          },
          { relPath: "adr/0001-a-record.md", text: "Retired `packages/gone/`." },
        ],
        ctx,
      ),
    ];
    const fired = new Set();
    for (const finding of findings) {
      // The shipped selector, not the array-order one: `policyFor` takes the
      // highest matching `priority`, so this completeness case fires the rule
      // production fires and stays green under any permutation of `POLICY`.
      const rule = policyFor(finding);
      expect(rule, `${finding.kind}/${finding.status}`).toBeDefined();
      expect(rule.verdict).toBeOneOf(POLICY.map((r) => r.verdict));
      // The status vocabulary is closed: a resolved status, a missing one, or
      // one of the two shapes that are violations in themselves. Anything else
      // is a classifier bug.
      expect(
        finding.status === "missing" ||
          finding.status === "root-absolute" ||
          finding.status === "malformed-encoding" ||
          RESOLVED_STATUSES.has(finding.status),
        finding.status,
      ).toBe(true);
      fired.add(rule.id);
    }
    expect([...fired].sort()).toEqual([
      "link",
      "link-malformed-encoding",
      "link-root-absolute",
      "path",
      "record",
      "skill",
    ]);

    expect(() =>
      adjudicate([
        {
          kind: "mystery",
          status: "missing",
          file: "docs/x.md",
          line: 1,
          target: "x",
          repoPath: "x",
        },
      ]),
    ).toThrow("no policy rule");
  });

  it("selects a rule by its declared precedence, not by array position (B5)", () => {
    // B5: the branch below (`link` before `record`) made the *first* match win,
    // so moving `record` to the head of the table — a pure reorder, no logic
    // touched — stopped the 19 Markdown links inside `adr/**` and the cutover
    // log from being checked while the gate still printed OK and exited 0.
    // Precedence is now a field, so no permutation can do that.
    const ctx = ctxOf({ paths: ["docs/a.md"], skills: [] });
    const findings = analyse(
      [
        {
          relPath: "docs/living.md",
          text: [
            "A [dead link](gone.md).",
            "A [root-absolute link](/docs/a.md).",
            "Retired `packages/gone/`.",
            "The `no-such-skill` skill.",
          ].join("\n"),
        },
        {
          relPath: "adr/0001-a-record.md",
          text: "Retired `packages/gone/`.\nStill [the runbook](./gone.md).",
        },
      ],
      ctx,
    );

    // The array's order is not part of the table's meaning: a reversed copy
    // decides every shape exactly as the shipped one does.
    const shipped = adjudicate(findings, { allowlist: [] });
    const permuted = adjudicate(findings, { allowlist: [], table: [...POLICY].reverse() });
    expect(permuted.counters).toEqual(shipped.counters);
    expect(permuted.violations).toEqual(shipped.violations);

    // The precedences the corpus depends on, read off the resolved rule itself.
    const inRecord = (kind) =>
      findings.find((finding) => finding.kind === kind && finding.file.startsWith("adr/"));
    expect(policyFor(inRecord("link")).id).toBe("link");
    expect(policyFor(inRecord("path")).id).toBe("record");
    expect(policyOrder().map((rule) => rule.id)).toEqual([
      "link-root-absolute",
      "link-malformed-encoding",
      "link",
      "record",
      "skill",
      "path",
    ]);
    // A tie would put source order back in charge, so the field is unique.
    expect(new Set(POLICY.map((rule) => rule.priority)).size).toBe(POLICY.length);
  });
});

describe("markdown-links — class A: ADR cited by number", () => {
  it("resolves adr/NNNN against adr/NNNN-*.md", () => {
    const adr = ["0045-surah-reference-scoped-expansion.md", "0044-vps-serving-path-cutover.md"];
    expect(adrIdResolves("adr/0045", adr)).toBe(true);
    expect(scan("Recorded in `adr/0045`.", { paths: [], adr }).violations).toEqual([]);
  });

  it("flags an ADR number nothing matches", () => {
    const adr = ["0045-surah-reference-scoped-expansion.md"];
    expect(targets(scan("Recorded in `adr/9999`.", { paths: [], adr }))).toEqual(["adr/9999"]);
  });

  it("requires four digits, so a truncated or padded id is a typo", () => {
    const adr = ["0045-surah-reference-scoped-expansion.md"];
    expect(ADR_ID_RE.test("adr/004")).toBe(false);
    expect(ADR_ID_RE.test("adr/00455")).toBe(false);
    expect(targets(scan("See `adr/004`.", { paths: [], adr }))).toEqual(["adr/004"]);
  });

  it("accepts a deliberately duplicated number", () => {
    // adr/0005 is carried by two files on purpose: the operative monorepo ADR
    // and a template-heritage near-duplicate that declares itself superseded by
    // ADR-0023 (and that 0005 belongs to the monorepo ADR). The spec's §8 row is
    // a correct reference, so "exactly one" would fail a correct row.
    const adr = [
      "0005-monorepo-engine-plus-product.md",
      "0005-role-model-pins-honored-per-harness.md",
    ];
    expect(adrIdResolves("adr/0005", adr)).toBe(true);
  });

  it("reports every adr/NNNN as dangling when adr/ is gone", () => {
    expect(targets(scan("See `adr/0045`.", { paths: [], adr: [] }))).toEqual(["adr/0045"]);
  });
});

describe("markdown-links — class B: records of a moment", () => {
  it("does not enforce code-span paths inside adr/", () => {
    const result = scan("Retires `scripts/template-sync/` and `docs/QUOTA.md`.", {
      relPath: "adr/0030-retire-template-sync.md",
      paths: [],
    });
    expect(result.violations).toEqual([]);
    expect(result.counters.recordsDead).toBe(2);
  });

  it("does not enforce them inside the executed cutover record either", () => {
    const result = scan("`docs/VPS-CUTOVER-RUNBOOK.md` has been retired.", {
      relPath: "docs/VPS-CUTOVER-RECORD.md",
      paths: [],
    });
    expect(result.violations).toEqual([]);
    expect(result.counters.recordsDead).toBe(1);
  });

  it("still enforces the Markdown-link half inside a record", () => {
    // The exemption is scoped to code-span claims: a record whose link rots
    // is still red, and is still fixable without editing the record's argument.
    const result = scan("See [the runbook](./VPS-CUTOVER-RUNBOOK.md).", {
      relPath: "adr/0030-retire-template-sync.md",
      paths: [],
    });
    expect(targets(result)).toEqual(["./VPS-CUTOVER-RUNBOOK.md"]);
  });

  it("keeps the link rule ahead of the record rule, as a priority not a position (B5)", () => {
    // B5's mutation, asserted on the counters: the table before this round let
    // the record rule swallow a link, so putting it first counted this record's
    // dead link as a record claim instead of enforcing it — `links` 1 → 0,
    // `recordsClaims` 1 → 2, no violation, gate still OK. The split this pins is
    // the one the corpus depends on in both directions: the span is counted, the
    // link is enforced.
    const result = scan(
      ["Retires `scripts/template-sync/`.", "See [the runbook](./VPS-CUTOVER-RUNBOOK.md)."].join(
        "\n",
      ),
      { relPath: "adr/0030-retire-template-sync.md", paths: [] },
    );
    expect(targets(result)).toEqual(["./VPS-CUTOVER-RUNBOOK.md"]);
    expect(result.counters.links).toBe(1);
    expect(result.counters.recordsClaims).toBe(1);
    expect(result.counters.recordsDead).toBe(1);
  });

  it("recognises exactly the two record shapes", () => {
    expect(isRecord("adr/0030-retire-template-sync.md")).toBe(true);
    expect(isRecord("docs/VPS-CUTOVER-RECORD.md")).toBe(true);
    expect(isRecord("docs/ARCHITECTURE.md")).toBe(false);
    expect(isRecord("SPECS.md")).toBe(false);
    // A lookalike directory is not the record tree.
    expect(isRecord("adr-notes/x.md")).toBe(false);
  });

  it("enforces code-span paths in every other file, including INITIAL_IDEA.md", () => {
    const result = scan("Dropped `packages/local-first`.", {
      relPath: "INITIAL_IDEA.md",
      paths: [],
    });
    expect(targets(result)).toEqual(["packages/local-first"]);
  });
});

describe("markdown-links — class C: the allowlist is tiny and self-pruning", () => {
  const entry = {
    file: "SPECS.md",
    target: "packages/local-first",
    reason: "a reason long enough",
  };

  it("silences the exact (file, target) pair it names", () => {
    const result = scan("**Dropped from template:** `packages/local-first`.", {
      relPath: "SPECS.md",
      paths: [],
      allowlist: [entry],
    });
    expect(result.violations).toEqual([]);
    expect(result.counters.allowlisted).toBe(1);
  });

  it("does not silence the same target in another file", () => {
    const result = scan("`packages/local-first`.", {
      relPath: "docs/ARCHITECTURE.md",
      paths: [],
      allowlist: [entry],
    });
    expect(result.counters.allowlisted).toBe(0);
    expect(
      result.violations.some((v) => v.kind === "path" && v.target === "packages/local-first"),
    ).toBe(true);
  });

  it("does not evaluate an entry whose file is not in the scanned corpus", () => {
    // A fixture checkout has no SPECS.md, so the entry cannot be judged stale
    // there; against the real corpus it is, which is what keeps the list honest.
    const result = scan("Nothing dead here.", {
      relPath: "docs/living.md",
      paths: [],
      allowlist: [entry],
      files: new Set(["docs/living.md"]),
    });
    expect(result.violations).toEqual([]);
  });

  it("fails when an entry matches nothing — the list cannot rot", () => {
    const result = scan("Nothing dead here.", {
      relPath: "SPECS.md",
      paths: [],
      allowlist: [entry],
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].kind).toBe("stale-allowlist");
    expect(result.violations[0].reason).toContain("stale allowlist entry");
  });

  it("keeps the shipped allowlist small, reasoned, unique and outside records", () => {
    expect(KNOWN_RETIRED.length).toBeGreaterThan(0);
    expect(KNOWN_RETIRED.length).toBeLessThanOrEqual(4);
    const keys = KNOWN_RETIRED.map((e) => `${e.file}\u0000${e.target}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const e of KNOWN_RETIRED) {
      expect(e.reason.length).toBeGreaterThan(20);
      expect(isRecord(e.file)).toBe(false);
    }
  });
});

describe("markdown-links — the skill-name half", () => {
  it("flags a bare skill name the marker claims but .agents/skills/ does not have", () => {
    const result = scan("invoke the `agentic-workflow` skill", {
      relPath: "AGENTS.md",
      paths: [],
      skills: ["code-review", "manager"],
    });
    expect(targets(result)).toEqual(["agentic-workflow"]);
    expect(result.violations[0].reason).toBe(
      "skill name: no .agents/skills/agentic-workflow/SKILL.md",
    );
  });

  it("accepts a skill name that names a directory with a SKILL.md", () => {
    const result = scan("Apply the `code-review` skill end-to-end.", {
      relPath: "AGENTS.md",
      paths: [],
      skills: ["code-review"],
    });
    expect(result.violations).toEqual([]);
    expect(result.counters.skills).toBe(1);
  });

  it("matches both marker orders, and the plural and possessive", () => {
    const line = "see skill `manager` and the `qa-phase` skill's table";
    expect(skillMentionAt(line, "manager", line.indexOf("`manager`"))).toBe(true);
    expect(skillMentionAt(line, "qa-phase", line.indexOf("`qa-phase`"))).toBe(true);
    expect(skillMentionAt("the `manager` skills list", "manager", 4)).toBe(true);
  });

  it("does not fire on a bare name with no skill marker", () => {
    expect(isSkillName("code-review")).toBe(true);
    expect(scan("Run `code-review`.", { paths: [], skills: [] }).violations).toEqual([]);
  });

  it("does not treat SKILL.md or a path as a skill name", () => {
    expect(isSkillName("SKILL.md")).toBe(false);
    expect(isSkillName(".agents/skills/manager")).toBe(false);
  });

  it('does NOT extend to "the `X` role" — that marker has no resolution target', () => {
    // A2: this marker is not a false-positive factory across one namespace but
    // three — live harness roles (`.zcode/agents/<role>.md`: qa, reviewer,
    // fixer), model-stage names (cheap, embedder, generator,
    // decision-candidates, kajianq) and `test-implementer`, retired by
    // ADR-0032. The harness-role namespace is a *second deliberately unchecked*
    // marker; the real-tree suite pins that it is neither empty nor checked.
    const result = scan("The `cheap` role does the work.", { paths: [], skills: [] });
    expect(result.violations).toEqual([]);
  });

  it("matches by the span's own position, never by a line-wide search", () => {
    // The comparison is literal and index-anchored — no regex is built from
    // the span text (Semgrep blocks that as a ReDoS surface). So a name that
    // merely appears elsewhere on the line cannot borrow the marker.
    const line = "the `not-a-skill` prose and the `manager` skill";
    const spans = inlineCodeSpans(line);
    expect(spans).toHaveLength(2);
    expect(skillMentionAt(line, spans[0].target, spans[0].index)).toBe(false);
    expect(skillMentionAt(line, spans[1].target, spans[1].index)).toBe(true);
  });

  it("reproduces #367's two dead references from one line", () => {
    const text = "invoke the `agentic-workflow` skill (`.agents/skills/agentic-workflow/SKILL.md`)";
    const findings = analyse([{ relPath: "AGENTS.md", text }], ctxOf({ paths: [], skills: [] }));
    const { violations } = adjudicate(findings, { allowlist: [] });
    expect(violations.map((v) => v.kind).sort()).toEqual(["path", "skill"]);
    expect(violations.map((v) => v.target).sort()).toEqual([
      ".agents/skills/agentic-workflow/SKILL.md",
      "agentic-workflow",
    ]);
  });
});

describe("markdown-links — the real tree", () => {
  it("is green on the repository as it stands, with the narrowing visible", () => {
    const out = execFileSync("bun", [CLI], { encoding: "utf8" });
    expect(out).toContain("markdown-links: OK");
    // The blind spots this change accepted must be printed on every green run.
    expect(out).toMatch(/\d+ known-retired allowlisted/);
    expect(out).toMatch(/\d+ dead claims inside record files unchecked/);
  });

  it("prints exactly what `runGate` decided — one driver, not two", () => {
    // The gate used to be implemented twice (`main()` and a `realScan()` here),
    // so the suite could pass against wiring the CLI no longer had. The CLI must
    // now print the same counters the tests assert on.
    const run = runGate(ROOT);
    const corpus = loadCorpus(ROOT);
    const out = execFileSync("bun", [CLI], { encoding: "utf8" }).trim();
    expect(run.violations).toEqual([]);
    // The corpus loader is the CLI's, not a second implementation of it.
    expect(corpus.files.length).toBe(run.files.length);
    expect(corpus.sources.some((s) => s.relPath === "SPECS.md")).toBe(true);
    expect(out).toBe(formatOkLine(run.counters, run.files.length));
  });

  it("closes the OK line's arithmetic: checked = resolved + allowlisted + ignored", () => {
    // A5: "resolve" used to be the verb for the *checked* total, which counted
    // the 4 allowlisted and the 2 gitignored as if they had been proved. The
    // line now separates them, and this is the invariant that keeps it honest.
    const { counters } = runGate(ROOT);
    const checked = counters.links + counters.claims + counters.skills;
    expect(checked).toBe(counters.resolved + counters.allowlisted + counters.ignored);
    expect(counters.resolved).toBeLessThan(checked);
  });

  it("uses every shipped allowlist entry — none is stale against the real corpus", () => {
    const { violations, counters } = runGate(ROOT);
    expect(violations).toEqual([]);
    expect(counters.allowlisted).toBe(KNOWN_RETIRED.length);
  });

  it("resolves a real package-relative claim end to end", () => {
    // packages/infra/README.md:109 — `scripts/db-migrate.mjs`.
    const ctx = buildContext(ROOT);
    expect(resolveClaim("scripts/db-migrate.mjs", "packages/infra", ctx)).toBe("tracked");
  });

  it("resolves the `..` variant of that same control end to end (#391)", () => {
    // The control above is the header's blessed file-relative base. Written the
    // way this repository's `../` idiom writes it — from `docs/` — the identical
    // target must resolve, be counted as a claim, and stay green.
    const ctx = buildContext(ROOT);
    const findings = analyse(
      [
        {
          relPath: "docs/ARCHITECTURE.md",
          text: "Run `../packages/infra/scripts/db-migrate.mjs` to migrate.",
        },
      ],
      ctx,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe("ok");
    expect(findings[0].repoPath).toBe("packages/infra/scripts/db-migrate.mjs");
    const { violations, counters } = adjudicate(findings, { allowlist: [] });
    expect(violations).toEqual([]);
    expect(counters.claims).toBe(1);
    expect(counters.resolved).toBe(1);
  });

  it("knows which real targets git ignores", () => {
    const ignored = ignoredTargets(ROOT, ["apps/web/dist/index.html", "docs/ARCHITECTURE.md"]);
    expect(ignored.has("apps/web/dist/index.html")).toBe(true);
    expect(ignored.has("docs/ARCHITECTURE.md")).toBe(false);
  });

  it("covers every tracked top-level directory — the scope cannot shrink silently", () => {
    // CLAIM_ROOTS is the stated scope rule. A new top-level directory that does
    // not join it stops being a claim root, and this is what says so.
    const ctx = buildContext(ROOT);
    const topDirs = [...ctx.tree.dirs].filter((d) => !d.includes("/"));
    expect(topDirs.filter((d) => !CLAIM_ROOTS.includes(d))).toEqual([]);
    // And the roots the ticket names are all still there.
    for (const root of ["apps", "packages", "scripts", "docs", "adr", ".agents", ".zcode"]) {
      expect(topDirs).toContain(root);
    }
  });

  it("keeps record membership to real, tracked records", () => {
    // B4: the membership rule is stated in the header — a record is an executed
    // log or a decision record, never a living how-to. This pins that every
    // member is a real tracked path, so a typo cannot silently widen the
    // exemption the gate takes.
    const { tree } = buildContext(ROOT);
    for (const dir of RECORD_DIRS) expect(tree.dirs.has(dir), dir).toBe(true);
    for (const file of RECORD_FILES) expect(tree.files.has(file), file).toBe(true);
    // A record's own ADRs are records; a living doc is not.
    expect(isRecord("adr/0030-retire-template-sync.md")).toBe(true);
    expect(RECORD_DIRS.some((d) => isRecord(`${d}/x.md`))).toBe(true);
    for (const living of ["AGENTS.md", "SPECS.md", "docs/ARCHITECTURE.md"]) {
      expect(isRecord(living), living).toBe(false);
    }
  });

  it("distinguishes the two deliberately unchecked role markers", () => {
    // A2: "the `X` role" is not one namespace but two — live harness roles
    // (`.zcode/agents/<role>.md`) and model-stage names — plus one role retired
    // by ADR-0032. The harness namespace is a second *deliberately* unchecked
    // marker; this pins that it is neither empty nor a skill claim.
    const { tree } = buildContext(ROOT);
    for (const role of ["qa", "reviewer", "fixer"]) {
      expect(tree.files.has(`.zcode/agents/${role}.md`), role).toBe(true);
    }
    expect(tree.files.has(".zcode/agents/test-implementer.md")).toBe(false);
    expect(isSkillName("qa")).toBe(true);
    expect(scan("The `qa` role owns the probes.", { paths: [], skills: [] }).violations).toEqual(
      [],
    );
    // ...and only the *skill* marker makes it a claim — the role marker does
    // not, which is exactly the unchecked namespace this test documents.
    const roleLine = "The `qa` role owns the probes.";
    expect(skillMentionAt(roleLine, "qa", roleLine.indexOf("`qa`"))).toBe(false);
  });
});

/**
 * CLI fixtures: a throwaway git repo under mkdtemp, with a copy of the gate at
 * `<fixture>/scripts/` so it resolves its own root from `import.meta.dir`. The
 * index is the resolution base, so the fixture must be `git add`ed — that is
 * the rule under test, not incidental setup.
 */
function fixtureRepo(files) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "md-links-")));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  mkdirSync(join(dir, "scripts"), { recursive: true });
  copyFileSync(SCRIPT, join(dir, "scripts", "check-markdown-links.mjs"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}

function runFixture(dir) {
  return spawnSync("bun", ["scripts/check-markdown-links.mjs"], { cwd: dir, encoding: "utf8" });
}

describe("markdown-links — CLI fixtures", () => {
  it("reddens on #367's shape: a dead code-span path and a dead skill name", () => {
    const dir = fixtureRepo({
      ".gitignore": "dist/\n",
      "docs/living.md": [
        "# Living doc",
        "",
        "Replaced in #133: the `agentic-workflow` skill",
        "(`.agents/skills/agentic-workflow/SKILL.md`).",
        "",
        "```md",
        "This example is inert: `packages/gone.ts` and the `no-such-skill` skill.",
        "```",
      ].join("\n"),
    });
    const run = runFixture(dir);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("2 dangling reference(s)");
    expect(run.stderr).toContain("docs/living.md:3 -> agentic-workflow");
    expect(run.stderr).toContain("docs/living.md:4 -> .agents/skills/agentic-workflow/SKILL.md");
    // The fenced copy of the same shapes is an example, never a citation.
    expect(run.stderr).not.toContain("packages/gone.ts");
    expect(run.stderr).not.toContain("no-such-skill");
    rmSync(dir, { recursive: true, force: true });
  });

  it("is green on a fixture that exercises every rule at once", () => {
    const dir = fixtureRepo({
      ".gitignore": "dist/\n",
      "adr/0045-surah-reference-scoped-expansion.md": "# ADR-0045\n",
      ".agents/skills/code-review/SKILL.md": "# code-review\n",
      "packages/infra/scripts/db-migrate.mjs": "// migrate\n",
      "packages/infra/README.md": "Run `scripts/db-migrate.mjs` to migrate.\n",
      "docs/living.md": [
        "# Living doc",
        "",
        "Recorded in `adr/0045`, applied by the `code-review` skill. The deploy",
        "needs `apps/web/dist/index.html`. A prose line mentioning",
        "packages/local-first is not a claim.",
      ].join("\n"),
    });
    const run = runFixture(dir);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("markdown-links: OK");
    // 2 path claims + 1 gitignored build path + 1 skill name.
    expect(run.stdout).toContain("3 code-span path claims + 1 skill names");
    expect(run.stdout).toContain("1 gitignored build paths skipped");
    // A5: the line separates what was checked from what resolved — the
    // gitignored one is checked and *not* resolved, and says so.
    expect(run.stdout).toContain("3 resolve");
    expect(run.stdout).toContain("0 record-file claims counted");
    rmSync(dir, { recursive: true, force: true });
  });

  it("reddens on an ignored build path only by policy, never by presence on disk", () => {
    const dir = fixtureRepo({
      ".gitignore": "docs/untracked.md\n",
      "docs/living.md": "See `docs/untracked.md`.\n",
    });
    // Real on disk, absent from the index: ignored, so skipped.
    writeFileSync(join(dir, "docs", "untracked.md"), "# notes\n");
    const ignoredRun = runFixture(dir);
    expect(ignoredRun.status).toBe(0);
    expect(ignoredRun.stdout).toContain("1 gitignored build paths skipped");

    // Stop ignoring it, keep it untracked: now the gate must refuse it, even
    // though the file is right there on disk.
    writeFileSync(join(dir, ".gitignore"), "# nothing ignored\n");
    const untrackedRun = runFixture(dir);
    expect(untrackedRun.status).toBe(1);
    expect(untrackedRun.stderr).toContain("docs/living.md:1 -> docs/untracked.md");
    rmSync(dir, { recursive: true, force: true });
  });

  it("reddens on a record's dead Markdown link through the CLI (B5)", () => {
    // The shipping path for the B5 property: a reshuffle of `POLICY` used to
    // make this exit 0 and print the link as a counted record claim.
    const dir = fixtureRepo({
      "adr/0030-retire-template-sync.md": [
        "# ADR-0030",
        "",
        "Retires `scripts/template-sync/`; see [the runbook](./VPS-CUTOVER-RUNBOOK.md).",
      ].join("\n"),
    });
    const run = runFixture(dir);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("1 dangling reference(s)");
    expect(run.stderr).toContain("adr/0030-retire-template-sync.md:3 -> ./VPS-CUTOVER-RUNBOOK.md");
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails loudly when the checkout has no git index", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "md-links-nogit-")));
    mkdirSync(join(dir, "scripts"), { recursive: true });
    copyFileSync(SCRIPT, join(dir, "scripts", "check-markdown-links.mjs"));
    writeFileSync(join(dir, "SPECS.md"), "# spec\n");
    const run = spawnSync("bun", ["scripts/check-markdown-links.mjs"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("not a git checkout");
    rmSync(dir, { recursive: true, force: true });
  });

  it("reddens on a dead `..` span and the same target in link form (#391)", () => {
    // The QA round's failing probe, end to end: one living doc, one dead
    // target, both shapes, `git add -A`ed so the index is the base. Before the
    // fix only the link line reddened; the span line was not even counted.
    const dir = fixtureRepo({
      ".agents/skills/ship/SKILL.md": [
        "# ship",
        "",
        "The runbook is `../../../docs/VPS-ABSENT.md` in span form.",
        "The runbook is [in link form](../../../docs/VPS-ABSENT.md).",
      ].join("\n"),
    });
    const run = runFixture(dir);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("2 dangling reference(s)");
    expect(run.stderr).toContain(".agents/skills/ship/SKILL.md:3 -> ../../../docs/VPS-ABSENT.md");
    expect(run.stderr).toContain(".agents/skills/ship/SKILL.md:4 -> ../../../docs/VPS-ABSENT.md");
    rmSync(dir, { recursive: true, force: true });
  });

  it("stays green on a `..` span that resolves, and prints it as checked (#391)", () => {
    const dir = fixtureRepo({
      ".agents/skills/ship/SKILL.md": "The runbook is `../../../docs/VPS-OPERATIONS.md`.\n",
      "docs/VPS-OPERATIONS.md": "# operations\n",
    });
    const run = runFixture(dir);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("1 code-span path claims + 0 skill names");
    expect(run.stdout).toContain("1 resolve");
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports a malformed percent-encoded link instead of crashing (#392)", () => {
    const dir = fixtureRepo({ "docs/living.md": "See [pct](./100%.md).\n" });
    const run = runFixture(dir);
    expect(run.status).toBe(1);
    // The documented line, with its reason — not a Bun stack trace.
    expect(run.stderr).toContain("docs/living.md:1 -> ./100%.md  (malformed percent-encoding");
    expect(run.stderr).not.toContain("URIError");
    expect(run.stdout).not.toContain("markdown-links: OK");
    rmSync(dir, { recursive: true, force: true });
  });
});
