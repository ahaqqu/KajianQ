#!/usr/bin/env bun
/**
 * check-paths-ignore-invariant.mjs — the gate for `staging.yml`'s paths-ignore
 * invariant (#399, closing the deferral recorded at that file's patterns).
 *
 * THE INVARIANT
 *   No path matched by `.github/workflows/staging.yml`'s `on.push.paths-ignore`
 *   is reachable through static imports from any of the four entries
 *   `provision/vps/deploy/deploy.sh` builds:
 *
 *     apps/web/index.html                       (`bun run build:web`)
 *     apps/api/src/boot.ts                      (`bun build --target=bun`)
 *     apps/api/src/cleanup.ts                   (`bun build --target=bun`)
 *     provision/vps/backup/kajianq-backup.mjs   (`bun build --target=bun`)
 *
 * WHY IT EXISTS (the silent failure it closes)
 *   GitHub skips a push run only when EVERY changed file matches an ignore
 *   pattern. Move a production module into the ignored test-support class — a
 *   `test-utils/` directory, or a name containing `test-utils` / starting
 *   `test-fixtures` — and a push touching only that module skips `Staging`
 *   while `CI` and `E2E` stay green. A skipped deploy is an ABSENT run, not a
 *   red one: nothing reports, and a post-merge check reads the silence as
 *   success. Prose beside the patterns cannot catch that; this gate does.
 *
 * THE CLOSURE IS COMPUTED FROM IMPORTS, NEVER FROM A NAME LIST
 *   A name-based check passes the exact failure it exists to catch: a RENAME
 *   that moves a production module into the class (the module keeps its
 *   importers, only its path changes). So the check walks the real import
 *   graph — static `import`/`export … from`, literal `import(…)`, CSS
 *   `@import`/`url(…)`, and `index.html`'s `src`/`href` references — resolving
 *   relative specifiers, Vite-root-absolute ones, and workspace package
 *   specifiers through each package's `exports` map. The intersection of that
 *   closure with the matched set is the verdict.
 *
 * GITHUB'S GLOB SEMANTICS, NOT THE SHELL'S
 *   `*` matches zero or more characters and never `/`; `**` matches anything
 *   including `/`; `**` immediately before `/` matches zero or more directories; patterns are
 *   anchored to the whole path. Two deliberate widenings — matching is
 *   case-insensitive, and `*` is not exempted from a leading dot — both in the
 *   safe direction for this invariant: a wider matcher can only over-report,
 *   and over-reporting is a red gate, while under-reporting would be another
 *   silent skip. Glob syntax this matcher does not model (`?`, `+`, `[]`,
 *   `{}`, `\`, or a leading `!`) is REFUSED, never approximated: the GitHub
 *   cheat sheet documents those for filters, so guessing at their semantics
 *   could silently miss a match. Extend the matcher deliberately instead.
 *
 * FAIL CLOSED
 *   Every "cannot read my input" state refuses with a non-zero exit rather
 *   than passing: an unreadable or unparsable `staging.yml`; a missing,
 *   mistyped or empty `on.push.paths-ignore`; a `deploy.sh` whose artifact set
 *   no longer matches the four entries this check knows; an import specifier
 *   that resolves to nothing (a resolver gap must never look like "no edge");
 *   and a missing YAML parser at runtime. The OK line prints what was policed
 *   and what it covered — policed workflow + trigger, pattern count, matched
 *   set size, closure size — so a silently emptied match set or a collapsed
 *   closure is visible in the log instead of reading as a pass.
 *
 * WHAT IT POLICES, AND WHY NOT THE OTHER TWO
 *   This check polices `staging.yml`'s push trigger only. `e2e.yml` and
 *   `vps-restore-drill.yml` ignore only the docs patterns and carry a
 *   different invariant (#379, still open): they also trigger on
 *   `pull_request`, where a path-ignored workflow does not report at all — its
 *   checks stay "Pending" and a required check blocks the merge, which is a
 *   different (and visible) failure than a skipped deploy. Their pattern
 *   lists cannot simply copy this class, so this check verifies they stay
 *   docs-only and refuses if either grows a class it does not vouch for; that
 *   refusal is where #379's trigger set gets added deliberately.
 *
 * WHAT IT DOES NOT COVER
 *   - `paths:` include-filters on any workflow (a different filter with
 *     ordered `!` semantics), and `pull_request.paths-ignore` anywhere.
 *   - Non-import reachability of build inputs: `tsconfig.json`, `vite.config.ts`,
 *     `package.json`, Tailwind's content scanning, `tsc --noEmit` inputs (the
 *     colocated `*.test.ts` files `build:web` typechecks are outside the
 *     emitted graph by design), `import.meta.glob` (unused today), and
 *     Vite-plugin-injected virtual modules.
 *   - Files in `node_modules`: they are not in `git ls-files`, can never appear
 *     in a push's changed-file set, and are treated as leaves.
 *   - Whether the *ignored* patterns are the right class: this gate keeps the
 *     class safe, not correctly scoped.
 *
 * Run: `bun run lint` (wired beside check-vp-vite-pin.mjs). `--root <dir>` is a
 * read-only test seam for fixture trees; the check writes nothing, ever.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..");

/** Every "cannot verify" state — the refusal the caller turns into exit 1. */
export class InvariantRefusal extends Error {}

/** The one workflow whose push trigger this check polices. */
export const POLICED_WORKFLOW = ".github/workflows/staging.yml";

/**
 * Patterns that cannot alter a build artifact: markdown, docs, ADRs, notices,
 * and the agent-instruction trees. A workflow ignoring only these needs no
 * deploy-closure check, and a class outside this set is one this check refuses
 * to vouch for until it is policed deliberately.
 */
export const DOCS_ONLY_PATTERNS = [
  "**.md",
  "docs/**",
  "adr/**",
  "NOTICES/**",
  ".agents/**",
  ".zcode/**",
];

/**
 * Workflows that carry a push `paths-ignore` this check does not police, with
 * the recorded reason. Their trigger sets join `POLICED_WORKFLOW` the day a
 * class lands in them (#379); until then their lists must stay docs-only and
 * this check says so in its own output rather than leaving the claim to prose.
 */
export const UNPOLICED_WORKFLOWS = [
  {
    file: ".github/workflows/e2e.yml",
    reason:
      "docs-only class; also triggers on pull_request, where a path-ignored workflow never " +
      "reports at all (#379)",
  },
  {
    file: ".github/workflows/vps-restore-drill.yml",
    reason:
      "docs-only class; also triggers on pull_request, where a path-ignored workflow never " +
      "reports at all (#379)",
  },
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

/** Glob syntax the matcher does not model — refused rather than approximated. */
const UNMODELLED_GLOB_CHARS = /[?+[\]{}\\]/;

/** `import`/`import type` with an optional clause, and bare side-effect imports. */
const STATIC_IMPORT_RE = /\bimport\s*(?:type\s+)?(?:[\w$*{},\s]*?\sfrom\s*)?["']([^"']+)["']/g;
/** `export … from "…"` re-exports. */
const EXPORT_FROM_RE = /\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})\s*from\s*["']([^"']+)["']/g;
/** Literal dynamic imports. */
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
/** CSS `@import "…"` / `@import url(…)`. */
const CSS_IMPORT_RE = /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?/g;
/** CSS `url(…)` asset references. */
const CSS_URL_RE = /url\(\s*(?:["']([^"']+)["']|([^"')]+))\s*\)/g;
/** HTML `src`/`href` references on the element kinds Vite turns into inputs. */
const HTML_REF_RE = /<(?:script|link|img|source)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;

/**
 * Compile one GitHub path-filter pattern to an anchored RegExp.
 *
 * `**` followed by `/` matches zero or more leading directories (such a pattern
 * must match both `x` and `a/b/x` — the shell's single-star form matches neither the zero case
 * nor across `/`); every other `**` matches any run of characters; a single
 * `*` matches any run that never crosses `/`.
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
  // `i` (case-insensitive) is the deliberate fail-closed widening: over-report only.
  // The source is a checked-in `staging.yml` pattern, escaped above (`.`/`(`/`|`…
  // become literals) before the only deliberate expansions (`*`, `**`) are added;
  // it is compiled once at gate startup, in build/CI time, over repo paths — never
  // over runtime input, so there is no attacker-controlled pattern here.
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
 * Read the policed workflow's `on.push.paths-ignore`.
 *
 * Refuses on anything it cannot read exactly: no YAML parser, an unparsable
 * document, a missing `on.push` block, an absent/mistyped/empty pattern list,
 * or a non-string entry. `yamlParse` is injectable so the refusal paths are
 * unit-testable without a malformed document.
 */
export function parsePathsIgnore(text, yamlParse) {
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
  const push = on.push;
  if (push === null || typeof push !== "object" || Array.isArray(push)) {
    throw new InvariantRefusal(
      "no `on.push` trigger in the policed workflow — this check polices the push trigger's " +
        "paths-ignore, so its absence is a refusal, not an empty match set",
    );
  }
  if (push.paths !== undefined) {
    throw new InvariantRefusal(
      "`on.push` carries both `paths` and `paths-ignore` — GitHub rejects that combination " +
        "(a filter has one or the other); fix the trigger before this check can police it",
    );
  }
  const list = push["paths-ignore"];
  if (list === undefined) {
    throw new InvariantRefusal(
      "`on.push.paths-ignore` is absent — the deploy-skip class this check exists for is not " +
        "where it was; if the class moved, move this check with it",
    );
  }
  if (!Array.isArray(list)) {
    throw new InvariantRefusal(
      `\`on.push.paths-ignore\` is ${typeof list}, not a list — cannot read the pattern set`,
    );
  }
  if (list.length === 0) {
    throw new InvariantRefusal(
      "`on.push.paths-ignore` is empty — this check would police nothing and pass vacuously; " +
        "remove the filter deliberately and retire this check in the same change",
    );
  }
  return list.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new InvariantRefusal(
        `\`on.push.paths-ignore[${index}]\` is not a non-empty string — cannot read the pattern set`,
      );
    }
    return entry;
  });
}

/** Bun's YAML parser, with an explicit refusal when it is not there. */
function runtimeYamlParser() {
  if (typeof Bun === "undefined" || typeof Bun.YAML?.parse !== "function") {
    throw new InvariantRefusal(
      "no YAML parser available (this check runs under Bun and needs Bun.YAML) — " +
        "refusing to guess at the trigger instead of passing",
    );
  }
  return (text) => Bun.YAML.parse(text);
}

/**
 * Blank out comments while preserving string literals (import specifiers live
 * in them). Without this, a specifier quoted in a doc comment would create a
 * phantom edge — and a phantom edge whose path does not resolve would refuse a
 * clean tree.
 */
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
 * Every import edge in one source file, by extension:
 *   - JS/TS: static imports, re-exports, literal dynamic imports
 *   - CSS:   `@import` chains (`module` edges) and `url(…)` assets
 *   - HTML:  `src`/`href` on script/link/img/source
 *
 * Kind matters for what an unresolved specifier means: a `module` edge that
 * resolves to nothing is a broken build (refused), while an `asset` reference
 * may legitimately be a runtime URL (`/chat`, an API route) and is soft-skipped
 * when no file backs it — counted in the OK line so it never vanishes silently.
 * Type-only imports are followed too: over-reporting a type edge is a red gate,
 * while skipping one would be an under-report. Runtime specifiers (`node:*`,
 * `bun`, `bun:*`) are dropped here; every other bare specifier is resolved
 * against the workspace and then node_modules by the caller.
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

/** A reference scheme/authority/fragment that can never be a repo path. */
function isExternalReference(spec) {
  return /^[a-z][a-z0-9+.-]*:/i.test(spec) || spec.startsWith("//") || spec.startsWith("#");
}

/** A runtime module (never a repo path, never in node_modules). */
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

/** A specifier's extensionless forms: the file itself, then `index.*`. */
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
 * Resolve a specifier: relative ones against the importing file's directory
 * (Node semantics, and what every bundler does), `/`-absolute ones against the
 * Vite root — `baseDir` (for the web entry: `apps/web`) — with a fallback to
 * that root's `public/` dir, which is copied into `dist/` verbatim and is
 * therefore a real artifact input.
 *
 * Vite query suffixes (`?raw`, `?url`, `?worker`) are stripped: the underlying
 * file is still a build input. Returns null when nothing exists — the caller
 * decides what that means for its edge kind.
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

/** Pick a file path out of an `exports` value (string, or condition map). */
function exportTarget(value) {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  for (const condition of ["bun", "import", "node", "default", "require", "types"]) {
    const picked = exportTarget(value[condition]);
    if (picked) return picked;
  }
  return Object.values(value).map(exportTarget).find(Boolean) ?? null;
}

/** Map every workspace package name to its directory and `exports` map. */
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

/** The `exports` target for a subpath ("." or "./sub"), including `*` patterns. */
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
    // Node's subpath-pattern semantics: EVERY `*` in the target is replaced by
    // the matched portion (not a sanitization step — the value comes from a
    // checked-in package.json, and the result must resolve to a real file).
    if (target) return target.replaceAll("*", subpath.slice(prefix.length));
  }
  return null;
}

/** Node's own lookup: `node_modules/<name>` at the importer's dir, then each ancestor. */
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
 * node_modules dependency (an external leaf). Anything else refuses — with
 * Bun's isolated workspace layout the dependency usually sits in the importing
 * package's own `node_modules`, so the lookup walks up from the importer rather
 * than assuming a root-level install.
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
 * Statically walk the import graph from `entries`.
 *
 * `entries` are `{ file, baseDir }`; `baseDir` is where a leading `/` resolves
 * (the Vite root for the web entry: `apps/web`). Returns
 * `{ closure, looseRefs }`: a Map of absolute file path →
 * `{ entry, parent, baseDir }` so every hit can print its chain, plus the asset
 * references no file backs (runtime URLs) — reported, never silently dropped.
 *
 * Fail-closed rule for the walk: an unresolvable `module` specifier refuses
 * (a broken build must not read as "no edge"), while an unresolvable `asset`
 * reference is collected, because `<a href="/chat">` and API paths are
 * legitimate and fileless.
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

/** `entry → … → path` for a closure member, for an actionable failure line. */
export function importChain(file, closure, root) {
  const chain = [];
  for (let node = file; node; node = closure.get(node)?.parent) chain.unshift(node);
  return chain.map((abs) => relative(root, abs).split(sep).join("/"));
}

/**
 * Assert the deploy entry set this check knows still matches deploy.sh, so a
 * FIFTH production entry cannot appear unguarded. Cheap and textual on purpose:
 * parsing shell would be its own bug surface, while a count mismatch is exact.
 */
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

/**
 * A workflow outside `POLICED_WORKFLOW` must ignore docs-only patterns. The
 * refusal is the point: it is where #379's class, or any new class, gets a
 * decision instead of a silent hole in this check's coverage claim.
 */
export function assertUnpolicedWorkflows(root, unpoliced = UNPOLICED_WORKFLOWS) {
  for (const { file, reason } of unpoliced) {
    const abs = join(root, file);
    if (!existsSync(abs)) continue;
    const patterns = parsePathsIgnore(readFileSync(abs, "utf8"));
    const foreign = patterns.filter((pattern) => !DOCS_ONLY_PATTERNS.includes(pattern));
    if (foreign.length > 0) {
      throw new InvariantRefusal(
        `${file} carries a non-docs paths-ignore class (${foreign.join(", ")}) that this check ` +
          `does not police — recorded reason was "${reason}". Add its trigger set to ` +
          "POLICED_WORKFLOWS with its own artifact entries, or record why its invariant differs",
      );
    }
  }
}

/** The four deploy entries, with the Vite root a leading `/` resolves against. */
export function deployEntries() {
  return [
    { file: WEB_ENTRY, baseDir: dirname(WEB_ENTRY) },
    ...FILE_ENTRIES.map((file) => ({ file, baseDir: "." })),
  ];
}

/**
 * Verify the invariant against `root`. Returns the evidence the OK line prints;
 * throws InvariantRefusal for every "cannot verify" state and for any hit.
 */
export function verify(root = REPO_ROOT) {
  const workflowPath = join(root, POLICED_WORKFLOW);
  if (!existsSync(workflowPath)) {
    throw new InvariantRefusal(
      `${POLICED_WORKFLOW} not found under ${root} — this check polices that trigger set; ` +
        "refusing to pass without it",
    );
  }
  const patterns = parsePathsIgnore(readFileSync(workflowPath, "utf8"));
  const compiled = compilePatterns(patterns);
  assertUnpolicedWorkflows(root);

  const deployShPath = join(root, DEPLOY_SH);
  if (!existsSync(deployShPath)) {
    throw new InvariantRefusal(`${DEPLOY_SH} not found — cannot derive the deploy artifact set`);
  }
  assertDeployEntrySet(readFileSync(deployShPath, "utf8"));

  const entries = deployEntries();
  const { closure, looseRefs } = buildClosure(entries, root);
  const files = collectRepoFiles(root);
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
          `    reachable from deploy entry ${chain[0]}: ${chain.join(" → ")}`
        );
      })
      .join("\n");
    throw new InvariantRefusal(
      `${violations.length} path(s) matched by ${POLICED_WORKFLOW}'s paths-ignore are in the ` +
        `deploy import closure — a change to them skips the deploy while changing the artifact:\n${detail}`,
    );
  }
  return { patterns, matched, closure, entries, looseRefs };
}

function main() {
  const flag = process.argv.indexOf("--root");
  const root = flag === -1 ? REPO_ROOT : resolve(process.argv[flag + 1]);
  try {
    const { patterns, matched, closure, entries, looseRefs } = verify(root);
    console.log(
      `paths-ignore-invariant OK — ${POLICED_WORKFLOW} on.push.paths-ignore ` +
        `(${patterns.length} patterns, ${matched.length} matched paths) × static import closure of ` +
        `${entries.length} deploy entries (${closure.size} files): 0 matches`,
    );
    console.log(
      `  assets referenced but not files (runtime URLs, outside the graph): ${looseRefs.length}`,
    );
    const unpoliced = UNPOLICED_WORKFLOWS.map(({ file, reason }) => `${file} (${reason})`).join(
      "; ",
    );
    console.log(`  not policed, on purpose: ${unpoliced}`);
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
