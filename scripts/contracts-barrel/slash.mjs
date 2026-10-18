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

/** The index of the first character of the word that ends at `at`. */
function wordStart(code, at) {
  let start = at;
  while (start > 0 && /[\w$]/.test(code[start - 1])) start -= 1;
  return start;
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

/** The index of the `(` that matches the `)` at `close` on the blanked view, or -1. */
function matchingParen(syntax, close) {
  let depth = 0;
  for (let i = close; i >= 0; i -= 1) {
    if (syntax[i] === ")") depth += 1;
    else if (syntax[i] === "(") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Whether the token that starts at `start` is a property name, read off its lead. */
const isPropertyName = (code, start) => previousToken(code, start) === ".";

/**
 * What the `)` at `close` closes: a control header (whose `)` a statement can
 * follow), an ordinary call or grouping (which ends an expression), or something
 * the syntax cannot settle — each undecided answer naming its own reason.
 *
 * The parens are matched on the view with literals and comments blanked, so a
 * `"("` in a string cannot shift the match, and a reserved word led by `.` is a
 * property name — `g.if(…)` is a call, not a header. `for await (…)` is a `for`
 * header, read across the `await`.
 */
function parenKind({ syntax, code }, close) {
  const open = matchingParen(syntax, close);
  if (open === -1) return { kind: "undecided", why: "unmatched-paren" };
  let at = open - 1;
  while (at >= 0 && /\s/.test(code[at])) at -= 1;
  if (at < 0) return { kind: "ordinary" };
  let keyword = previousToken(code, open);
  let start = wordStart(code, at);
  if (keyword === "await") {
    if (isPropertyName(code, start)) return { kind: "ordinary" };
    let before = start - 1;
    while (before >= 0 && /\s/.test(code[before])) before -= 1;
    if (before < 0) return { kind: "undecided", why: "unread-header" };
    keyword = previousToken(code, start);
    start = wordStart(code, before);
  }
  if (keyword === "") return { kind: "undecided", why: "unread-header" };
  if (AMBIGUOUS_WORDS.has(keyword)) return { kind: "undecided", why: "soft-keyword" };
  if (isPropertyName(code, start)) return { kind: "ordinary" };
  return { kind: HEADER_KEYWORDS.has(keyword) ? "header" : "ordinary" };
}

/**
 * What the text before `at` is: whether it certainly ends an expression (`ends`),
 * certainly starts one (`starts`), or can be read either way (`undecided`, with
 * the reason named once, here).
 *
 * Only positions the language settles are decided: a literal, a `]`, `++`, `--`,
 * an identifier or a number end an expression; an operator, an opener, a reserved
 * word that introduces an expression, or a `)` that closes a header start one; a
 * `/` after `!` is read through to whatever precedes the `!`; and a reserved word
 * led by `.` is a property name that ends one. Everything else — a `}`, a soft
 * keyword, a `/` at the start of a file, a `)` whose `(` is not there — is
 * undecided, and the caller refuses it.
 */
function expressionSide({ code, syntax, literalEnds }, at) {
  let i = at - 1;
  while (i >= 0 && /\s/.test(code[i])) i -= 1;
  if (i < 0) return { side: "undecided", token: "", why: "no-predecessor" };
  if (literalEnds.has(i)) return { side: "ends", token: "<literal>" };
  if (/[\w$]/.test(code[i])) {
    const start = wordStart(code, i);
    const token = code.slice(start, i + 1).join("");
    if (AMBIGUOUS_WORDS.has(token)) return { side: "undecided", token, why: "soft-keyword" };
    if (!STARTS_EXPRESSION_KEYWORD.has(token)) return { side: "ends", token };
    return { side: isPropertyName(code, start) ? "ends" : "starts", token };
  }
  const token = previousToken(code, at);
  if (token === "!") {
    // A `!` is read through to what precedes it: a non-null assertion keeps the
    // position's reading, a prefix `!` takes the one before it — and at the start
    // of a file there is an expression after it, never an assertion.
    const before = expressionSide({ code, syntax, literalEnds }, i);
    return before.why === "no-predecessor"
      ? { side: "starts", token: "!" }
      : { side: before.side, token: "!", why: before.why };
  }
  if (token === ")") {
    const paren = parenKind({ syntax, code }, i);
    if (paren.kind === "header") return { side: "starts", token };
    if (paren.kind === "ordinary") return { side: "ends", token };
    return { side: "undecided", token, why: paren.why };
  }
  if (STARTS_EXPRESSION.has(token)) return { side: "starts", token };
  if (token === "]" || token === "++" || token === "--") return { side: "ends", token };
  if (token === "}") return { side: "undecided", token, why: "object-or-block" };
  return { side: "undecided", token, why: "unlisted-token" };
}

/** What a `/` at `at` is, as far as the position decides it. */
export function slashReading(context, at) {
  const { side, token, why } = expressionSide(context, at);
  if (side === "ends") return { kind: "division", token };
  if (side === "starts") return { kind: "regex", token };
  return { kind: "ambiguous", token, why };
}
