import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { ContractsBarrelError } from "./errors.mjs";

/**
 * The module tree the gate judges — the walk, and only that.
 *
 * The universe is stated, not inherited from one extension: every TypeScript
 * module file under `packages/contracts/src`, which is every file whose name ends
 * in `.ts`, `.tsx`, `.mts` or `.cts`. Test files are not part of the package's
 * surface and are the one exclusion, and the barrel is not a module the rules
 * judge — it is what they judge against. A module that is outside the universe is
 * a module nothing judges, and that void is what a new file lands in.
 */

export const SRC_DIR = "packages/contracts/src";
export const BARREL_FILE = `${SRC_DIR}/index.ts`;

/** The extensions that make a file a module this gate judges. */
export const MODULE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

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
