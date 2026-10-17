import { ContractsBarrelError } from "./errors.mjs";
import { lineOf } from "./source.mjs";

/**
 * Deciding what each `export` keyword is — the classification layer, and only
 * that.
 *
 * The scanner says where the literals and comments are; this layer says which of
 * the `export` keywords it can see publishes into the module, which sits inside a
 * block, and which is quoted text, and refuses the two readings that would
 * otherwise go quiet: a scan whose brackets do not balance (so the statement /
 * nested split below it cannot be trusted) and an `export` keyword inside a
 * string or template literal (a module publishes no member by quoting one).
 */

/** Whether the `{` at `at` opens a `namespace`/`module` body, the one block that may hold an export. */
const opensDeclarationBody = (code, at) =>
  /\b(?:namespace|module)\s+(?:[\w$]+|"[^"]*"|'[^']*')\s*$/.test(
    code.slice(Math.max(0, at - 80), at),
  );

/**
 * Every `export` keyword in the file, split by what it can be: a `statement` to
 * read, a `nested` one inside a block, or `quoted` text inside a string or
 * template. Enumerating all three is what keeps "not a statement" from becoming
 * "not looked at": each keyword lands in exactly one list, and a nested one says
 * whether the block it sits in is a `namespace`/`module` body — the only
 * construct in which an export keyword is legal off the statement position.
 *
 * The walk also reports the bracket accounting it used, because depth is what
 * decides statement from nested: `open` is every opener still unclosed at the end
 * of the file, and `stray` is the first closer that opened nothing. Either one
 * means the split cannot be trusted, and the caller refuses.
 */
export function classifyExports({ code, literals }) {
  const statements = [];
  const nested = [];
  const quoted = [];
  const stack = [];
  let stray = null;
  let i = 0;
  while (i < code.length) {
    const literal = literals.get(i);
    if (literal !== undefined) {
      if (literal.kind !== "regex") {
        for (const match of code.slice(literal.start, literal.end).matchAll(/\bexport\b/g)) {
          quoted.push(literal.start + match.index);
        }
      }
      i = literal.end;
      continue;
    }
    const char = code[i];
    if (char === "{" || char === "(" || char === "[") {
      stack.push({ at: i, declaration: char === "{" && opensDeclarationBody(code, i) });
    } else if (char === "}" || char === ")" || char === "]") {
      if (stack.length === 0) {
        if (stray === null) stray = i;
      } else {
        stack.pop();
      }
    } else if (
      code.startsWith("export", i) &&
      !/[\w$.]/.test(code[i - 1] ?? "") &&
      !/[\w$]/.test(code[i + 6] ?? "")
    ) {
      if (stack.length === 0) statements.push(i);
      else nested.push({ at: i, declaration: stack.some((frame) => frame.declaration) });
      i += "export".length;
      continue;
    }
    i += 1;
  }
  return { statements, nested, quoted, open: stack.map((frame) => frame.at), stray };
}

/**
 * A bracket the scan never closed, or one it closed with nothing open, means the
 * statement/nested split below it cannot be trusted: a mis-read regex, string,
 * template or comment is the way that happens. Refused with the line it started
 * on rather than judged.
 */
export function requireBalanced(scanned, classified, file) {
  if (classified.stray !== null) {
    throw new ContractsBarrelError(
      `${file}:${lineOf(scanned.code, classified.stray)}: a \`}\`/\`)\`/\`]\` closes nothing the ` +
        "scan opened, so a literal or comment above it was mis-read and the statements below " +
        "cannot be judged",
    );
  }
  if (classified.open.length === 0) return;
  const first = classified.open[0];
  throw new ContractsBarrelError(
    `${file}:${lineOf(scanned.code, first)}: a \`{\`/\`(\`/\`[\` opened here is still unclosed at ` +
      `the end of the file (${classified.open.length} left open), so a literal or comment mis-read ` +
      "above it may be hiding a statement — close it, or write the construct so it reads as code",
  );
}

/**
 * An `export` keyword the scan read as quoted text. A module publishes no member
 * by quoting one, so this is either prose this gate will not read or a statement
 * the scan mistook for a literal — and the second is the silence the gate exists
 * to remove, whatever the first costs.
 */
export function requireNoQuotedExports({ code }, quoted, file) {
  if (quoted.length === 0) return;
  const lines = quoted.map((at) => lineOf(code, at));
  throw new ContractsBarrelError(
    `${file}: the word \`export\` sits inside a string or template literal at line ` +
      `${lines.join(", ")}: a module publishes no member that way, so this is either quoted ` +
      "prose this gate will not read or a statement the scan mistook for a literal — reword the " +
      "literal, since a statement the scan reads past is the silence this gate exists to remove",
  );
}
