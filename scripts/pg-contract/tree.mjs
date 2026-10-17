import { existsSync, readdirSync, statSync } from "node:fs";
import { join, matchesGlob, relative, sep } from "node:path";

import { skipLiteral } from "./source.mjs";

/**
 * What the test runner collects, read from the runner's own configuration, plus
 * the two source transformations the gate's rules are stated in terms of.
 *
 * The include globs are never a second copy kept here: `vitest.config.ts` is
 * parsed for the `test:` block's own `include:` array, that array is compiled to
 * one matcher, and the walk is rooted at the globs' first segment. A config this
 * module cannot read comes back `null` rather than as a smaller universe — a walk
 * that quietly reads the coverage block's `include:` and finds different files is
 * the failure this shape exists to make impossible.
 */

/** A repo-relative path with forward slashes, whichever platform walked it. */
export const repoRelative = (root, path) => relative(root, path).split(sep).join("/");

/** The first segment of every glob: the trees the walk has to enter. */
export const globRoots = (globs) => [...new Set(globs.map((glob) => glob.split("/")[0]))].sort();

/**
 * A glob as the patterns the platform's matcher takes: `{a,b}` is either one, and the
 * rest is left to `node:path`'s own glob matcher rather than to a pattern this module
 * compiles itself — a regex built from a glob is a pattern the gate would have to trust
 * twice, and the platform's semantics (`**` across segments, `*` within one) are the ones
 * the runner collects by. The runtime is the one the workflows pin through `setup-bun`.
 */
export function expandBraces(glob) {
  const open = glob.indexOf("{");
  const close = open === -1 ? -1 : glob.indexOf("}", open);
  if (close === -1) return [glob];
  const before = glob.slice(0, open);
  const after = glob.slice(close + 1);
  return glob
    .slice(open + 1, close)
    .split(",")
    .flatMap((alternative) => expandBraces(before + alternative + after));
}

/** Whether the runner's globs collect this repo-relative path. */
export const collectsFile = (globs, file) =>
  globs.some((glob) => expandBraces(glob).some((pattern) => matchesGlob(file, pattern)));

/**
 * The `test.include` globs of a config source, or null when the object has none.
 *
 * The globs are the object's own direct children: the scan tracks nesting from the
 * `test:` brace, so the coverage block's deeper `include:` — which sits after it and
 * would otherwise be read the moment the key is renamed — is not one of them. Strings,
 * comments and regexes are stepped over, so a glob holding a brace or a bracket does
 * not end the scan early and a comment that mentions one does not start a glob.
 */
export function includeGlobs(configSource) {
  const open = /^[ \t]*test:\s*\{/m.exec(configSource);
  if (open === null) return null;
  const include = /^include\s*:\s*\[/;
  let depth = 1;
  for (let i = open.index + open[0].length; i < configSource.length; i += 1) {
    const char = configSource[i];
    const skipped = skipLiteral(configSource, i);
    if (skipped !== null) {
      i = skipped;
      continue;
    }
    if (char === "{" || char === "[" || char === "(") depth += 1;
    else if (char === "}" || char === "]" || char === ")") {
      depth -= 1;
      if (depth === 0) return null;
    } else if (depth === 1) {
      const match = include.exec(configSource.slice(i, i + 16));
      if (match !== null) return globElements(configSource, i + match[0].length - 1);
    }
  }
  return null;
}

/**
 * The string literals inside the array that opens at `from`, where a scan that has just
 * read the `include:` key stands. Null when the array holds none.
 */
function globElements(source, from) {
  const globs = [];
  let depth = 0;
  for (let i = from; i < source.length; i += 1) {
    const char = source[i];
    const skipped = skipLiteral(source, i);
    if (skipped !== null) {
      if (depth === 1 && (char === '"' || char === "'")) globs.push(source.slice(i + 1, skipped));
      i = skipped;
      continue;
    }
    if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return globs.length > 0 ? globs : null;
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

/** Every file the globs collect under `root`, repo-relative and sorted. */
export function collectedTestFiles(root, globs) {
  const files = [];
  for (const tree of globRoots(globs)) {
    const dir = join(root, tree);
    if (existsSync(dir)) walk(dir, files);
  }
  return files
    .map((path) => repoRelative(root, path))
    .filter((file) => collectsFile(globs, file))
    .sort();
}

/**
 * A changed-file list as the driver reads it: a NUL-separated list when the text
 * carries NUL (what `git diff --name-only -z` writes, unquoted whatever the path
 * holds), otherwise one path per line.
 */
export const splitPathList = (text) =>
  text.split(text.includes("\0") ? "\0" : "\n").filter((path) => path.length > 0);
