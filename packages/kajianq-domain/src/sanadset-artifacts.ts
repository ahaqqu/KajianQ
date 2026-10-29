/**
 * Where the study's artifacts go and how they land.
 *
 * Three properties live here because they are properties of writing evidence:
 *
 * - **Outside the checkout.** The artifacts carry corpus text (matn excerpts, quarantined
 *   rows), so the writer refuses any directory that resolves inside a working tree of
 *   this repository, the main checkout and its linked worktrees alike. The default is the
 *   per-user cache; the refusal is what makes "a checkout cannot carry a corpus artifact"
 *   an invariant rather than a default.
 * - **Run-scoped.** Every file lands under `<outDir>/<runId>/`, and a directory that
 *   already carries a scored label sheet is refused rather than overwritten: the owner's
 *   labels are the only human evidence the blind sample exists to produce, and a rerun
 *   must never destroy them.
 * - **Injected environment.** The default paths come from an environment the caller
 *   supplies, so no library module reads `process.env` or the home directory on its own.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsvText } from "./sanadset-csv";

/** The default artifact directory, relative to the home directory. */
export const DEFAULT_ARTIFACT_DIR = join(".cache", "kajianq", "sanadset-pilot");

/** The default archive path, relative to the home directory. */
export const DEFAULT_CSV_DIR = join(".cache", "kajianq", "sanadset");
export const DEFAULT_CSV_NAME = "sanadset.csv";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** The checkout this module ships in, used when git cannot name the repository. */
const SHIPPED_CHECKOUT_ROOT = resolve(MODULE_DIR, "../../..");

/**
 * Every working tree of the repository containing `fromDir`: the main checkout and each
 * linked worktree. A write judged from a linked worktree has to see the main checkout
 * (and the reverse), which one module-relative path cannot.
 *
 * Falls back to the checkout this module ships in when git is absent or `fromDir` is not
 * a working tree; the guard then covers that tree alone.
 */
export function repositoryRoots(fromDir: string): string[] {
  try {
    const listed = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: fromDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const roots = listed
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => resolve(line.slice("worktree ".length)));
    if (roots.length > 0) return [...new Set(roots)];
  } catch {
    // Not a working tree, or git is not installed: the module-relative root is the floor.
  }
  return [SHIPPED_CHECKOUT_ROOT];
}

/** The working trees the writer refuses, resolved once from where the module ships. */
const GUARDED_ROOTS = repositoryRoots(MODULE_DIR).map((root) => realpathNearest(root));

export const REPORT_JSON = "report.json";
export const REPORT_MARKDOWN = "report.md";
export const QUARANTINE_JSON = "quarantine.json";
export const SAMPLE_JSON = "sample-300.json";
export const LABELS_CSV = "labels-template.csv";
export const SPOT_CHECK_CSV = "owner-spotcheck-50.csv";
export const PREDICTIONS_JSON = "sample-predictions.json";

/** The environment the study's default paths are resolved from. */
export type StudyEnvironment = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
};

/** A directory the study refuses to write into, with the reason a reader needs. */
export class StudyArtifactDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StudyArtifactDirError";
  }
}

/** The archive path: `SANADSET_CSV`, else the per-user cache. */
export function defaultCsvPath(environment: StudyEnvironment): string {
  const override = environment.env["SANADSET_CSV"];
  if (override !== undefined && override.trim().length > 0) return override.trim();
  return join(environment.homeDir, DEFAULT_CSV_DIR, DEFAULT_CSV_NAME);
}

/** Resolve the artifact directory: `SANADSET_STUDY_DIR`, else the per-user cache. */
export function resolveOutDir(environment: StudyEnvironment): string {
  const override = environment.env["SANADSET_STUDY_DIR"];
  const dir =
    override !== undefined && override.trim().length > 0
      ? override.trim()
      : join(environment.homeDir, DEFAULT_ARTIFACT_DIR);
  assertOutsideRepository(dir);
  return dir;
}

/** Resolve `path` through the nearest existing ancestor, so a missing tail cannot hide a symlink. */
function realpathNearest(path: string): string {
  const tail: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(current), ...[...tail].reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      tail.push(basename(current));
      current = parent;
    }
  }
}

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

/** Which working tree the guard judges a write from; defaults to this module's checkout. */
export type RepositoryGuard = {
  readonly from?: string;
};

/**
 * Refuse a directory that resolves inside a working tree of this repository — the main
 * checkout or any linked worktree. Symlinks are resolved first: a link in `/tmp` that
 * points into a checkout is inside the checkout.
 */
export function assertOutsideRepository(dir: string, guard: RepositoryGuard = {}): void {
  const resolved = realpathNearest(dir);
  const repository = (
    guard.from === undefined
      ? GUARDED_ROOTS
      : repositoryRoots(guard.from).map((root) => realpathNearest(root))
  ).find((root) => isInside(resolved, root));
  if (repository !== undefined) {
    throw new StudyArtifactDirError(
      `artifact directory ${dir} resolves inside the repository (${repository}); ` +
        "the study writes corpus text, so it writes only outside the checkout",
    );
  }
}

/**
 * Refuse to run into a directory whose label sheets already carry scores. The owner's
 * labels are evidence: a rerun writes to a fresh directory instead of replacing them.
 */
export function assertArtifactDirWritable(dir: string): void {
  for (const name of [LABELS_CSV, SPOT_CHECK_CSV] as const) {
    const path = join(dir, name);
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    const rows = parseCsvText(readFileSync(path, "utf8"));
    const scored = rows.slice(1).some((row) => (row[4] ?? "").trim().length > 0);
    if (scored) {
      throw new StudyArtifactDirError(
        `refusing to overwrite ${path}: it already carries scored labels. ` +
          "The labels are the study's evidence — pass a fresh --out directory (or unset SANADSET_STUDY_DIR).",
      );
    }
  }
}

export type ArtifactFile = { readonly name: string; readonly content: string };

/**
 * Write every artifact into `dir` (created if absent) and return the paths in write order.
 * The repository refusal is repeated here because this is the function that writes.
 */
export function writeArtifactFiles(dir: string, files: readonly ArtifactFile[]): string[] {
  assertOutsideRepository(dir);
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const file of files) {
    const path = join(dir, file.name);
    writeFileSync(path, file.content, "utf8");
    written.push(path);
  }
  return written;
}

/** JSON on disk is pretty-printed and newline-terminated: it is evidence, read by humans too. */
export function jsonFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
