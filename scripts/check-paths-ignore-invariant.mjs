#!/usr/bin/env bun
/**
 * check-paths-ignore-invariant.mjs — the gate for the workflows' paths-ignore classes.
 *
 * THE INVARIANT
 *   For each policed workflow, no path matched by its `on.push.paths-ignore` is
 *   reachable through static imports from that workflow's own execution entries.
 *   `staging.yml` builds and ships four artifacts through
 *   `provision/vps/deploy/deploy.sh` — `apps/web/index.html` (`bun run build:web`),
 *   `apps/api/src/boot.ts`, `apps/api/src/cleanup.ts` and
 *   `provision/vps/backup/kajianq-backup.mjs` — and those are its entries.
 *   `e2e.yml` boots the web build and the API entry and executes the Playwright-BDD
 *   suite, so its entries add `playwright.config.ts`, `tests/features/**` and
 *   `tests/steps/**`. `vps-restore-drill.yml` executes
 *   `provision/vps/backup/restore-drill.mjs`.
 *
 * WHY IT EXISTS (the silent failure it closes)
 *   GitHub skips a push run only when EVERY changed file matches an ignore pattern:
 *   move a production module into the ignored test-support class (a `test-utils/`
 *   directory, or a name containing `test-utils` / starting `test-fixtures`) and a
 *   push touching only that module skips the workflow while `CI` stays green. A
 *   skipped run is an ABSENT run, not a red one: silence reads as success. The same
 *   class is worse on `pull_request`, where a path-ignored workflow never reports at
 *   all — a required check then blocks the merge forever — so the two PR-triggered
 *   workflows pin that half to the docs class and widening it is a refusal here.
 *
 * THE CLASS IS DEFINED ONCE AND DERIVED PER WORKFLOW
 *   `staging.yml`'s push trigger defines the docs class and the test class. The other
 *   two workflows must apply exactly the docs class plus the test class, minus the
 *   members each names as its own execution input: `e2e.yml` keeps `tests/**` and
 *   `playwright.config.ts` because they ARE the suite it runs; the drill keeps none.
 *   A member added at `staging.yml` therefore fails this gate until it is applied or
 *   recorded as a kept input — a second, drifting glob list cannot pass.
 *
 * THE CLOSURE IS COMPUTED FROM IMPORTS, NEVER FROM A NAME LIST
 *   A name-based check passes the exact failure it exists to catch — a RENAME into
 *   the class. The check instead walks the real import graph (static
 *   `import`/`export … from`, literal `import(…)`, CSS `@import`/`url(…)`,
 *   `index.html` `src`/`href`), resolving relative, Vite-root-absolute and
 *   workspace-package specifiers through each package's `exports` map.
 *
 * GITHUB'S GLOB SEMANTICS, NOT THE SHELL'S
 *   `*` never crosses `/`; `**` matches anything including `/`; `**` before `/`
 *   matches zero or more directories; patterns are anchored to the whole path. Two
 *   deliberate widenings — case-insensitive matching, and `*` not exempted from a
 *   leading dot — both over-report, the safe direction: over-reporting is a red
 *   gate, under-reporting another silent skip. Unmodelled glob syntax (`?`, `+`,
 *   `[]`, `{}`, `\`, a leading `!`) is REFUSED, never approximated.
 *
 * FAIL CLOSED
 *   Every "cannot read my input" state refuses with a non-zero exit rather than
 *   passing: an unreadable or unparsable workflow; a missing, mistyped or empty
 *   trigger list; a missing policed workflow; a push set that does not derive from
 *   the class; a kept input no closure file backs; a `pull_request` filter wider than
 *   the docs class; a `deploy.sh` whose artifact set moved; an import specifier that
 *   resolves to nothing (a resolver gap must never look like "no edge"); and a
 *   missing YAML parser.
 *
 * WHAT IT DOES NOT COVER
 *   - `paths:` include-filters (ordered `!` semantics).
 *   - Non-import reachability of build inputs: `tsconfig.json`, `vite.config.ts`,
 *     `package.json`, Tailwind's content scanning, `tsc --noEmit` inputs (the
 *     colocated `*.test.ts` files `build:web` typechecks are outside the emitted
 *     graph by design), `import.meta.glob`, and Vite-plugin virtual modules.
 *   - Files in `node_modules`: never in a push's changed-file set, treated as leaves.
 *   - Workflows that carry no `paths-ignore`: this gate judges filters, not their
 *     absence. It also keeps each class safe, not correctly scoped.
 *
 * Run: `bun run lint`. `--root <dir>` is a read-only test seam for fixture
 * trees; the check writes nothing, ever.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..");

/** Every "cannot verify" state — the refusal the caller turns into exit 1. */
export class InvariantRefusal extends Error {}

/** The push trigger that defines the docs class and the test class. */
export const POLICED_WORKFLOW = ".github/workflows/staging.yml";
export const E2E_WORKFLOW = ".github/workflows/e2e.yml";
export const DRILL_WORKFLOW = ".github/workflows/vps-restore-drill.yml";

/** Patterns that cannot alter a build artifact or a workflow's execution, so
 * ignoring only these needs no closure check. */
export const DOCS_ONLY_PATTERNS = [
  "**.md",
  "docs/**",
  "adr/**",
  "NOTICES/**",
  ".agents/**",
  ".zcode/**",
];

export const DEPLOY_SH = "provision/vps/deploy/deploy.sh";
/** The web artifact's build command and entry (Vite root = apps/web). */
export const WEB_BUILD_COMMAND = "bun run build:web";
export const WEB_ENTRY = "apps/web/index.html";
/** The three `bun build --target=bun` entries, in deploy.sh order. */
export const FILE_ENTRIES = [
  "apps/api/src/boot.ts",
  "apps/api/src/cleanup.ts",
  "provision/vps/backup/kajianq-backup.mjs",
];

/** The API entry E2E boots, the config that selects its suite, and the suite dirs. */
export const API_ENTRY = "apps/api/src/boot.ts";
export const PLAYWRIGHT_CONFIG = "playwright.config.ts";
export const BDD_DIRS = ["tests/features", "tests/steps"];
/** The entry the restore drill executes. */
export const DRILL_ENTRY = "provision/vps/backup/restore-drill.mjs";

/** Module extensions tried when a specifier carries none, in order. */
const MODULE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx"];
/** Extensions this check parses for further edges; anything else is a leaf. */
const PARSEABLE_EXTS = new Set([
  "ts",
  "tsx",
  "mts",
  "cts",
  "mjs",
  "cjs",
  "js",
  "jsx",
  "css",
  "html",
]);

const UNMODELLED_GLOB_CHARS = /[?+[\]{}\\]/;

const STATIC_IMPORT_RE = /\bimport\s*(?:type\s+)?(?:[\w$*{},\s]*?\sfrom\s*)?["']([^"']+)["']/g;
const EXPORT_FROM_RE = /\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})\s*from\s*["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const CSS_IMPORT_RE = /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?/g;
const CSS_URL_RE = /url\(\s*(?:["']([^"']+)["']|([^"')]+))\s*\)/g;
const HTML_REF_RE = /<(?:script|link|img|source)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;

/**
 * Compile one GitHub path-filter pattern to an anchored RegExp: a `**` followed by
 * `/` matches zero or more leading directories, any other `**` matches any run of
 * characters, and `*` any run that never crosses `/`.
 */
export function compilePattern(pattern) {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new InvariantRefusal("empty paths-ignore pattern — refusing to match nothing");
  }
  if (pattern.startsWith("!")) {
    throw new InvariantRefusal(
      `negated pattern "${pattern}" — ordered negation is not modelled; ` +
        "use the `paths` filter with its documented ordering, or extend this matcher deliberately",
    );
  }
  const unmodelled = pattern.match(UNMODELLED_GLOB_CHARS);
  if (unmodelled) {
    throw new InvariantRefusal(
      `pattern "${pattern}" uses "${unmodelled[0]}", a glob feature this check does not model ` +
        "(GitHub's filter cheat sheet defines it; see the script header) — extend the matcher " +
        "deliberately rather than letting it guess",
    );
  }
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i] === "*") {
      if (pattern[i + 1] === "*") {
        i += 1;
        if (pattern[i + 1] === "/") {
          i += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    source += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  // `i` is the deliberate fail-closed widening (over-report only): the pattern is
  // a checked-in `staging.yml` one, escaped above before the only expansions.
  // nosemgrep: detect-non-literal-regexp
  return new RegExp(`^${source}$`, "i");
}

/** Compile a pattern list once, keeping the source pattern for reporting. */
export function compilePatterns(patterns) {
  return patterns.map((pattern) => ({ pattern, regex: compilePattern(pattern) }));
}

/** The first pattern matching `file` (repo-relative, POSIX separators), or null. */
export function firstMatch(compiled, file) {
  return compiled.find(({ regex }) => regex.test(file)) ?? null;
}

/**
 * Read the policed workflow's `on.push.paths-ignore`, refusing anything it cannot
 * read exactly (no YAML parser, unparsable document, missing trigger, absent/
 * mistyped/empty list, non-string entry); `yamlParse` is injectable for tests and
 * `event` selects the trigger (`push` by default).
 */
export function parsePathsIgnore(text, yamlParse, event = "push") {
  const parse = yamlParse ?? runtimeYamlParser();
  let doc;
  try {
    doc = parse(text);
  } catch (error) {
    throw new InvariantRefusal(`cannot parse the workflow YAML: ${error.message}`);
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new InvariantRefusal("the workflow YAML is not a mapping — cannot read its trigger");
  }
  // A YAML 1.1 parser keys the bare `on` as boolean true; a 1.2 parser as "on".
  const on = doc.on ?? doc["on"] ?? doc[true];
  if (on === null || typeof on !== "object" || Array.isArray(on)) {
    throw new InvariantRefusal("no `on:` trigger block in the policed workflow — cannot verify");
  }
  const trigger = on[event];
  const label = `on.${event}`;
  if (trigger === null || typeof trigger !== "object" || Array.isArray(trigger)) {
    throw new InvariantRefusal(
      `no \`${label}\` trigger in the policed workflow — this check reads that trigger's ` +
        "paths-ignore, so its absence is a refusal, not an empty match set",
    );
  }
  if (trigger.paths !== undefined) {
    throw new InvariantRefusal(
      `\`${label}\` carries both \`paths\` and \`paths-ignore\` — GitHub rejects that combination ` +
        "(a filter has one or the other); fix the trigger before this check can police it",
    );
  }
  const list = trigger["paths-ignore"];
  if (list === undefined) {
    throw new InvariantRefusal(
      `\`${label}.paths-ignore\` is absent — the class this check exists for is not ` +
        "where it was; if the class moved, move this check with it",
    );
  }
  if (!Array.isArray(list)) {
    throw new InvariantRefusal(
      `\`${label}.paths-ignore\` is ${typeof list}, not a list — cannot read the pattern set`,
    );
  }
  if (list.length === 0) {
    throw new InvariantRefusal(
      `\`${label}.paths-ignore\` is empty — this check would police nothing and pass vacuously; ` +
        "remove the filter deliberately and retire this check in the same change",
    );
  }
  return list.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new InvariantRefusal(
        `\`${label}.paths-ignore[${index}]\` is not a non-empty string — cannot read the pattern set`,
      );
    }
    return entry;
  });
}

function runtimeYamlParser() {
  if (typeof Bun === "undefined" || typeof Bun.YAML?.parse !== "function") {
    throw new InvariantRefusal(
      "no YAML parser available (this check runs under Bun and needs Bun.YAML) — " +
        "refusing to guess at the trigger instead of passing",
    );
  }
  return (text) => Bun.YAML.parse(text);
}

/** Blank out comments while preserving string literals (import specifiers live in
 * them); a specifier quoted in a comment would otherwise create a phantom edge
 * whose unresolved path refuses a clean tree. */
export function stripComments(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") out += "\n";
        i += 1;
      }
      i += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      out += char;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          out += source[i] + (source[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += source[i];
        const done = source[i] === char;
        i += 1;
        if (done) break;
      }
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

function collect(text, regex, group = 1) {
  const found = [];
  for (const match of text.matchAll(regex)) {
    if (match[group]) found.push(match[group]);
  }
  return found;
}

/**
 * Every import edge in one source file: JS/TS static imports, re-exports and
 * literal dynamic imports; CSS `@import` chains and `url(…)` assets; HTML
 * `src`/`href` on script/link/img/source. A `module` edge that resolves to nothing
 * is a broken build (refused); an `asset` reference may be a runtime URL (`/chat`)
 * and is soft-skipped when no file backs it. Type-only imports are followed too —
 * over-reporting is a red gate — and runtime specifiers are dropped.
 */
export function extractSpecifiers(text, ext) {
  if (ext === "html") {
    return collect(text, HTML_REF_RE, 1).map((spec) => ({ spec, kind: "asset" }));
  }
  if (ext === "css") {
    return [
      ...collect(text, CSS_IMPORT_RE, 1).map((spec) => ({ spec, kind: "module" })),
      ...collect(text, CSS_URL_RE, 1).map((spec) => ({ spec, kind: "asset" })),
      ...collect(text, CSS_URL_RE, 2).map((spec) => ({ spec, kind: "asset" })),
    ];
  }
  return [
    ...collect(text, STATIC_IMPORT_RE, 1).map((spec) => ({ spec, kind: "module" })),
    ...collect(text, EXPORT_FROM_RE, 1).map((spec) => ({ spec, kind: "module" })),
    ...collect(text, DYNAMIC_IMPORT_RE, 1).map((spec) => ({ spec, kind: "module" })),
  ];
}

function isExternalReference(spec) {
  return /^[a-z][a-z0-9+.-]*:/i.test(spec) || spec.startsWith("//") || spec.startsWith("#");
}

function isRuntimeModule(spec) {
  return spec === "bun" || spec.startsWith("bun:") || spec.startsWith("node:");
}

function asFile(candidate) {
  try {
    return statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

function resolveWithExtensions(target) {
  const direct = asFile(target);
  if (direct) return direct;
  for (const ext of MODULE_EXTS) {
    const file = asFile(`${target}${ext}`);
    if (file) return file;
  }
  for (const ext of MODULE_EXTS) {
    const file = asFile(join(target, `index${ext}`));
    if (file) return file;
  }
  return null;
}

/**
 * Resolve a specifier: relative ones against the importing file's directory,
 * `/`-absolute ones against the Vite root `baseDir` with a fallback to that root's
 * `public/` (copied into `dist/` verbatim, so a real artifact input); Vite query
 * suffixes are stripped. Null means nothing exists — the caller interprets that.
 */
export function resolvePathSpecifier(spec, fromFile, baseDir) {
  const clean = spec.replace(/[?#].*$/, "");
  if (clean === "") return null;
  if (clean.startsWith("/")) {
    const relativePath = clean.slice(1);
    return (
      resolveWithExtensions(resolve(baseDir, relativePath)) ??
      resolveWithExtensions(resolve(baseDir, "public", relativePath))
    );
  }
  return resolveWithExtensions(resolve(dirname(fromFile), clean));
}

function exportTarget(value) {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  for (const condition of ["bun", "import", "node", "default", "require", "types"]) {
    const picked = exportTarget(value[condition]);
    if (picked) return picked;
  }
  return Object.values(value).map(exportTarget).find(Boolean) ?? null;
}

export function loadWorkspaceIndex(root) {
  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const dirs = [];
  for (const pattern of rootPkg.workspaces ?? []) {
    if (pattern.endsWith("/*")) {
      const parent = join(root, pattern.slice(0, -2));
      if (!existsSync(parent)) continue;
      for (const name of readdirSync(parent)) {
        if (asFile(join(parent, name, "package.json"))) dirs.push(join(parent, name));
      }
    } else if (asFile(join(root, pattern, "package.json"))) {
      dirs.push(join(root, pattern));
    }
  }
  const index = new Map();
  for (const dir of dirs) {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (pkg.name) index.set(pkg.name, { dir, exports: pkg.exports });
  }
  return index;
}

function matchExport(exportsMap, subpath) {
  if (typeof exportsMap === "string") return subpath === "." ? exportsMap : null;
  if (exportsMap === null || typeof exportsMap !== "object") return null;
  const keys = Object.keys(exportsMap);
  if (!keys.some((key) => key.startsWith("."))) {
    return subpath === "." ? exportTarget(exportsMap) : null;
  }
  if (exportsMap[subpath] !== undefined) return exportTarget(exportsMap[subpath]);
  for (const key of keys) {
    if (!key.endsWith("/*")) continue;
    const prefix = key.slice(0, -1);
    if (!subpath.startsWith(prefix)) continue;
    const target = exportTarget(exportsMap[key]);
    // Node's subpath-pattern semantics: EVERY `*` in the target is the matched
    // portion, from a checked-in package.json, and must resolve to a real file.
    if (target) return target.replaceAll("*", subpath.slice(prefix.length));
  }
  return null;
}

function findInNodeModules(name, fromFile, root) {
  let dir = dirname(fromFile);
  for (;;) {
    if (existsSync(join(dir, "node_modules", name))) return join(dir, "node_modules", name);
    const parent = dirname(dir);
    if (dir === root || parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve a bare specifier: a workspace package (followed into the graph) or a
 * node_modules dependency (an external leaf); anything else refuses. The lookup
 * walks up from the importer, because Bun's isolated workspace layout puts a
 * dependency in the importing package's own `node_modules`.
 */
export function resolveBareSpecifier(spec, workspaceIndex, root, fromFile) {
  const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
  const workspace = workspaceIndex.get(name);
  if (workspace) {
    const subpath = spec === name ? "." : `.${spec.slice(name.length)}`;
    const target =
      matchExport(workspace.exports, subpath) ?? (subpath === "." ? "./src/index.ts" : null);
    const file = target ? resolveWithExtensions(resolve(workspace.dir, target)) : null;
    if (!file) {
      throw new InvariantRefusal(
        `workspace specifier "${spec}" resolves to no file (exports target: ${target ?? "none"}) — ` +
          "the import closure would be incomplete",
      );
    }
    return { external: false, file };
  }
  if (findInNodeModules(name, fromFile, root)) return { external: true, file: null };
  throw new InvariantRefusal(
    `cannot resolve bare specifier "${spec}" from ${relative(root, fromFile).split(sep).join("/")}: ` +
      "not a workspace package and not in node_modules — the import closure would be incomplete",
  );
}

/**
 * Statically walk the import graph from `entries` (`{ file, baseDir }`, where
 * `baseDir` is what a leading `/` resolves against), returning `{ closure,
 * looseRefs }`: absolute file path → `{ entry, parent, baseDir }`, so every hit
 * prints its chain, plus the asset references no file backs.
 * Fail-closed: an unresolvable `module` specifier refuses (a broken build must not
 * read as "no edge"), while an unresolvable `asset` reference is collected —
 * `<a href="/chat">` and API paths are legitimately fileless.
 */
export function buildClosure(entries, root) {
  const workspaceIndex = loadWorkspaceIndex(root);
  const closure = new Map();
  const looseRefs = [];
  const queue = [];
  for (const entry of entries) {
    const file = asFile(resolve(root, entry.file));
    if (!file) {
      throw new InvariantRefusal(
        `deploy entry ${entry.file} not found — deploy.sh's artifact set and this check disagree`,
      );
    }
    closure.set(file, { entry: entry.file, parent: null, baseDir: resolve(root, entry.baseDir) });
    queue.push(file);
  }
  while (queue.length > 0) {
    const file = queue.shift();
    const node = closure.get(file);
    const ext = extname(file).slice(1).toLowerCase();
    if (!PARSEABLE_EXTS.has(ext)) continue;
    const text = stripComments(readFileSync(file, "utf8"));
    for (const { spec, kind } of extractSpecifiers(text, ext)) {
      if (isExternalReference(spec) || isRuntimeModule(spec)) continue;
      const where = relative(root, file).split(sep).join("/");
      let target;
      if (spec.startsWith(".") || spec.startsWith("/")) {
        target = resolvePathSpecifier(spec, file, node.baseDir);
        if (!target) {
          if (kind === "asset") {
            looseRefs.push({ spec, from: where });
            continue;
          }
          throw new InvariantRefusal(
            `cannot resolve "${spec}" imported by ${where} — a resolver gap must not read as ` +
              "'no edge'; fix the specifier or extend this resolver",
          );
        }
      } else {
        const resolved = resolveBareSpecifier(spec, workspaceIndex, root, file);
        if (resolved.external) continue;
        target = resolved.file;
      }
      if (!closure.has(target)) {
        closure.set(target, { entry: node.entry, parent: file, baseDir: node.baseDir });
        queue.push(target);
      }
    }
  }
  return { closure, looseRefs };
}

/** Tracked plus untracked-but-not-ignored files: what a push could carry. */
export function collectRepoFiles(root) {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  });
  return out
    .split("\n")
    .filter(Boolean)
    .map((file) => file.split(sep).join("/"));
}

export function importChain(file, closure, root) {
  const chain = [];
  for (let node = file; node; node = closure.get(node)?.parent) chain.unshift(node);
  return chain.map((abs) => relative(root, abs).split(sep).join("/"));
}

/** Assert the deploy entry set still matches deploy.sh, so a FIFTH production entry
 * cannot appear unguarded; textual and count-based on purpose, since parsing shell
 * would be its own bug surface while a count mismatch is exact. */
export function assertDeployEntrySet(deployShText) {
  if (!deployShText.includes(WEB_BUILD_COMMAND)) {
    throw new InvariantRefusal(
      `\`${WEB_BUILD_COMMAND}\` is not in ${DEPLOY_SH} — the web artifact this check walks from ` +
        `${WEB_ENTRY} is built by a command it does not know; update the entry set deliberately`,
    );
  }
  for (const entry of FILE_ENTRIES) {
    if (!deployShText.includes(entry)) {
      throw new InvariantRefusal(
        `${DEPLOY_SH} no longer names ${entry} — the artifact set moved; update FILE_ENTRIES deliberately`,
      );
    }
  }
  const builds = [...deployShText.matchAll(/\bbun build\b/g)].length;
  if (builds !== FILE_ENTRIES.length) {
    throw new InvariantRefusal(
      `${DEPLOY_SH} runs \`bun build\` ${builds} time(s) but this check knows ` +
        `${FILE_ENTRIES.length} entries — a production entry is unguarded; add it deliberately`,
    );
  }
}

/** The files under a repo-relative directory, POSIX separators, sorted for
 * deterministic output. A missing directory yields no files; a kept pattern that
 * pointed at it then fails its closure assertion rather than passing vacuously. */
function filesUnder(root, dir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childAbs = join(abs, entry.name);
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(childAbs, childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  };
  const abs = join(root, dir);
  if (existsSync(abs)) walk(abs, dir);
  return out.sort();
}

/** The entries `e2e.yml` executes: the web build and API entry it boots, the
 * Playwright config, and every BDD feature/step file. */
export function e2eEntries(root) {
  return [
    { file: WEB_ENTRY, baseDir: dirname(WEB_ENTRY) },
    { file: API_ENTRY, baseDir: "." },
    { file: PLAYWRIGHT_CONFIG, baseDir: "." },
    ...BDD_DIRS.flatMap((dir) => filesUnder(root, dir).map((file) => ({ file, baseDir: "." }))),
  ];
}

/** The entry `vps-restore-drill.yml` executes. */
export function drillEntries() {
  return [{ file: DRILL_ENTRY, baseDir: "." }];
}

export function deployEntries() {
  return [
    { file: WEB_ENTRY, baseDir: dirname(WEB_ENTRY) },
    ...FILE_ENTRIES.map((file) => ({ file, baseDir: "." })),
  ];
}

/** The test class: every non-docs pattern at the class source's push trigger. */
export function deriveTestClass(classPatterns) {
  return classPatterns.filter((pattern) => !DOCS_ONLY_PATTERNS.includes(pattern));
}

/** How each policed workflow derives from the class at `POLICED_WORKFLOW`.
 * `definesClass` marks the source; `keep` names class members the workflow itself
 * executes, so it must not ignore them; `pullRequest` marks a workflow whose PR half
 * this check pins to the docs class. */
export const WORKFLOW_SPECS = [
  {
    file: POLICED_WORKFLOW,
    definesClass: true,
    pullRequest: false,
    entryLabel: "deploy entry",
    entries: () => deployEntries(),
  },
  {
    file: E2E_WORKFLOW,
    keep: ["tests/**", PLAYWRIGHT_CONFIG],
    pullRequest: true,
    entryLabel: "execution entry",
    entries: (root) => e2eEntries(root),
  },
  {
    file: DRILL_WORKFLOW,
    keep: [],
    pullRequest: true,
    entryLabel: "execution entry",
    entries: () => drillEntries(),
  },
];

/** List the items of `a` that `b` does not carry, in `a`'s order. */
function missingFrom(a, b) {
  return a.filter((item) => !b.includes(item));
}

/** Refuse a push set that is not exactly the docs class plus the test class minus
 * this workflow's kept inputs — the class is named once, at its source. */
function assertDerivedPushClass(spec, patterns, testClass) {
  const keep = spec.keep ?? [];
  const staleKeep = missingFrom(keep, testClass);
  if (staleKeep.length > 0) {
    throw new InvariantRefusal(
      `${spec.file} keeps ${staleKeep.map((p) => `"${p}"`).join(", ")} out of its push ` +
        `paths-ignore, but that is not in the test class at ${POLICED_WORKFLOW} — drop the stale ` +
        "exception, or add the class member once at its source",
    );
  }
  const expected = [...DOCS_ONLY_PATTERNS, ...missingFrom(testClass, keep)];
  const missing = missingFrom(expected, patterns);
  const unexpected = missingFrom(patterns, expected);
  if (missing.length === 0 && unexpected.length === 0) return;
  throw new InvariantRefusal(
    `${spec.file}'s on.push.paths-ignore does not derive from the class at ${POLICED_WORKFLOW}` +
      (missing.length > 0 ? `; missing ${missing.map((p) => `"${p}"`).join(", ")}` : "") +
      (unexpected.length > 0 ? `; unexpected ${unexpected.map((p) => `"${p}"`).join(", ")}` : "") +
      " — the class is named once at its source; apply a new member there, or record it as " +
      "this workflow's kept execution input",
  );
}

/** Refuse a `pull_request` filter wider than the docs class. A path-ignored
 * workflow never reports on a PR at all, so a required check would block forever;
 * widening that half is a gating decision, not a trigger edit. */
function assertPullRequestDocsOnly(file, text) {
  const patterns = parsePathsIgnore(text, undefined, "pull_request");
  const foreign = missingFrom(patterns, DOCS_ONLY_PATTERNS);
  const dropped = missingFrom(DOCS_ONLY_PATTERNS, patterns);
  if (foreign.length === 0 && dropped.length === 0) return;
  throw new InvariantRefusal(
    `${file}'s on.pull_request.paths-ignore is not the docs class` +
      (foreign.length > 0 ? `; it adds ${foreign.map((p) => `"${p}"`).join(", ")}` : "") +
      (dropped.length > 0 ? `; it drops ${dropped.map((p) => `"${p}"`).join(", ")}` : "") +
      " — a path-ignored workflow never reports on a pull request at all, so its checks are " +
      "absent rather than failed and a required one blocks the merge forever; if the PR half is " +
      "deliberately filtered, record why the check is not required and update this check",
  );
}

/** Prove each kept input is real: at least one file in the workflow's execution
 * closure matches it, so an exception cannot outlive the suite it was written for. */
function assertKeptInputs(spec, closure, root) {
  for (const kept of spec.keep ?? []) {
    const regex = compilePattern(kept);
    const hit = [...closure.keys()].some((abs) =>
      regex.test(relative(root, abs).split(sep).join("/")),
    );
    if (!hit) {
      throw new InvariantRefusal(
        `${spec.file} keeps "${kept}" out of its push paths-ignore, but no file in its execution ` +
          "closure matches it — a kept input must be something the workflow really runs; if the " +
          "suite moved, update this check's closure entries with it",
      );
    }
  }
}

/** Verify every policed workflow against `root`; returns the evidence the OK line
 * prints and throws InvariantRefusal for any "cannot verify" state or any hit. */
export function verify(root = REPO_ROOT) {
  const classPath = join(root, POLICED_WORKFLOW);
  if (!existsSync(classPath)) {
    throw new InvariantRefusal(
      `${POLICED_WORKFLOW} not found under ${root} — this check derives the class from that ` +
        "push trigger; refusing to pass without it",
    );
  }
  const testClass = deriveTestClass(parsePathsIgnore(readFileSync(classPath, "utf8")));
  if (testClass.length === 0) {
    throw new InvariantRefusal(
      `${POLICED_WORKFLOW}'s push paths-ignore carries no test class — the other policed ` +
        "workflows derive their class from it, so an empty class would police them vacuously",
    );
  }
  const files = collectRepoFiles(root);
  const workflows = [];
  for (const spec of WORKFLOW_SPECS) {
    const workflowPath = join(root, spec.file);
    if (!existsSync(workflowPath)) {
      throw new InvariantRefusal(
        `${spec.file} not found under ${root} — this check polices that trigger set; ` +
          "refusing to pass without it",
      );
    }
    const text = readFileSync(workflowPath, "utf8");
    const patterns = parsePathsIgnore(text);
    if (!spec.definesClass) assertDerivedPushClass(spec, patterns, testClass);
    if (spec.pullRequest) assertPullRequestDocsOnly(spec.file, text);
    if (spec.file === POLICED_WORKFLOW) {
      const deployShPath = join(root, DEPLOY_SH);
      if (!existsSync(deployShPath)) {
        throw new InvariantRefusal(
          `${DEPLOY_SH} not found — cannot derive the deploy artifact set`,
        );
      }
      assertDeployEntrySet(readFileSync(deployShPath, "utf8"));
    }

    const entries = spec.entries(root);
    const { closure, looseRefs } = buildClosure(entries, root);
    assertKeptInputs(spec, closure, root);

    const compiled = compilePatterns(patterns);
    const matched = files.flatMap((file) => {
      const hit = firstMatch(compiled, file);
      return hit ? [{ file, pattern: hit.pattern }] : [];
    });
    const violations = matched.filter(({ file }) => closure.has(resolve(root, file)));
    if (violations.length > 0) {
      const detail = violations
        .map(({ file, pattern }) => {
          const chain = importChain(resolve(root, file), closure, root);
          return (
            `  paths-ignore-invariant: "${pattern}" matches ${file}\n` +
            `    reachable from ${spec.entryLabel} ${chain[0]}: ${chain.join(" → ")}`
          );
        })
        .join("\n");
      throw new InvariantRefusal(
        `${violations.length} path(s) matched by ${spec.file}'s paths-ignore are in its static ` +
          `import closure — a change to them skips the workflow while changing what it exercises:\n${detail}`,
      );
    }
    workflows.push({ file: spec.file, patterns, matched, closure, entries, looseRefs });
  }
  return { testClass, workflows };
}

function main() {
  const flag = process.argv.indexOf("--root");
  const root = flag === -1 ? REPO_ROOT : resolve(process.argv[flag + 1]);
  try {
    const { testClass, workflows } = verify(root);
    for (const workflow of workflows) {
      console.log(
        `paths-ignore-invariant OK — ${workflow.file} on.push.paths-ignore ` +
          `(${workflow.patterns.length} patterns, ${workflow.matched.length} matched paths) × ` +
          `static import closure of ${workflow.entries.length} entries ` +
          `(${workflow.closure.size} files): 0 matches`,
      );
    }
    console.log(
      `  test class derived from ${POLICED_WORKFLOW}: ${testClass.length} patterns; ` +
        "pull_request filters carry the docs class only",
    );
    // The same asset can sit in several closures; count each reference once.
    const loose = new Set(
      workflows.flatMap((workflow) =>
        workflow.looseRefs.map((ref) => `${ref.from}\u0000${ref.spec}`),
      ),
    );
    console.log(
      `  assets referenced but not files (runtime URLs, outside the graph): ${loose.size}`,
    );
  } catch (error) {
    if (error instanceof InvariantRefusal) {
      console.error(`paths-ignore-invariant: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

// Run only when invoked as a script, not when imported by tests.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
