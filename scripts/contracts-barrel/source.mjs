import { ContractsBarrelError } from "./errors.mjs";

/**
 * Reading a source the way the rules need it read — the lexing layer, and only
 * that.
 *
 * Two views of one file, because the rules need both: `code`, with comments
 * blanked and string/template literals intact (a module specifier lives inside
 * one), and `directives`, with block comments and literals blanked but line
 * comments kept (a directive is a line comment, and one that only appears inside
 * a block comment or a literal is not a directive a reader would find). Newlines
 * are never blanked, so every message can name the line it found.
 *
 * What the scan refuses, rather than reading past:
 *
 *   - a block comment that opens and never closes: its closing delimiter may be
 *     the only thing that would end it, so everything below is either code or
 *     prose and this scan cannot tell which. Blanking to the end of the file is
 *     how a real `export` disappears — the silence this gate exists to remove;
 *   - a template literal that opens and never closes, for the same reason. A
 *     template spans lines by design, so unlike `"` and `'` it has no
 *     end-of-line fallback;
 *   - an `export` keyword inside a literal (see `classifyExports`): a module
 *     publishes no member by quoting one, so it is either quoted prose or a
 *     statement the scan mistook for a literal, and both are reported rather
 *     than passed over silently.
 *
 * A regex literal is the one construct this layer does not know: a `/` opens one
 * only where the language needs a value, and without that rule a regex holding a
 * quote or a `//` reads as a literal or a comment. Every such mis-reading is
 * bounded to the line it starts on for `"` and `'`, and a backtick or `/*` that
 * swallows a real statement puts that statement's `export` inside a literal —
 * which `classifyExports` reports with the file and line instead of skipping.
 */

export const lineOf = (source, offset) => source.slice(0, offset).split("\n").length;

export const skipSpace = (code, from) => {
  let i = from;
  while (i < code.length && /\s/.test(code[i])) i += 1;
  return i;
};

const lineEnd = (source, from) => {
  const end = source.indexOf("\n", from);
  return end === -1 ? source.length : end;
};

/** A `"`/`'` literal ends at its own line: a JS string cannot span one. */
function quotedEnd(source, from, quote) {
  for (let i = from + 1; i < source.length; i += 1) {
    if (source[i] === "\\") i += 1;
    else if (source[i] === quote) return i + 1;
    else if (source[i] === "\n") return i;
  }
  return source.length;
}

/**
 * A template literal's closing backtick, or -1 when the file has none. The body
 * spans lines, so `\n` is not an end; `${…}` is scanned as code, where a nested
 * template, a string or a comment is recognised, and its braces are counted so a
 * `}` closing an object inside the interpolation does not end it early.
 */
function templateEnd(source, from) {
  const interpolation = [];
  let i = from + 1;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (interpolation.length > 0) {
      const depth = interpolation.length - 1;
      if (char === "/" && next === "/") {
        i = lineEnd(source, i);
        continue;
      }
      if (char === "/" && next === "*") {
        const end = source.indexOf("*/", i + 2);
        if (end === -1) return -1;
        i = end + 2;
        continue;
      }
      if (char === '"' || char === "'") {
        i = quotedEnd(source, i, char);
        continue;
      }
      if (char === "`") {
        const end = templateEnd(source, i);
        if (end === -1) return -1;
        i = end;
        continue;
      }
      if (char === "{") interpolation[depth] += 1;
      else if (char === "}") {
        interpolation[depth] -= 1;
        if (interpolation[depth] === 0) interpolation.pop();
      }
      i += 1;
      continue;
    }
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (char === "`") return i + 1;
    if (char === "$" && next === "{") {
      interpolation.push(1);
      i += 2;
      continue;
    }
    i += 1;
  }
  return -1;
}

/**
 * The two views of one source, plus where each literal sits. Throws — with the
 * file and line — on the two constructs whose extent this scan cannot see.
 */
export function scanSource(source, file) {
  const code = source.split("");
  const directives = source.split("");
  const literals = new Map();
  const blank = (view, from, to) => {
    for (let i = from; i < to; i += 1) if (view[i] !== "\n") view[i] = " ";
  };
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (char === "/" && next === "/") {
      // A line comment is prose for the statement reader and the home of a
      // directive, so only `code` loses it.
      const end = lineEnd(source, i);
      blank(code, i, end);
      i = end;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) {
        throw new ContractsBarrelError(
          `${file}:${lineOf(source, i)}: a block comment opens here and never closes, so this ` +
            "gate cannot tell what is code below it — close it, and an `export` it was swallowing " +
            "becomes a statement the scan reads",
        );
      }
      blank(code, i, end + 2);
      blank(directives, i, end + 2);
      i = end + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const end = quotedEnd(source, i, char);
      literals.set(i, { start: i, end, closed: end > i + 1 && source[end - 1] === char });
      blank(directives, i, end);
      i = end;
      continue;
    }
    if (char === "`") {
      const end = templateEnd(source, i);
      if (end === -1) {
        throw new ContractsBarrelError(
          `${file}:${lineOf(source, i)}: a template literal opens here and never closes, so this ` +
            "gate cannot tell what is code below it — close it, and an `export` it was swallowing " +
            "becomes a statement the scan reads",
        );
      }
      literals.set(i, { start: i, end, closed: true });
      blank(directives, i, end);
      i = end;
      continue;
    }
    i += 1;
  }
  return { code: code.join(""), directives: directives.join(""), literals };
}

const EXPORT = "export";

const startsKeyword = (code, i, keyword) =>
  code.startsWith(keyword, i) &&
  !/[\w$.]/.test(code[i - 1] ?? "") &&
  !/[\w$]/.test(code[i + keyword.length] ?? "");

/**
 * Every `export` keyword in the file, split by what it can be: a `statement` to
 * read, a `nested` one inside a block (a namespace member, an object's or a type
 * literal's property — never a module export), or `quoted` text inside a literal.
 * Enumerating all three is what keeps "not a statement" from becoming "not
 * looked at": each keyword lands in exactly one list.
 */
export function classifyExports({ code, literals }) {
  const statements = [];
  const nested = [];
  const quoted = [];
  let depth = 0;
  let i = 0;
  while (i < code.length) {
    const literal = literals.get(i);
    if (literal !== undefined) {
      for (const match of code.slice(literal.start, literal.end).matchAll(/\bexport\b/g)) {
        quoted.push(literal.start + match.index);
      }
      i = literal.end;
      continue;
    }
    const char = code[i];
    if (char === "{" || char === "(" || char === "[") depth += 1;
    else if (char === "}" || char === ")" || char === "]") depth = Math.max(0, depth - 1);
    else if (startsKeyword(code, i, EXPORT)) {
      if (depth > 0) nested.push(i);
      else statements.push(i);
      i += EXPORT.length;
      continue;
    }
    i += 1;
  }
  return { statements, nested, quoted };
}
