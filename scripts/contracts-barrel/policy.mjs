import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/**
 * The contracts barrel's gate — the contract `packages/contracts/src/index.ts`
 * is checked against.
 *
 * The barrel re-exports every member of the package by explicit name. A member
 * it does not name is not an error anywhere on the consuming side: the import
 * resolves to `undefined`, the suite stays green, and only `tsc` says otherwise
 * (`TS2305`), one gate later and in another tool. `CHAT_MESSAGE_MAX_LENGTH`
 * reached `main` that way, read as a `400` on a valid message because
 * `maxLength(undefined)` checks nothing. Both directions of that gap are
 * refused here:
 *
 *   - `unwiredMembers`: a module member no barrel entry re-exports, reported as
 *     the member and its module. The barrel's own statements and each module's
 *     own `export` statements are what this reads — never a list kept beside
 *     them, which is the same two-sources-of-truth defect wearing a test's
 *     clothes. Membership resolves through a module's re-export edges, so a
 *     member published through `./trace` counts as wired to whoever owns it;
 *   - `unprovidedBarrelNames`: a barrel entry naming a member its own `from`
 *     module does not provide — the same defect from the other side, and the
 *     name a consumer would import as `undefined` just the same;
 *   - `moduleFiles`: every `.ts` module on disk, so a module added AFTER this
 *     gate is judged by it (criterion 3) — wired into the barrel, or declaring
 *     itself with `// @contracts-internal: <reason>` when the package does not
 *     publish it. Declaring is the cheap remedy, so a declaration that turns out
 *     to gate nothing is a note rather than a failure;
 *   - `MIN_MODULES` / `MIN_MEMBERS` / `MIN_BARREL_ENTRIES`: an extraction that
 *     comes back short satisfies every rule above while checking nothing, which
 *     is the failure this whole module is about.
 *
 * Blind spots, stated. A name is a name: `export { type X }` and `export { X }`
 * are compared as the same member, so a VALUE re-exported type-only — where the
 * consumer's `import { X }` fails to compile rather than reading `undefined` —
 * is `tsc`'s to catch, not this gate's. A member whose name the barrel provides
 * from ANOTHER module (a collision) passes: the import resolves, so the silent
 * gap is closed, and which of the two the author meant is a reader's question.
 * The barrel is read as explicit-name re-exports only, so `export *` there is
 * refused rather than skimmed. Inside a module, the scan knows string and
 * template literals by their own delimiters: a literal that never closes, or a
 * multi-line template, ends at its own line, and prose past that point could be
 * read as a member — in a package of schema modules that is a residual, not a
 * shape in use. Consumers that deep-import `@app/contracts/src/<module>` bypass
 * this gate entirely: it checks that the barrel can serve every member, not that
 * every consumer goes through it.
 */

/** The error the gate throws: a message a caller can act on, never a bare parse slip. */
export class ContractsBarrelError extends Error {}

/** The package's modules and its one public surface. */
export const SRC_DIR = "packages/contracts/src";
export const BARREL_FILE = `${SRC_DIR}/index.ts`;

/** The directive a module carries to declare itself outside the public surface. */
export const INTERNAL_MARKER = "@contracts-internal";

/**
 * The fewest modules, members and barrel entries a sound extraction can return.
 * Floors, not counts: they refuse an extraction that came back short, and never
 * have to be touched when the package grows.
 */
export const MIN_MODULES = 8;
export const MIN_MEMBERS = 60;
export const MIN_BARREL_ENTRIES = 40;

const INTERNAL_RE = new RegExp(
  `^[ \\t]*//[ \\t]*${INTERNAL_MARKER}[ \\t]*:[ \\t]*(\\S[^\\n]*?)[ \\t]*$`,
  "m",
);
const TEST_FILE_RE = /\.test\.ts$/;
const IDENT = "[A-Za-z_$][\\w$]*";
const IDENT_RE = new RegExp(`^(${IDENT})`);
const DECLARATOR_RE = new RegExp(`^\\s*${IDENT}\\s*[:=]`);
const KEYWORD_RE = new RegExp(
  "^(?:declare\\s+)?(?:(?:abstract|async)\\s+)?" +
    "(const|let|var|function|class|enum|interface|type)\\b",
);
const EXPORT_RE = /\bexport\b/g;

const lineEnd = (source, from) => {
  const end = source.indexOf("\n", from);
  return end === -1 ? source.length : end;
};

const quotedEnd = (source, from, quote) => {
  for (let i = from + 1; i < source.length; i += 1) {
    if (source[i] === "\\") i += 1;
    else if (source[i] === quote) return i + 1;
    else if (source[i] === "\n") return i;
  }
  return source.length;
};

const skipSpace = (code, from) => {
  let i = from;
  while (i < code.length && /\s/.test(code[i])) i += 1;
  return i;
};

const lineOf = (source, offset) => source.slice(0, offset).split("\n").length;

const repoRelative = (root, path) => relative(root, path).split(sep).join("/");

/**
 * A source as the scans read it: comments blanked, and every string or template
 * literal's span recorded. The two are read apart because they answer different
 * questions — an `export` keyword in a comment is not a statement, while the
 * specifier a re-export names lives inside a literal the scan must still see.
 * Newlines are never blanked, so a message can name the line it found.
 */
function scanSource(source) {
  const code = source.split("");
  const literals = new Map();
  const blank = (from, to) => {
    for (let i = from; i < to; i += 1) if (code[i] !== "\n") code[i] = " ";
  };
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
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
    if (char === '"' || char === "'" || char === "`") {
      const end = quotedEnd(source, i, char);
      literals.set(i, { start: i, end, closed: end > i + 1 && source[end - 1] === char });
      i = end;
      continue;
    }
    i += 1;
  }
  return { code: code.join(""), literals };
}

/** Where each `export` keyword sits in code position — never one inside a literal. */
function exportKeywords({ code, literals }) {
  const found = [];
  for (const match of code.matchAll(EXPORT_RE)) {
    const before = code[match.index - 1];
    if (before === "." || before === "$") continue;
    let inLiteral = false;
    for (const literal of literals.values()) {
      if (match.index >= literal.start && match.index < literal.end) inLiteral = true;
    }
    if (!inLiteral) found.push(match.index);
  }
  return found;
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

/** One `provided [as exported]` element, with the `type` modifier it carries. */
function parseElement(raw, fail) {
  const text = raw.replace(/\s+/g, " ").trim();
  const typeOnly = /^type\s/.test(text);
  const match = new RegExp(`^(${IDENT})(?:\\s+as\\s+(${IDENT}))?$`).exec(
    text.replace(/^type\s+/, ""),
  );
  if (match === null) {
    fail(`an export list element this scan cannot read (\`${text}\`)`);
  }
  return { provided: match[1], exported: match[2] ?? match[1], typeOnly };
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
    const named = IDENT_RE.exec(segment.trimStart());
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
function readExport(source, at, file) {
  const { code } = source;
  const fail = (what) => {
    throw new ContractsBarrelError(
      `${file}:${lineOf(code, at)}: the export statement \`${code
        .slice(at, skipSpace(code, at + 60))
        .trim()}\` is a shape this gate cannot read — ${what}`,
    );
  };
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
    // `export type { A }` names A as a type however the element is written.
    const namesOf = (elements_) =>
      elements_.map(({ provided, exported, typeOnly }) => ({
        provided,
        exported,
        typeOnly: typeOnly || typeList !== null,
      }));
    const after = skipSpace(code, close + 1);
    if (!/^from\b/.test(code.slice(after))) {
      // A local binding exported by name: the member is this module's own.
      return {
        members: namesOf(elements).map(({ exported, typeOnly }) => ({ name: exported, typeOnly })),
        edges: [],
      };
    }
    return {
      members: [],
      edges: [{ from: moduleSpecifier(source, after, fail), names: namesOf(elements) }],
    };
  }

  const keyword = KEYWORD_RE.exec(code.slice(head));
  if (keyword === null) {
    fail("no `const`/`function`/`class`/`enum`/`interface`/`type`, no `*`, no `{`, no `default`");
  }
  const [, kind] = keyword;
  const afterKeyword = head + keyword[0].length;
  if (kind === "const" || kind === "let" || kind === "var") {
    const names = readDeclarators(source, afterKeyword, fail);
    return { members: names.map((name) => ({ name, typeOnly: false })), edges: [] };
  }
  const named = IDENT_RE.exec(code.slice(skipSpace(code, afterKeyword)));
  if (named === null) fail(`a \`${kind}\` declaration with no name`);
  return {
    members: [{ name: named[1], typeOnly: kind === "type" || kind === "interface" }],
    edges: [],
  };
}

/** What a module's own source declares as its export surface. */
export function moduleSurface(source, file = "module.ts") {
  const scanned = scanSource(source);
  const members = [];
  const edges = [];
  for (const at of exportKeywords(scanned)) {
    const statement = readExport(scanned, at, file);
    members.push(...statement.members);
    edges.push(...statement.edges);
  }
  return { members, edges };
}

/** The name a module declares itself internal by, or null. `reason` is never empty. */
export function internalDeclaration(source) {
  const match = INTERNAL_RE.exec(source);
  return match === null ? null : { reason: match[1] };
}

/**
 * Every entry the barrel carries: the name a consumer imports, the name the
 * module must provide, and the module. `export *` is refused rather than skimmed
 * — a wildcard surface is one no rule here can read — and so is a name with no
 * `from` clause, which no module can be held to.
 */
export function barrelEntries(source, file = BARREL_FILE) {
  const scanned = scanSource(source);
  const entries = [];
  for (const at of exportKeywords(scanned)) {
    const line = lineOf(scanned.code, at);
    const statement = readExport(scanned, at, file);
    if (statement.members.length > 0) {
      const names = statement.members.map((member) => `\`${member.name}\``).join(", ");
      throw new ContractsBarrelError(
        `${file}:${line} re-exports ${names} with no \`from "./module"\` clause: which module ` +
          "has to provide it is then unknowable here — re-export it with `from`",
      );
    }
    for (const edge of statement.edges) {
      if (edge.names === null) {
        throw new ContractsBarrelError(
          `${file}:${line} carries \`export * from "${edge.from}"\`: a wildcard surface is one ` +
            "this gate cannot read — name the members the barrel re-exports",
        );
      }
      for (const { provided, exported, typeOnly } of edge.names) {
        entries.push({ provided, exported, typeOnly, module: edge.from, line });
      }
    }
  }
  return entries;
}

/** Every `.ts` module of the package on disk, repo-relative and sorted. */
export function moduleFiles(root = process.cwd()) {
  const dir = join(root, SRC_DIR);
  const files = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".ts") && !TEST_FILE_RE.test(name)) files.push(path);
    }
  };
  try {
    walk(dir);
  } catch {
    throw new ContractsBarrelError(
      `no ${SRC_DIR} under ${root}: there is no module tree for this gate to read`,
    );
  }
  return files
    .map((path) => repoRelative(root, path))
    .filter((file) => file !== BARREL_FILE)
    .sort();
}

const readModuleFile = (root, file) => {
  try {
    return readFileSync(join(root, file), "utf8");
  } catch {
    throw new ContractsBarrelError(`no ${file} under ${root}: the gate cannot read what it checks`);
  }
};

/**
 * The module tree and the barrel, read once: each module's members, its
 * re-export edges, its internal declaration, and the barrel's entries. A
 * derivation that comes back short of the floors fails here rather than letting
 * every rule below pass over nothing.
 */
export function barrelInventory(root = process.cwd()) {
  const modules = new Map();
  for (const file of moduleFiles(root)) {
    const source = readModuleFile(root, file);
    modules.set(file, {
      file,
      ...moduleSurface(source, file),
      internal: internalDeclaration(source),
    });
  }
  if (modules.size < MIN_MODULES) {
    throw new ContractsBarrelError(
      `read ${modules.size} module(s) under ${SRC_DIR}, fewer than the ${MIN_MODULES} this gate ` +
        "needs to be reading the real package",
    );
  }
  const members = [...modules.values()].reduce((total, module) => total + module.members.length, 0);
  if (members < MIN_MEMBERS) {
    throw new ContractsBarrelError(
      `read ${members} exported member(s) across the module tree, fewer than the ${MIN_MEMBERS} ` +
        "this gate needs: an extraction that found nothing checks nothing",
    );
  }
  const entries = barrelEntries(readModuleFile(root, BARREL_FILE), BARREL_FILE);
  if (entries.length < MIN_BARREL_ENTRIES) {
    throw new ContractsBarrelError(
      `${BARREL_FILE} carries ${entries.length} re-exported name(s), fewer than the ` +
        `${MIN_BARREL_ENTRIES} this gate needs to be reading a real barrel: an extraction that ` +
        "finds nothing would satisfy every rule below while checking nothing",
    );
  }
  return { root, modules, entries };
}

/** The module a specifier names, repo-relative, or null when none does. */
function resolveModule(modules, from, spec) {
  const base = dirname(from);
  for (const candidate of [spec, `${spec}.ts`, `${spec.replace(/\.js$/, "")}.ts`]) {
    const path = join(base, candidate).split(sep).join("/");
    if (modules.has(path)) return path;
  }
  return null;
}

/**
 * Every module a barrel entry's `from` can reach, itself included: a member
 * published through a re-export chain is wired where the chain ends, and a
 * `names: null` edge carries the whole of its target along with it.
 */
function reachableSources(modules, from) {
  const sources = new Set();
  const visit = (file) => {
    if (sources.has(file)) return;
    sources.add(file);
    const module = modules.get(file);
    if (module === undefined) return;
    for (const edge of module.edges) {
      const target = resolveModule(modules, file, edge.from);
      if (target !== null) visit(target);
    }
  };
  visit(from);
  return sources;
}

/**
 * The module members barrel entries reach, as one `module\0name` key per member.
 * One reading, so the published set and the internal declarations are judged
 * against the same reach rather than two derivations that can drift apart.
 */
function coveredMembers(inventory) {
  const covered = new Set();
  for (const entry of inventory.entries) {
    const target = resolveModule(inventory.modules, BARREL_FILE, entry.module);
    if (target === null) continue;
    for (const source of reachableSources(inventory.modules, target)) {
      if (inventory.modules.get(source).members.some((member) => member.name === entry.provided)) {
        covered.add(`${source}\u0000${entry.provided}`);
      }
    }
  }
  return covered;
}

/**
 * The module members no barrel entry re-exports, each named with the module that
 * owns it. A module that declares itself internal contributes none: it is out of
 * the public surface on the record, with a reason.
 */
export function unwiredMembers(inventory) {
  const covered = coveredMembers(inventory);
  const unwired = [];
  for (const module of inventory.modules.values()) {
    if (module.internal !== null) continue;
    const names = module.members
      .filter((member) => !covered.has(`${module.file}\u0000${member.name}`))
      .map((member) => member.name);
    if (names.length > 0) unwired.push({ file: module.file, names });
  }
  return unwired;
}

/**
 * The internal declarations that no longer gate anything: every member of the
 * module reaches consumers through the barrel anyway. A note and not a failure —
 * declaring is the cheap remedy for a module the rules cannot tell from a
 * published one, so a marker that turns out stale must not redden anything.
 */
export function staleInternalDeclarations(inventory) {
  const covered = coveredMembers(inventory);
  return [...inventory.modules.values()]
    .filter(
      (module) =>
        module.internal !== null &&
        module.members.length > 0 &&
        module.members.every((member) => covered.has(`${module.file}\u0000${member.name}`)),
    )
    .map((module) => ({ file: module.file, reason: module.internal.reason }));
}

/**
 * The barrel entries naming a member their own module does not provide: the name
 * a consumer imports as `undefined`, and (with `export *` in the barrel) the case
 * no other check here would see.
 */
export function unprovidedBarrelNames(inventory) {
  const unprovided = [];
  for (const entry of inventory.entries) {
    const target = resolveModule(inventory.modules, BARREL_FILE, entry.module);
    if (target === null) {
      unprovided.push({ ...entry, reason: `no module ${entry.module}.ts exists in ${SRC_DIR}` });
      continue;
    }
    let provided = false;
    for (const source of reachableSources(inventory.modules, target)) {
      if (inventory.modules.get(source).members.some((member) => member.name === entry.provided)) {
        provided = true;
      }
    }
    if (!provided) {
      unprovided.push({ ...entry, reason: `${target} provides no such name` });
    }
  }
  return unprovided;
}

/**
 * The whole gate: every module member reaches a consumer through the barrel, and
 * every barrel entry names a member some module provides. Throws with both lists
 * when either direction fails; returns the reading when both hold.
 */
export function assertBarrelCoverage(root = process.cwd()) {
  const inventory = barrelInventory(root);
  const unwired = unwiredMembers(inventory);
  const unprovided = unprovidedBarrelNames(inventory);
  const problems = [];
  if (unwired.length > 0) {
    problems.push(
      "module member(s) that no barrel entry re-exports — a consumer importing one reads `undefined` " +
        "under vitest, where only `tsc` (TS2305) says so:\n" +
        unwired.map((module) => `  ${module.file}: ${module.names.join(", ")}`).join("\n") +
        `\n  Add each to ${BARREL_FILE}, or declare the module internal with ` +
        `\`// ${INTERNAL_MARKER}: <reason>\` when the package does not publish it`,
    );
  }
  if (unprovided.length > 0) {
    problems.push(
      `${BARREL_FILE} re-export(s) naming what no module provides:\n` +
        unprovided
          .map(
            (entry) =>
              `  ${BARREL_FILE}:${entry.line} re-exports \`${entry.exported}\` from ` +
              `"${entry.module}" — ${entry.reason}`,
          )
          .join("\n"),
    );
  }
  if (problems.length > 0) throw new ContractsBarrelError(problems.join("\n"));
  return {
    modules: inventory.modules.size,
    members: [...inventory.modules.values()].reduce(
      (total, module) => total + module.members.length,
      0,
    ),
    entries: inventory.entries.length,
    internal: [...inventory.modules.values()]
      .filter((module) => module.internal !== null)
      .map((module) => ({ file: module.file, reason: module.internal.reason })),
    stale: staleInternalDeclarations(inventory),
  };
}
