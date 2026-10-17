import { ContractsBarrelError } from "./errors.mjs";

/**
 * Reading a source the way the rules need it read — the lexing layer, and only
 * that.
 *
 * Three views of one file, because the rules need all three: `code`, with
 * comments blanked and string/template/regex literals intact (a module specifier
 * lives inside one); `directives`, with block comments and literals blanked but
 * line comments kept (a directive is a line comment); and `comments`, with
 * literals blanked and comments kept (where a directive that is not a line
 * comment still shows up, so it can be refused rather than silently dropped).
 * Newlines are never blanked, so every message can name the line it found.
 *
 * What the scan refuses, rather than reading past:
 *
 *   - a block comment that opens and never closes, and a template literal that
 *     never closes: their extent may swallow a real statement, and blanking to
 *     the end of the file is how a member disappears — the silence this gate
 *     exists to remove. A `"`/`'` literal is bounded to its own line, because a
 *     JS string cannot span one;
 *   - a `/` that can open a regular-expression literal and has no closing `/` on
 *     its line: whether a `/` is a regex or division turns on the token before
 *     it, and code after `=` can be either. That is refused rather than guessed,
 *     since a wrong guess shifts the scan's bracket count and a member below it
 *     goes missing;
 *   - a scan whose brackets do not balance by the end of the file, or that meets
 *     a closer nothing opened: a mis-read regex, string, template or comment is
 *     the way that happens, and an unbalanced count means the statement/nested
 *     split below cannot be trusted;
 *
 * A regular expression is the one construct here recognised by a heuristic: it
 * opens where the token before it cannot end an expression (`(`, `,`, `=`,
 * `return`, …) and divides otherwise. A regex in a position the heuristic calls
 * division is not valid JavaScript, so the guess errs only on code that does not
 * compile; and the two refusals above turn the erring direction into a message
 * instead of a missing member. A regex literal is never treated as quoted text,
 * so a pattern containing the word `export` is not mistaken for prose.
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
 * A regular expression's closing `/`, or -1 when none is on the same line. A `/`
 * inside a character class does not close it, and an escaped character (a `/`
 * included) is skipped, so `/[/]/` and `/\\//` end where they should.
 */
function regexEnd(source, from) {
  let inClass = false;
  for (let i = from + 1; i < source.length; i += 1) {
    const char = source[i];
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === "\n") return -1;
    if (inClass) {
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") {
      inClass = true;
      continue;
    }
    if (char === "/") return i + 1;
  }
  return -1;
}

/** The punctuator or word immediately before `at`, read off the blanked code. */
function previousToken(code, at) {
  let i = at - 1;
  while (i >= 0 && /\s/.test(code[i])) i -= 1;
  if (i < 0) return "";
  if (/[\w$]/.test(code[i])) {
    let start = i;
    while (start >= 0 && /[\w$]/.test(code[start])) start -= 1;
    return code.slice(start + 1, i + 1);
  }
  const tail = code.slice(Math.max(0, i - 2), i + 1);
  for (const operator of ["++", "--", "=>", "**", "&&", "||", "??", "+=", "-=", "*=", "/="]) {
    if (tail.endsWith(operator)) return operator;
  }
  return code[i];
}

/** A regex may open where the token before it cannot end an expression. */
const AFTER_EXPRESSION_START = new Set([
  "",
  "(",
  "[",
  "{",
  ",",
  ";",
  ":",
  "?",
  "!",
  "&",
  "|",
  "+",
  "-",
  "*",
  "%",
  "^",
  "~",
  "=",
  "<",
  ">",
  "=>",
  "&&",
  "||",
  "??",
  "+=",
  "-=",
  "*=",
  "/=",
  "**",
]);
const AFTER_EXPRESSION_KEYWORD = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "yield",
  "await",
  "case",
  "do",
  "else",
  "throw",
]);

const opensRegex = (code, at) => {
  const token = previousToken(code, at);
  return AFTER_EXPRESSION_START.has(token) || AFTER_EXPRESSION_KEYWORD.has(token);
};

/**
 * The three views of one source, plus where each literal sits. Throws — with the
 * file and line — on the constructs whose extent this scan cannot see.
 */
export function scanSource(source, file) {
  const code = source.split("");
  const directives = source.split("");
  const comments = source.split("");
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
      // `code` and `directives` lose a block comment (it is prose, and no
      // directive lives in one); `comments` keeps it, so a declaration written
      // inside one is visible to the refusal that names it as misplaced.
      blank(code, i, end + 2);
      blank(directives, i, end + 2);
      i = end + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const end = quotedEnd(source, i, char);
      literals.set(i, {
        start: i,
        end,
        kind: "string",
        closed: end > i + 1 && source[end - 1] === char,
      });
      blank(directives, i, end);
      blank(comments, i, end);
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
      literals.set(i, { start: i, end, kind: "template", closed: true });
      blank(directives, i, end);
      blank(comments, i, end);
      i = end;
      continue;
    }
    if (char === "/" && opensRegex(code.join(""), i)) {
      const end = regexEnd(source, i);
      if (end === -1) {
        throw new ContractsBarrelError(
          `${file}:${lineOf(source, i)}: a \`/\` here can open a regular-expression literal and ` +
            "this line has no closing `/`, so the scan cannot tell a regex from division — close " +
            "the regex on its line, or write the division so it cannot be read as one",
        );
      }
      literals.set(i, { start: i, end, kind: "regex", closed: true });
      blank(directives, i, end);
      blank(comments, i, end);
      i = end;
      continue;
    }
    i += 1;
  }
  return {
    code: code.join(""),
    directives: directives.join(""),
    comments: comments.join(""),
    literals,
  };
}
