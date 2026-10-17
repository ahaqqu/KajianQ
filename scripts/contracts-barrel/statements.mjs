import { ContractsBarrelError } from "./errors.mjs";
import { classifyExports, lineOf, scanSource, skipSpace } from "./source.mjs";

/**
 * Reading one export statement — the statement grammar, and only that.
 *
 * The statements a module and the barrel write are the same language, so one
 * reader serves both: `exportStatement` turns the keyword at an offset into the
 * members it publishes and the re-export edges it carries, and `importBindings`
 * supplies the other half of `export { x }` for a name imported from elsewhere
 * (which is the re-export edge it is, not a member with no origin).
 *
 * A shape this reader cannot read is refused with the file and line rather than
 * guessed at. The shapes it *can* read include the ones whose meaning is not in
 * doubt but whose text is unusual: a `function*` generator, a `const enum`, a
 * `namespace`, an export list written across lines with a `type` element in it,
 * and an `export` inside a namespace body or an object literal — which publishes
 * into that namespace or object, and no consumer can import it from this package
 * by name.
 */

const IDENT = "[A-Za-z_$][\\w$]*";
const NAMED_RE = new RegExp(`^(${IDENT})`);
const DECLARATOR_RE = new RegExp(`^\\s*${IDENT}\\s*[:=]`);
const KEYWORD_RE = new RegExp(
  "^(?:declare\\s+)?(?:(?:abstract|async)\\s+)?" +
    "(const\\s+enum|const|let|var|function|class|enum|interface|type|namespace|module)\\b",
);

const failAt = (file, source, at, what) => {
  throw new ContractsBarrelError(
    `${file}:${lineOf(source, at)}: ${what} — the statement reads \`${source
      .slice(at, skipSpace(source, at + 60))
      .trim()}\``,
  );
};

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

/** The `from "./module"` clause that opens at `from`, read as the literal it is. */
function moduleSpecifier({ code, literals }, from, fail) {
  const at = skipSpace(code, from);
  const match = /^from\b/.exec(code.slice(at));
  if (match === null) fail("a re-export with no `from` clause");
  const quote = skipSpace(code, at + match[0].length);
  const char = code[quote];
  if (char !== '"' && char !== "'" && char !== "`") {
    fail("a `from` clause that names no string literal");
  }
  const literal = literals.get(quote);
  if (literal === undefined || !literal.closed) {
    fail("a module specifier that is not a closed string literal");
  }
  return code.slice(quote + 1, literal.end - 1);
}

/** One `provided [as exported]` element, with the `type` modifier it carries. */
function parseElement(raw, fail) {
  const text = raw.replace(/\s+/g, " ").trim();
  const typeOnly = /^type\s/.test(text);
  const match = new RegExp(`^(${IDENT})(?:\\s+as\\s+(${IDENT}))?$`).exec(
    text.replace(/^type\s+/, ""),
  );
  if (match === null) fail(`an export list element this scan cannot read (\`${text}\`)`);
  return { provided: match[1], exported: match[2] ?? match[1], typeOnly };
}

/** The elements of the brace list opening at `open`, and where the list ends. */
function readBraceList(code, open, fail) {
  let depth = 0;
  let close = -1;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === "{") depth += 1;
    else if (code[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) fail("an export list that never closes");
  const elements = [];
  let depthInElement = 0;
  let current = "";
  for (const char of code.slice(open + 1, close)) {
    if (char === "(" || char === "[" || char === "{") depthInElement += 1;
    else if (char === ")" || char === "]" || char === "}") depthInElement -= 1;
    if (char === "," && depthInElement === 0) {
      elements.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  elements.push(current);
  return {
    // A trailing comma before `}` is an empty element, not a name.
    elements: elements.filter((raw) => raw.trim() !== "").map((raw) => parseElement(raw, fail)),
    close,
  };
}

/** The `;` that ends the declaration opening at `from`, at its own nesting level. */
function declarationEnd({ code, literals }, from, fail) {
  let depth = 0;
  for (let i = from; i < code.length; i += 1) {
    const literal = literals.get(i);
    if (literal !== undefined) {
      i = literal.end - 1;
      continue;
    }
    const char = code[i];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === ";" && depth === 0) return i;
  }
  return fail("a declaration with no `;` at its end");
}

/**
 * The names a `const`/`let`/`var` declaration binds, one per declarator. A
 * declarator boundary is a top-level comma whose tail is a binding (`name:` or
 * `name=`), so the comma inside `Record<string, number>` or `f(a, b)` is not one
 * — a mis-split would invent a member, and an invented member reddens on
 * innocent code.
 */
function readDeclarators(source, from, fail) {
  const { code, literals } = source;
  const end = declarationEnd(source, from, fail);
  const segments = [""];
  let depth = 0;
  for (let i = from; i < end; i += 1) {
    const literal = literals.get(i);
    if (literal !== undefined) {
      const stop = Math.min(literal.end, end);
      segments[segments.length - 1] += code.slice(i, stop);
      i = stop - 1;
      continue;
    }
    const char = code[i];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    if (char === "," && depth === 0 && DECLARATOR_RE.test(code.slice(i + 1, end))) {
      segments.push("");
      continue;
    }
    segments[segments.length - 1] += char;
  }
  return segments.map((segment) => {
    const named = NAMED_RE.exec(segment.trimStart());
    if (named === null) {
      fail(
        `a declarator this scan cannot read (\`${segment.trim()}\`) — give each binding its own export`,
      );
    }
    return named[1];
  });
}

/**
 * One `export` statement, read as the members it publishes and the re-export
 * edges it carries: `members` are names this module owns, `edges` are the names
 * it carries over from another module (`names: null` = a wildcard).
 */
export function exportStatement(source, at, file) {
  const { code } = source;
  const fail = (what) => failAt(file, code, at, what);
  const head = skipSpace(code, at + "export".length);

  if (/^default\b/.test(code.slice(head))) {
    return { members: [{ name: "default", typeOnly: false }], edges: [] };
  }

  const typeOnlyWildcard = /^type\s*\*/.exec(code.slice(head));
  if (code[head] === "*" || typeOnlyWildcard !== null) {
    const star = typeOnlyWildcard === null ? head : head + typeOnlyWildcard[0].length - 1;
    const asExport = new RegExp(`^\\*\\s+as\\s+(${IDENT})`).exec(code.slice(skipSpace(code, star)));
    if (asExport !== null) {
      // A namespace member of THIS module, not a doorway to the other one's members.
      const clause = skipSpace(code, star) + asExport[0].length;
      moduleSpecifier(source, clause, fail);
      return { members: [{ name: asExport[1], typeOnly: false }], edges: [] };
    }
    return {
      members: [],
      edges: [{ from: moduleSpecifier(source, star + 1, fail), names: null }],
    };
  }

  const typeList = /^type\s*\{/.exec(code.slice(head));
  const listAt = typeList === null ? head : head + typeList[0].length - 1;
  if (code[listAt] === "{") {
    const { elements, close } = readBraceList(code, listAt, fail);
    if (elements.length === 0) return { members: [], edges: [], emptyList: true };
    // `export type { A }` names A as a type however the element is written.
    const namesOf = elements.map(({ provided, exported, typeOnly }) => ({
      provided,
      exported,
      typeOnly: typeOnly || typeList !== null,
    }));
    const after = skipSpace(code, close + 1);
    if (!/^from\b/.test(code.slice(after))) {
      // A local binding exported by name: the member is this module's own, and it
      // is an edge too when the binding came from another module (see below).
      return {
        members: namesOf.map(({ exported, typeOnly }) => ({
          name: exported,
          typeOnly,
          binding: true,
        })),
        edges: [],
      };
    }
    return {
      members: [],
      edges: [{ from: moduleSpecifier(source, after, fail), names: namesOf }],
    };
  }

  const keyword = KEYWORD_RE.exec(code.slice(head));
  if (keyword === null) {
    fail(
      "no `const`/`let`/`var`/`function`/`class`/`enum`/`interface`/`type`/`namespace`/`module`, " +
        "no `*`, no `{`, no `default`",
    );
  }
  const [, kind] = keyword;
  const afterKeyword = head + keyword[0].length;
  const declaration = /^(const|let|var)$/.test(kind);
  if (declaration) {
    const names = readDeclarators(source, afterKeyword, fail);
    return { members: names.map((name) => ({ name, typeOnly: false })), edges: [] };
  }
  // `function*` names its generator after the star; every other kind names the
  // declaration first.
  const named = NAMED_RE.exec(code.slice(skipSpace(code, afterKeyword)).replace(/^\*\s*/, ""));
  if (named === null) fail(`a \`${kind}\` declaration with no name`);
  const typeOnly = kind === "type" || kind === "interface";
  return { members: [{ name: named[1], typeOnly }], edges: [] };
}

/** The names one import clause binds, and the name each imports. */
function clauseBindings(text) {
  let clause = text.trim();
  const typeOnly = /^type\b/.test(clause);
  clause = clause.replace(/^type\s+/, "").trim();
  const bindings = [];
  const add = (local, imported) => bindings.push({ local, imported, typeOnly });
  const namespace = /^\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
  if (namespace !== null) {
    add(namespace[1], "*");
    return bindings;
  }
  const named = /^\{([\s\S]*)\}/.exec(clause);
  if (named !== null) {
    for (const element of named[1].split(",")) {
      const parsed = /^(type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(
        element.trim(),
      );
      if (parsed !== null)
        bindings.push({
          local: parsed[3] ?? parsed[2],
          imported: parsed[2],
          typeOnly: typeOnly || Boolean(parsed[1]),
        });
    }
    return bindings;
  }
  const defaultAndRest = /^([A-Za-z_$][\w$]*)\s*(?:,([\s\S]*))?$/.exec(clause);
  if (defaultAndRest !== null) {
    add(defaultAndRest[1], "default");
    if (defaultAndRest[2] !== undefined) bindings.push(...clauseBindings(defaultAndRest[2]));
  }
  return bindings;
}

/**
 * The local names a module imports, and where each comes from — the missing half
 * of `export { x }` for a name imported from another module, which is a re-export
 * edge and not a member with no origin. A clause this reader does not know is
 * left unattributed rather than refused: the export stays a member of this module,
 * and the origin's member surfaces as unwired — loud, and fixed by writing the
 * `export … from` the barrel can see.
 */
export function importBindings({ code, literals }) {
  const bindings = new Map();
  for (const match of code.matchAll(/\bimport\b/g)) {
    const at = match.index;
    if (/[\w$.]/.test(code[at - 1] ?? "")) continue;
    const rest = code.slice(at + "import".length);
    const from = /\bfrom\s*(?=["'`])/.exec(rest);
    if (from === null) continue;
    const quote = at + "import".length + from.index + from[0].length;
    const literal = literals.get(quote);
    if (literal === undefined || !literal.closed) continue;
    const fromModule = code.slice(quote + 1, literal.end - 1);
    for (const binding of clauseBindings(rest.slice(0, from.index))) {
      bindings.set(binding.local, {
        from: fromModule,
        imported: binding.imported,
        typeOnly: binding.typeOnly,
      });
    }
  }
  return bindings;
}
