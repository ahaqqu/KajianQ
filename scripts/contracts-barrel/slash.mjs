/**
 * Reading a `/` — whether it opens a regular expression, divides, or cannot be
 * settled — and nothing else.
 *
 * Only the positions the language settles are decided: see `expressionSide`. A
 * position the text before it can be read both ways is refused by the caller, so
 * a shape this module does not know fails loudly instead of being read as code.
 */

/** The punctuator or word immediately before `at`, read off the blanked code. */
function previousToken(code, at) {
  let i = at - 1;
  while (i >= 0 && /\s/.test(code[i])) i -= 1;
  if (i < 0) return "";
  if (/[\w$]/.test(code[i])) {
    let start = i;
    while (start >= 0 && /[\w$]/.test(code[start])) start -= 1;
    return code.slice(start + 1, i + 1).join("");
  }
  const tail = code.slice(Math.max(0, i - 2), i + 1).join("");
  for (const operator of ["++", "--", "=>", "**", "&&", "||", "??", "+=", "-=", "*=", "/="]) {
    if (tail.endsWith(operator)) return operator;
  }
  return code[i];
}

/** Punctuators after which a `/` can only open a regular expression. */
const STARTS_EXPRESSION = new Set([
  "(",
  "[",
  "{",
  ",",
  ";",
  ":",
  "?",
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
  "/",
]);

/**
 * Reserved words after which a `/` opens a regular expression — the ones that
 * introduce an expression, `default` included (as in `export default /…/`). A
 * reserved word can still be a property name, so one led by `.` ends an
 * expression instead (`obj.return / 2`).
 */
const STARTS_EXPRESSION_KEYWORD = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "new",
  "delete",
  "void",
  "yield",
  "await",
  "case",
  "default",
  "do",
  "else",
  "throw",
]);

/**
 * Words that can be a keyword and an identifier, so a token cannot settle what a
 * `/` after one is: `of` in a `for…of` header opens an expression, `of` as a
 * variable divides. Refused rather than guessed — no scope analysis happens here.
 */
const AMBIGUOUS_WORDS = new Set(["of"]);

/** The keywords whose `)` closes a statement header, so a statement can follow it. */
const HEADER_KEYWORDS = new Set(["if", "while", "for", "with"]);

/** The index of the first character of the word that ends at `at`. */
function wordStart(code, at) {
  let start = at;
  while (start > 0 && /[\w$]/.test(code[start - 1])) start -= 1;
  return start;
}

/** Whether the `)` at `close` closes a statement header, `for await (…)` included. */
function headerBefore(code, close) {
  let depth = 0;
  for (let i = close; i >= 0; i -= 1) {
    if (code[i] === ")") depth += 1;
    else if (code[i] === "(") {
      depth -= 1;
      if (depth === 0) {
        let at = i - 1;
        while (at >= 0 && /\s/.test(code[at])) at -= 1;
        let keyword = previousToken(code, i);
        // `for await (…)`: the header keyword stands before the `await`.
        if (keyword === "await") keyword = previousToken(code, wordStart(code, at));
        return HEADER_KEYWORDS.has(keyword);
      }
    }
  }
  return false;
}

/**
 * What the text before `at` is: whether it certainly ends an expression (`ends`),
 * certainly starts one (`starts`), or can be read either way (`undecided`).
 *
 * Only positions the language settles are decided here. A literal, a `]`, `++`,
 * `--`, an identifier or a number end an expression; an operator, an opener, a
 * reserved word that introduces an expression, or a `)` that closes a header start
 * one; and a `/` after `!` is read through to whatever precedes the `!`. A
 * reserved word led by `.` is a property name and ends an expression. Everything
 * else — a `}` (a block end or an object literal), a soft keyword such as `of` (a
 * keyword or a variable), and the start of a file — is undecided, and the caller
 * refuses it rather than guessing.
 */
export function expressionSide({ code, literalEnds }, at) {
  let i = at - 1;
  while (i >= 0 && /\s/.test(code[i])) i -= 1;
  if (i < 0) return { side: "undecided", token: "" };
  if (literalEnds.has(i)) return { side: "ends", token: "<literal>" };
  if (/[\w$]/.test(code[i])) {
    const start = wordStart(code, i);
    const token = code.slice(start, i + 1).join("");
    if (AMBIGUOUS_WORDS.has(token)) return { side: "undecided", token };
    if (!STARTS_EXPRESSION_KEYWORD.has(token)) return { side: "ends", token };
    const lead = previousToken(code, start);
    return { side: lead === "." || lead === "?." ? "ends" : "starts", token };
  }
  const token = previousToken(code, at);
  if (token === "!") {
    // A `!` is read through to what precedes it: a non-null assertion keeps the
    // position's reading, a prefix `!` takes the one before it — and at the start
    // of a file there is an expression after it, never an assertion.
    const before = expressionSide({ code, literalEnds }, i);
    return before.token === "" ? { side: "starts", token: "!" } : { side: before.side, token: "!" };
  }
  if (token === ")") return { side: headerBefore(code, i) ? "starts" : "ends", token };
  if (STARTS_EXPRESSION.has(token)) return { side: "starts", token };
  if (token === "]" || token === "++" || token === "--") return { side: "ends", token };
  return { side: "undecided", token };
}

/** What a `/` at `at` is, as far as the position decides it. */
export function slashReading(context, at) {
  const { side, token } = expressionSide(context, at);
  if (side === "ends") return { kind: "division", token };
  if (side === "starts") return { kind: "regex", token };
  return { kind: "ambiguous", token };
}
