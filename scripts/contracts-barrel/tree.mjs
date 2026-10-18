import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { ContractsBarrelError } from "./errors.mjs";

/**
 * The module tree the gate judges — the walk, and only that.
 *
 * The universe is stated, not inherited from one extension: every TypeScript
 * module file under `packages/contracts/src`, which is every file whose name ends
 * in `.ts`, `.tsx` or `.mts` — the ESM surface the barrel can name. Test files and
 * declaration files are not part of the package's value surface, and the barrel is
 * not a module the rules judge: it is what they judge against.
 *
 * A `.cts` module is outside the universe: it is a CommonJS file inside a
 * `"type": "module"` package, so it is not part of the ESM surface the barrel
 * names, and walking it would redden every run on the synthetic `default` binding
 * the loader reports for the module object (the named keys do come through — it is
 * that extra `default` that makes the module's name set unusable). The exclusion is
 * a void: a barrel entry naming a `.cts` value is reported as unbound by the
 * "no module binds it" rule, by design, since nothing walks that file.
 */

export const SRC_DIR = "packages/contracts/src";
export const BARREL_FILE = `${SRC_DIR}/index.ts`;

/** The extensions that make a file a module this gate judges. */
export const MODULE_EXTENSIONS = [".ts", ".tsx", ".mts"];

const TEST_FILE_RE = /\.test\.(m|c)?tsx?$/;

/** A declaration file holds types and no runtime value, so the loader cannot judge it. */
const DECLARATION_FILE_RE = /\.d\.(m|c)?ts$/;

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
      if (TEST_FILE_RE.test(name) || DECLARATION_FILE_RE.test(name)) continue;
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
