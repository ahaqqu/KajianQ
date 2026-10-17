import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

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

const escapeRe = (char) => char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * One glob as one RegExp: a double star spans zero or more segments, a single star
 * stays within one segment, `{a,b}` is either. Only the shapes a test include uses
 * are understood;
 * anything else matches literally, so an exotic glob collects nothing loudly
 * instead of collecting the wrong files quietly.
 */
export function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
      continue;
    }
    if (char === "*") {
      out += "[^/]*";
      continue;
    }
    if (char === "{") {
      const end = glob.indexOf("}", i);
      if (end !== -1) {
        const alternatives = glob
          .slice(i + 1, end)
          .split(",")
          .map(escapeRe);
        out += `(?:${alternatives.join("|")})`;
        i = end;
        continue;
      }
    }
    out += escapeRe(char);
  }
  return new RegExp(`^${out}$`);
}

/**
 * The `test.include` globs of a config source, or null when there are none. The
 * `test:` object's own first `include:` is the one: the coverage block carries a
 * second, deeper `include:`, and reading that one yields a different universe
 * without a word. The array is read element by element up to its closing bracket,
 * so a glob holding a bracket — a character class — does not end it early.
 */
export function includeGlobs(configSource) {
  const open = /^([ \t]*)test:\s*\{[\s\S]*?\n\1([ \t]+)include:\s*\[/m.exec(configSource);
  if (open === null) return null;
  const globs = [];
  let i = open.index + open[0].length;
  while (i < configSource.length) {
    const char = configSource[i];
    const next = configSource[i + 1];
    if (char === "/" && next === "/") {
      i = lineEnd(configSource, i);
      continue;
    }
    if (char === "/" && next === "*") {
      const end = configSource.indexOf("*/", i + 2);
      i = end === -1 ? configSource.length : end + 2;
      continue;
    }
    if (char === "]") break;
    if (char === '"' || char === "'") {
      const end = quotedEnd(configSource, i, char);
      globs.push(configSource.slice(i + 1, end - 1));
      i = end;
      continue;
    }
    i += 1;
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
  const matchers = globs.map(globToRegExp);
  const files = [];
  for (const tree of globRoots(globs)) {
    const dir = join(root, tree);
    if (existsSync(dir)) walk(dir, files);
  }
  return files
    .map((path) => repoRelative(root, path))
    .filter((file) => matchers.some((matcher) => matcher.test(file)))
    .sort();
}

/**
 * A changed-file list as the driver reads it: a NUL-separated list when the text
 * carries NUL (what `git diff --name-only -z` writes, unquoted whatever the path
 * holds), otherwise one path per line.
 */
export const splitPathList = (text) =>
  text.split(text.includes("\0") ? "\0" : "\n").filter((path) => path.length > 0);

/** After which characters a `/` opens a regex literal rather than dividing. */
const REGEX_PRECEDES = new Set("(,=:[!&|?{};+-*%~^<>".split(""));

const lineEnd = (source, from) => {
  const end = source.indexOf("\n", from);
  return end === -1 ? source.length : end;
};

function quotedEnd(source, from, quote) {
  for (let i = from + 1; i < source.length; i += 1) {
    if (source[i] === "\\") i += 1;
    else if (source[i] === quote) return i + 1;
    else if (source[i] === "\n") return i;
  }
  return source.length;
}

function regexEnd(source, from) {
  let inClass = false;
  for (let i = from + 1; i < source.length; i += 1) {
    const char = source[i];
    if (char === "\\") i += 1;
    else if (char === "\n") return i;
    else if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) return i + 1;
  }
  return source.length;
}

/**
 * A source file's code with comments and string bodies blanked, offsets and
 * newlines kept. A scan that cannot tell a comment from a string either invents a
 * read or misses one — and missing one is the direction that leaves a suite in no
 * job at all — so strings and regex literals are recognised before comments, and
 * every scan but a template literal stops at the end of its line. A misfire can
 * then blank no more than the line it started on, and a template's `${…}` is
 * scanned as code, where a read is a read.
 */
export function codeOnly(source) {
  const out = source.split("");
  const blank = (from, to) => {
    for (let i = from; i < to; i += 1) if (out[i] !== "\n") out[i] = " ";
  };
  const interpolationDepths = [];
  let inTemplate = false;
  let previous = "";
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (inTemplate) {
      if (char === "\\") {
        blank(i, i + 2);
        i += 2;
        continue;
      }
      if (char === "`") {
        blank(i, i + 1);
        inTemplate = false;
        previous = "`";
        i += 1;
        continue;
      }
      if (char === "$" && next === "{") {
        inTemplate = false;
        interpolationDepths.push(0);
        i += 2;
        continue;
      }
      blank(i, i + 1);
      i += 1;
      continue;
    }
    const depth = interpolationDepths.length;
    if (char === "}" && depth > 0 && interpolationDepths[depth - 1] === 0) {
      interpolationDepths.pop();
      inTemplate = true;
      i += 1;
      continue;
    }
    if (depth > 0 && char === "{") interpolationDepths[depth - 1] += 1;
    else if (depth > 0 && char === "}") interpolationDepths[depth - 1] -= 1;
    if (char === "/" && next === "/") {
      const end = lineEnd(source, i);
      blank(i, end);
      i = end;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (char === '"' || char === "'") {
      const end = quotedEnd(source, i, char);
      // A literal whose whole content is a bare env-var name is that name rather
      // than prose: it is the subscript spelling of the read, so it stays visible.
      const closed = end > i + 1 && source[end - 1] === char;
      if (!(closed && source.slice(i + 1, end - 1) === "DATABASE_URL")) blank(i, end);
      previous = char;
      i = end;
      continue;
    }
    if (char === "`") {
      inTemplate = true;
      blank(i, i + 1);
      i += 1;
      continue;
    }
    if (char === "/" && (previous === "" || REGEX_PRECEDES.has(previous))) {
      const end = regexEnd(source, i);
      blank(i, end);
      i = end;
      continue;
    }
    if (!/\s/.test(char)) previous = char;
    i += 1;
  }
  return out.join("");
}
