// The docs:links gate's contract, case by case: what is a claim (scope rules),
// whether the two shapes of one target agree, and what the policy does with each
// finding. Every case here is hermetic — a synthetic tree, no filesystem, no git;
// `check-markdown-links-tree.test.mjs` holds the real-tree and CLI cases.
import { describe, expect, it } from "vitest";
import {
  KNOWN_RETIRED,
  POLICY,
  isFileRelativeTarget,
  isRecord,
} from "../../scripts/markdown-links/policy.mjs";
import {
  ADR_ID_RE,
  RESOLVED_STATUSES,
  adjudicate,
  adrIdResolves,
  analyse,
  inlineCodeSpans,
  isPathClaim,
  isSkillName,
  judgeClaim,
  makeTree,
  normaliseSpanTarget,
  policyFor,
  policyOrder,
  prose,
  skillMentionAt,
  toRepoPath,
} from "../../scripts/check-markdown-links.mjs";
import { FAKE_ROOT, ctxOf, scan, targets } from "./check-markdown-links-fixture.mjs";

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
    // COST, stated in the header: a bare prose filename in a subdirectory is not
    // a claim — such tokens are mostly version strings, member expressions and
    // model ids, so a wider rule is a false-positive factory.
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
    // A citation points *into* a path: `path:42`, `path:42-58`, `path#L24` and
    // `path,` are claims on `path`, matching the link half's `#fragment` strip.
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
    // A directory keeps its trailing slash; a dead path stays dead, reported on the stripped claim.
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
    // A `..`-rooted token that survives the lexical rules is a path by its form;
    // its *reading* decides where it resolves, not whether it is a claim.
    const tree = makeTree(["README.md", "docs/a.md", "packages/infra/README.md"]);
    expect(isPathClaim("../docs/a.md", tree)).toBe(true);
    expect(isPathClaim("../../../docs/a.md", tree)).toBe(true);
    expect(isPathClaim("../", tree)).toBe(true);
    // A *bare* `..` is the declared exception: the span normaliser strips it as
    // swallowed punctuation, so the span half never claims it while the link half
    // reddens on it. See the header's SCOPE RULES.
    expect(normaliseSpanTarget("..")).toBe("");
    expect(isPathClaim("..", tree)).toBe(false);
    // Not a tracked root (`web`), still a claim: re-testing the reading would veto it.
    expect(isPathClaim("../web/dist", tree)).toBe(true);
    // The lexical scope rules run first, so a `..`-rooted non-path stays out.
    for (const target of ["../a b.md", "../*.ts", "../<slug>", "../adr/0037-…"]) {
      expect(isPathClaim(target, tree), target).toBe(false);
    }
    // ...and the normaliser runs first, so a citation into a `..`-relative path is a claim.
    expect(isPathClaim("../../../docs/a.md:42-58", tree)).toBe(true);
    expect(isPathClaim("../../../docs/a.md#L24", tree)).toBe(true);
    // ...and a `~`-rooted host path is still a different class.
    expect(isPathClaim("~/.dsh/settings.yaml", tree)).toBe(false);
  });

  it("claims a `./`-rooted target by its form, read beside the file (#396)", () => {
    // A `./`-rooted token that survives the lexical rules is a path by its form,
    // exactly as a `..`-rooted one is; its reading is the containing file's
    // directory, and neither the root reading nor CLAIM_ROOTS is consulted.
    const tree = makeTree(["README.md", "docs/a.md", "apps/web/dist/index.html"]);
    expect(isFileRelativeTarget("./docs/a.md")).toBe(true);
    expect(isPathClaim("./docs/a.md", tree)).toBe(true);
    // Not a tracked root (`web`), still a claim: re-testing the reading would veto it.
    expect(isPathClaim("./web/dist", tree)).toBe(true);
    // The prefix alone is the containing directory, claimed like bare `../`.
    expect(isPathClaim("./", tree)).toBe(true);
    // The lexical scope rules run first, so a `./`-rooted non-path stays out.
    for (const target of ["./a b.md", "./*.ts", "./<slug>", "./adr/0037-…"]) {
      expect(isPathClaim(target, tree), target).toBe(false);
    }
    // ...and the normaliser runs first, so a citation into a `./`-relative path is a claim.
    expect(isPathClaim("./docs/a.md:42-58", tree)).toBe(true);
    expect(isPathClaim("./docs/a.md#L24", tree)).toBe(true);
    // A *bare* `.` is the declared exception one token shorter than `..`: the
    // normaliser strips it, so the span half never claims it.
    expect(normaliseSpanTarget(".")).toBe("");
    expect(isPathClaim(".", tree)).toBe(false);
    // The link half's side of that exception: `[x](.)` is the containing
    // directory, and from a nested file that directory is tracked.
    expect(
      scan("See [x](.).", { relPath: "docs/living.md", paths: ["docs/a.md"] }).violations,
    ).toEqual([]);
    // A `~`-rooted host path is still a different class.
    expect(isPathClaim("~/.dsh/settings.yaml", tree)).toBe(false);
  });

  it("flags a dead `./` span and its link form alike — the fail-open #396 closed", () => {
    // The two references below name the same target in the same file and must
    // agree: both are `missing`, on the file-relative reading.
    const opts = { relPath: "docs/VPS-OPERATIONS.md", paths: ["docs/a.md"] };
    const span = scan("The default is `./apps/web/dist`.", opts);
    expect(targets(span)).toEqual(["./apps/web/dist"]);
    expect(span.violations[0].kind).toBe("path");
    expect(span.violations[0].repoPath).toBe("docs/apps/web/dist");
    // The reason names the one base actually consulted, not the root reading.
    expect(span.violations[0].reason).toBe("code-span path: no such tracked path beside this file");
    expect(span.counters.claims).toBe(1);
    expect(span.counters.resolved).toBe(0);
    const link = scan("The default is [x](./apps/web/dist).", opts);
    expect(targets(link)).toEqual(["./apps/web/dist"]);
    expect(link.violations[0].repoPath).toBe("docs/apps/web/dist");
    expect(link.counters.links).toBe(1);
  });

  it("keeps a `./`-rooted *value* inert in both shapes inside a fence (#396)", () => {
    // DECIDED, not exempted: `./apps/web/dist` is the asset handler's inline
    // default — a value, not a path — and a fence is the one rendering this gate
    // reads as "a value, not a citation" in both halves, so no allowlist entry is
    // taken for it.
    const text = ["# Doc", "```text", "./apps/web/dist", "```"].join("\n");
    expect(scan(text, { relPath: "docs/VPS-OPERATIONS.md", paths: [] }).violations).toEqual([]);
    const asSpan = ["# Doc", "```md", "`./apps/web/dist`", "```"].join("\n");
    expect(scan(asSpan, { relPath: "docs/VPS-OPERATIONS.md", paths: [] }).violations).toEqual([]);
    const asLink = ["# Doc", "```md", "[x](./apps/web/dist)", "```"].join("\n");
    expect(scan(asLink, { relPath: "docs/VPS-OPERATIONS.md", paths: [] }).violations).toEqual([]);
    // ...and the identical literal outside a fence is judged, so the fence is the
    // only thing keeping it inert.
    expect(targets(scan("The default is `./apps/web/dist`.", { paths: [] }))).toEqual([
      "./apps/web/dist",
    ]);
  });
});

describe("markdown-links — the two shapes agree (#391)", () => {
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
    // The reading the resolver judged — the form the ignore/allowlist chain looks up.
    expect(result.violations[0].repoPath).toBe("docs/VPS-ABSENT.md");
  });

  it("judges one target the same way in both shapes — the #391/#396 invariant", () => {
    // For each target the Markdown link and the inline code span must reach the
    // *same* status: the shapes may word their reasons differently, never disagree.
    const ctx = ctxOf({ paths: ["docs/a.md", "README.md"] });
    const relPath = "docs/living.md";
    for (const [target, expected] of [
      ["../docs/a.md", "ok"],
      ["../README.md", "ok"],
      ["../docs/gone.md", "missing"],
      ["../web/dist", "missing"],
      ["../..", "missing"],
      // The re-entry shape: the file-relative reading overshoots into
      // `repo/docs/`, while a root-first reading would land back on the real
      // `docs/a.md`. One base, so the span agrees with the link.
      ["../repo/docs/a.md", "missing"],
      ["../../etc/hosts", "missing"], // escaping: judged missing, never exempted
      // The same table for the `./` prefix: `./a.md` reads as the tracked
      // `docs/a.md`, and the other two are missing.
      ["./a.md", "ok"],
      ["./gone.md", "missing"],
      ["./web/dist", "missing"], // first segment is not a tracked root, still claimed
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

    // The one declared exception: a bare `..` is nothing but punctuation, so the
    // span half never claims it — while `[x](..)` reddens in the link half, whose
    // `toRepoPath` folds the repository root to `""`. That reading is not copied
    // into the span half, because from a deeper directory `..` resolves to a
    // tracked parent. See the header's SCOPE RULES.
    expect(analyse([{ relPath, text: "See `..`." }], ctx)).toEqual([]);
    expect(analyse([{ relPath, text: "See [x](..)." }], ctx).map((f) => f.status)).toEqual([
      "missing",
    ]);
  });

  it("reddens on an escaping target in both shapes — decided, not inherited (#391)", () => {
    // The header's decision: a `..`-rooted target whose reading leaves the
    // repository is a claim, and a missing one is a violation.
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
    // A record's `..` span is a claim like any other: the record rule still
    // counts it rather than enforcing it.
    const result = scan("Output lives in `../web/dist`.", {
      relPath: "adr/0044-vps-serving-path-cutover.md",
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

  it("offers a `..` span the same gitignore exemption as its link form (A1)", () => {
    // TRAP: this pins the reading `repoPath` carries — with a root reading the
    // span's repoPath is null, `git check-ignore` is never asked, and it reddens.
    const ignored = new Set(["apps/web/dist/index.html"]);
    const opts = { relPath: "docs/living.md", paths: [], ignored };
    const span = scan("The deploy needs `../apps/web/dist/index.html`.", opts);
    expect(span.violations).toEqual([]);
    expect(span.counters.ignored).toBe(1);
    const link = scan("The deploy needs [x](../apps/web/dist/index.html).", opts);
    expect(link.violations).toEqual([]);
    expect(link.counters.ignored).toBe(1);
  });

  it("gives an escaping-and-re-entering target one reading, reported with its verdict (A1)", () => {
    // One reading decides both the verdict and the path: with the root base also
    // in play this target would be `ok` as a span while the link was `missing`.
    const opts = { relPath: ".agents/skills/ship/SKILL.md", paths: ["docs/a.md"] };
    const span = scan("See `../repo/docs/a.md`.", opts);
    expect(targets(span)).toEqual(["../repo/docs/a.md"]);
    expect(span.violations[0].kind).toBe("path");
    expect(span.violations[0].repoPath).toBe(".agents/skills/repo/docs/a.md");
    expect(span.counters.resolved).toBe(0);
    expect(span.counters.claims).toBe(1);

    const link = scan("See [x](../repo/docs/a.md).", opts);
    expect(targets(link)).toEqual(["../repo/docs/a.md"]);
    expect(link.violations[0].repoPath).toBe(".agents/skills/repo/docs/a.md");
  });

  it("names bare `../` as claimed and judged `missing` from a depth-1 directory (A3)", () => {
    // `isFileRelativeTarget` claims bare `../` by its form, and from a depth-1
    // directory its reading is the repository root — the empty string, not a
    // tracked path — so the span copies the link half's verdict. From a deeper
    // directory the same token reads as the tracked parent and resolves.
    const depth1 = { relPath: "docs/living.md", paths: ["docs/a.md"] };
    const span = scan("A relative path starts with `../` here.", depth1);
    expect(targets(span)).toEqual(["../"]);
    expect(span.violations[0].repoPath).toBe("");
    const link = scan("A relative path looks like [x](../) here.", depth1);
    expect(targets(link)).toEqual(["../"]);
    expect(link.violations[0].repoPath).toBe("");

    const deeper = {
      relPath: ".agents/skills/ship/SKILL.md",
      paths: ["docs/a.md", ".agents/skills/code-review/SKILL.md"],
    };
    expect(scan("Climb out with `../`.", deeper).violations).toEqual([]);
    expect(scan("Climb out with `../`.", deeper).counters.resolved).toBe(1);
  });
});

describe("markdown-links — malformed destinations (#392)", () => {
  it("reports a malformed percent-encoded destination instead of dying (#392)", () => {
    // A malformed destination must still print a `file:line -> target` line, so
    // the decode cannot throw out of the scan.
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
    expect(judgeClaim("scripts/check-boundary.mjs", "docs", ctx).status).toBe("ok");
  });

  it("resolves a package-relative claim against the containing file", () => {
    // packages/infra/README.md writes `scripts/db-migrate.mjs` meaning the copy
    // beside it; a root-only rule would invent a false positive here.
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
    // The gate resolves the commit, so the verdict cannot depend on whether the
    // caller just ran a build: an untracked output is caught.
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
    // Every missing reference takes the same exemption chain, link or span, so
    // neither shape can be red with no escape.
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
    // Which shape gets which rule is data in `POLICY`, not the order of
    // `continue`s: every shape `analyse` emits must have a rule or fail loud.
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
      // highest matching `priority`, exactly as production does.
      const rule = policyFor(finding);
      expect(rule, `${finding.kind}/${finding.status}`).toBeDefined();
      expect(rule.verdict).toBeOneOf(POLICY.map((r) => r.verdict));
      // The status vocabulary is closed: a resolved, a missing, or one of the two
      // violation shapes; anything else is a classifier bug.
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
    // Precedence is a field, not the array's source order: no permutation can
    // change which rule a shape gets, and `record` must not swallow a record's link.
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
    // decides every shape alike.
    const shipped = adjudicate(findings, { allowlist: [] });
    const permuted = adjudicate(findings, { allowlist: [], table: [...POLICY].reverse() });
    expect(permuted.counters).toEqual(shipped.counters);
    expect(permuted.violations).toEqual(shipped.violations);

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

  it("reports every adr/NNNN as dangling when adr/ is gone", () => {
    expect(targets(scan("See `adr/0045`.", { paths: [], adr: [] }))).toEqual(["adr/0045"]);
  });
});

describe("markdown-links — class B: records of a moment", () => {
  it("does not enforce code-span paths inside adr/", () => {
    const result = scan("Retires `scripts/template-sync/` and `docs/QUOTA.md`.", {
      relPath: "adr/0044-vps-serving-path-cutover.md",
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
      relPath: "adr/0044-vps-serving-path-cutover.md",
      paths: [],
    });
    expect(targets(result)).toEqual(["./VPS-CUTOVER-RUNBOOK.md"]);
  });

  it("keeps the link rule ahead of the record rule, as a priority not a position (B5)", () => {
    // The split the corpus depends on in both directions: inside a record the
    // span is counted and the link is enforced, whatever the table's order.
    const result = scan(
      ["Retires `scripts/template-sync/`.", "See [the runbook](./VPS-CUTOVER-RUNBOOK.md)."].join(
        "\n",
      ),
      { relPath: "adr/0044-vps-serving-path-cutover.md", paths: [] },
    );
    expect(targets(result)).toEqual(["./VPS-CUTOVER-RUNBOOK.md"]);
    expect(result.counters.links).toBe(1);
    expect(result.counters.recordsClaims).toBe(1);
    expect(result.counters.recordsDead).toBe(1);
  });

  it("recognises exactly the two record shapes", () => {
    expect(isRecord("adr/0044-vps-serving-path-cutover.md")).toBe(true);
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
    // The "the `X` role" marker has no resolution target: it spans live harness
    // roles (`.zcode/agents/<role>.md`) and model-stage names, deliberately unchecked.
    const result = scan("The `cheap` role does the work.", { paths: [], skills: [] });
    expect(result.violations).toEqual([]);
  });

  it("matches by the span's own position, never by a line-wide search", () => {
    // The comparison is literal and index-anchored, with no regex built from the
    // span text, so a name elsewhere on the line cannot borrow the marker.
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
