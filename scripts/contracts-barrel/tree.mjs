import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { ContractsBarrelError } from "./errors.mjs";

/**
 * The module tree the gate judges — the walk, and only that.
 *
 * The universe is stated, not inherited from one extension: every TypeScript
 * module file under `packages/contracts/src`, which is every file whose name ends
 * in `.ts`, `.tsx`, `.mts` or `.cts` (declaration files end in one of the same
 * suffixes, and a declaration file that carries exports is a module a consumer
 * can import by name like any other). Test files are not part of the package's
 * surface and are the one exclusion. `.tsx` is in the set even though the package
 * has none today: a module that is outside the universe is a module nothing
 * judges, and that void is what a new file lands in.
 *
 * Resolution follows the same set in the spellings a barrel may write: the
 * extensionless specifier TypeScript resolves (`"./chat"` → `chat.ts`), the ESM
 * spelling that names the emit and not the source (`"./chat.js"` → `chat.ts`,
 * `"./chat.mjs"` → `chat.mts`, `"./chat.cjs"` → `chat.cts`), and the declaration
 * companions. A specifier that resolves to nothing is reported by the rules, not
 * guessed at here.
 */

export const SRC_DIR = "packages/contracts/src";
export const BARREL_FILE = `${SRC_DIR}/index.ts`;

/** The extensions that make a file a module this gate reads, in resolution order. */
export const MODULE_EXTENSIONS = [".ts", ".tsx", ".d.ts", ".mts", ".d.mts", ".cts", ".d.cts"];

/** The ESM spellings that name an emit, and the source extensions each resolves to. */
const EMIT_SPELLINGS = [
  [/\.js$/, [".ts", ".tsx", ".d.ts"]],
  [/\.mjs$/, [".mts", ".d.mts"]],
  [/\.cjs$/, [".cts", ".d.cts"]],
];

const TEST_FILE_RE = /\.test\.(m|c)?tsx?$/;

export const repoRelative = (root, path) => relative(root, path).split(sep).join("/");

/** Every module file of the package on disk, repo-relative and sorted. */
export function moduleFiles(root = process.cwd()) {
  const dir = join(root, SRC_DIR);
  const files = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (TEST_FILE_RE.test(name)) continue;
      if (MODULE_EXTENSIONS.some((extension) => name.endsWith(extension))) files.push(path);
    }
  };
  try {
    walk(dir);
  } catch {
    throw new ContractsBarrelError(
      `no ${SRC_DIR} under ${root}: there is no module tree for this gate to read`,
    );
  }
  return files
    .map((path) => repoRelative(root, path))
    .filter((file) => file !== BARREL_FILE)
    .sort();
}

/** One module's or the barrel's text, refused rather than read as empty when absent. */
export function readModuleFile(root, file) {
  try {
    return readFileSync(join(root, file), "utf8");
  } catch {
    throw new ContractsBarrelError(`no ${file} under ${root}: the gate cannot read what it checks`);
  }
}

/** The module a specifier names, repo-relative, or null when none in the tree does. */
export function resolveModule(modules, from, spec) {
  const base = dirname(from);
  const candidates = [spec];
  // An emit spelling names a file that is not in the tree: `./chat.js` is
  // `chat.ts` or `chat.tsx`, `./chat.mjs` is `chat.mts`, and each may have a
  // declaration sibling. A specifier may also name a directory, which resolves to
  // its `index` in the same order.
  let directory = spec;
  for (const [emit, replacements] of EMIT_SPELLINGS) {
    if (!emit.test(spec)) continue;
    directory = spec.replace(emit, "");
    for (const replacement of replacements) candidates.push(`${directory}${replacement}`);
  }
  for (const extension of MODULE_EXTENSIONS) {
    candidates.push(`${spec}${extension}`, `${spec}/index${extension}`);
  }
  for (const extension of MODULE_EXTENSIONS) {
    candidates.push(`${directory}${extension}`, `${directory}/index${extension}`);
  }
  for (const candidate of candidates) {
    const path = join(base, candidate).split(sep).join("/");
    if (modules.has(path)) return path;
  }
  return null;
}
