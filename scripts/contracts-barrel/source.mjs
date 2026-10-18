import { ContractsBarrelError } from "./errors.mjs";
import { slashReading } from "./slash.mjs";

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
 *     exists to remove. A `"`/`'` literal ends at its closing quote or at its own
 *     line's end, because a JS string holds no raw newline; a backslash escapes
 *     the character after it, a newline included, so a continued string spans
 *     lines;
 *   - a `/` whose position the language does not settle. The scan decides a `/`
 *     only where the text before it cannot mean the other thing: a literal, a
 *     `]`, `++`, `--`, an identifier or a number end an expression; an operator,
 *     an opener, a reserved word that introduces an expression, or a `)` that
 *     closes a header (`for await (…)` included) start one; a `!` is read
 *     through to whatever precedes it; and a reserved word led by `.` is a
 *     property name, so it ends one. The parens are matched on a view with
 *     literals and comments blanked, so a `"("` in a string cannot shift a match,
 *     and a `)` whose `(` is not there is refused rather than guessed. A `}` (a
 *     block end or an object literal), a soft keyword such as `of` (a keyword in
 *     a `for…of` header, a variable elsewhere), and the start of a file cannot be
 *     settled by a token, so they are refused with the line they are on. Guessing here is how a member goes
 *     silently missing: a regex read as division puts its pattern into the scan
 *     as code, where a `/*` in it opens a comment that blanks a real `export`
 *     below;
 *   - a `/` that opens a regex and has no closing `/` on its line: the literal's
 *     extent is unknown, so it is refused rather than closed somewhere below;
 *   - a scan whose brackets do not balance by the end of the file, or that meets
 *     a closer nothing opened: a mis-read regex, string, template or comment is
 *     the way that happens, and an unbalanced count means the statement/nested
 *     split below cannot be trusted.
 *
 * The claim is no stronger than the mechanism: this gate judges every module
 * whose `/` positions, literal extents and bracket matches the text settles, and
 * refuses a module it cannot settle — never reads past it. So a member cannot be
 * silently absent from a module the gate reads, and a module it refuses is judged
 * by no rule here: the edge a source scanner has and a parser would not. A regex
 * literal is never treated as quoted text, so a pattern containing the word
 * `export` is not mistaken for prose.
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

/**
 * A `"`/`'` literal's end: its closing quote, or its own line's end when it has
 * none. A JS string cannot hold a raw newline, but a backslash escapes the
 * character after it — a newline included — so a continued string spans lines.
 */
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

/** The sentence for each reason `slashReading` refuses for — one taxonomy, one place. */
const AMBIGUITY_REASONS = {
  "no-predecessor":
    "the file opens with it, where a statement that begins with a regular expression reads the " +
    "same as a division continuing an expression that is not there",
  "object-or-block": "`}` ends a block in one reading and an object literal in another",
  "soft-keyword": (token) =>
    `\`${token}\` is a keyword in one reading and an identifier in another`,
  "unmatched-paren": "the `)` before it closes a `(` this scan cannot find",
  "unread-header": "the `(` before it follows a keyword this scan cannot read",
  "unlisted-token": (token) =>
    `\`${token}\` is a token this scan does not place on either side of an expression`,
};

/** The refusal that names what the scan cannot tell apart, and where. */
function ambiguousSlash(source, file, at, reading) {
  const reason = AMBIGUITY_REASONS[reading.why] ?? AMBIGUITY_REASONS["unlisted-token"];
  const where = typeof reason === "function" ? reason(reading.token) : reason;
  return new ContractsBarrelError(
    `${file}:${lineOf(source, at)}: this \`/\` follows a position where ${where}, so this scan ` +
      "cannot tell a regular expression from division — write the division on the same line as its " +
      "left operand, or parenthesize it, so the line reads as code",
  );
}

/**
 * The three views of one source, plus where each literal sits. Throws — with the
 * file and line — on the constructs whose extent this scan cannot see.
 */
export function scanSource(source, file) {
  const code = source.split("");
  const directives = source.split("");
  const comments = source.split("");
  const syntax = source.split("");
  const literals = new Map();
  const literalEnds = new Set();
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
      blank(syntax, i, end);
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
      blank(syntax, i, end + 2);
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
      literalEnds.add(end - 1);
      blank(directives, i, end);
      blank(comments, i, end);
      blank(syntax, i, end);
      i = end;
      continue;
    }
    if (char === "`") {
      const end = templateEnd(source, i);
      if (end === -1) {
        throw new ContractsBarrelError(
          `${file}:${lineOf(source, i)}: a template literal opens here and this scan cannot find ` +
            "its closing backtick — an interpolation whose braces, quotes or regex it cannot follow, " +
            "or a template that never closes, both end here — write the interpolation so it reads as " +
            "code, or close the template",
        );
      }
      literals.set(i, { start: i, end, kind: "template", closed: true });
      literalEnds.add(end - 1);
      blank(directives, i, end);
      blank(comments, i, end);
      blank(syntax, i, end);
      i = end;
      continue;
    }
    if (char === "/") {
      const reading = slashReading({ code, syntax: syntax.join(""), literalEnds }, i);
      if (reading.kind === "ambiguous") throw ambiguousSlash(source, file, i, reading);
      if (reading.kind === "regex") {
        const end = regexEnd(source, i);
        if (end === -1) {
          throw new ContractsBarrelError(
            `${file}:${lineOf(source, i)}: this \`/\` opens a regular-expression literal and the ` +
              "line has no closing `/`, so the scan cannot tell where the regex ends — close it on " +
              "its line, or split the expression so the `/` is not read as a regex",
          );
        }
        literals.set(i, { start: i, end, kind: "regex", closed: true });
        literalEnds.add(end - 1);
        blank(directives, i, end);
        blank(comments, i, end);
        blank(syntax, i, end);
        i = end;
        continue;
      }
      // A division sign: plain code, and the scan reads on.
    }
    i += 1;
  }
  return {
    syntax: syntax.join(""),
    code: code.join(""),
    directives: directives.join(""),
    comments: comments.join(""),
    literals,
  };
}
