import { ContractsBarrelError } from "./errors.mjs";
import { classifyExports, requireBalanced, requireNoQuotedExports } from "./classify.mjs";
import { lineOf, scanSource, skipSpace } from "./source.mjs";
import { exportStatement, importBindings } from "./statements.mjs";

/**
 * The three questions the rules ask of one file — the questions, and only those.
 *
 * `moduleSurface` answers what a module publishes and what it carries over from
 * elsewhere; `barrelEntries` answers what the barrel names and where from;
 * `internalDeclaration` answers what a module declares itself out of the public
 * surface by. All three read the barrel's and the modules' own text through the
 * same scanner and the same statement grammar, so the two sides cannot be read by
 * rules that disagree.
 *
 * Beyond the statement grammar, two shapes are refused here because a wrong
 * reading of them is silent:
 *
 *   - an export keyword set the scan classified `nested` while the module has no
 *     export statement at all. A brace opened in error (a mis-read regex, say)
 *     turns every export below it into a member of a block, and nothing else in
 *     the gate would notice, because a member that was never extracted cannot be
 *     reported unwired;
 *   - one name published from two places (`export { a } from "./x"` beside
 *     `export { b as a } from "./y"`). Which module provides it is then
 *     ambiguous, and one barrel entry would satisfy two different members.
 */

/**
 * What can follow an `export` keyword that is starting a statement: a declaration,
 * a list, a wildcard, a namespace. A property key (`{ export: 1 }`) or a call is
 * not one, so a nested keyword is an intent to export only when it matches here.
 */
const STATEMENT_AFTER_EXPORT =
  /^(?:\{|\*|default\b|declare\b|abstract\b|async\b|const\b|let\b|var\b|function\b|class\b|enum\b|interface\b|type\b|namespace\b|module\b)/;

const exportsAStatement = (code, at) =>
  STATEMENT_AFTER_EXPORT.test(code.slice(skipSpace(code, at + "export".length)));

/** The `@contracts-internal` directive: the members it withholds, then the reason. */
export const INTERNAL_MARKER = "@contracts-internal";
const INTERNAL_RE = new RegExp(
  `^[ \\t]*//[ \\t]*${INTERNAL_MARKER}\\b([^:\\n]*):[ \\t]*(\\S[^\\n]*?)[ \\t]*$`,
  "gm",
);

/** What a module's own source declares as its export surface. */
export function moduleSurface(source, file = "module.ts") {
  const scanned = scanSource(source, file);
  const classified = classifyExports(scanned);
  requireBalanced(scanned, classified, file);
  requireNoQuotedExports(scanned, classified.quoted, file);
  const { statements } = classified;
  const hidden = classified.nested.filter((at) => exportsAStatement(scanned.code, at));
  if (statements.length === 0 && hidden.length > 0) {
    throw new ContractsBarrelError(
      `${file}:${lineOf(scanned.code, hidden[0])}: this \`export\` starts a statement but reads ` +
        "as nested inside a block, and the module has no export statement at all, so a brace " +
        "opened in error sits above it and the members below it cannot be seen — close it, or " +
        "write the construct so it reads as code",
    );
  }
  const members = [];
  const edges = [];
  for (const at of statements) {
    const statement = exportStatement(scanned, at, file);
    if (
      statement.emptyList !== true &&
      statement.members.length === 0 &&
      statement.edges.length === 0
    ) {
      throw new ContractsBarrelError(
        `${file}:${lineOf(scanned.code, at)}: the export statement here publishes nothing this ` +
          "scan can read — a statement that yields no member and no edge is a shape it cannot judge",
      );
    }
    members.push(...statement.members);
    edges.push(...statement.edges);
  }
  const imports = importBindings(scanned);
  for (const member of members) {
    if (member.binding !== true) continue;
    const imported = imports.get(member.name);
    if (imported === undefined || imported.imported === "*") continue;
    edges.push({
      from: imported.from,
      names: [
        {
          provided: imported.imported,
          exported: member.name,
          typeOnly: member.typeOnly || imported.typeOnly,
        },
      ],
    });
  }
  const origins = new Map();
  const note = (name, origin) => {
    const seen = origins.get(name) ?? new Set();
    seen.add(origin);
    origins.set(name, seen);
  };
  for (const member of members) if (member.binding !== true) note(member.name, "this module");
  for (const edge of edges) {
    if (edge.names === null) continue;
    for (const carried of edge.names) note(carried.exported, edge.from);
  }
  const ambiguous = [...origins].filter(([, seen]) => seen.size > 1);
  if (ambiguous.length > 0) {
    throw new ContractsBarrelError(
      `${file}: publishes ${ambiguous
        .map(([name, seen]) => `\`${name}\` from ${[...seen].join(" and ")}`)
        .join(", ")} — one name has one origin, or a single barrel entry would have to stand for ` +
        "two different members",
    );
  }
  const published = new Set();
  const distinct = members.filter((member) => {
    if (published.has(member.name)) return false;
    published.add(member.name);
    return true;
  });
  return { members: distinct, edges, nested: classified.nested.length };
}

/** The name and reason a module declares itself out of the public surface by, or null. */
export function internalDeclaration(source, file = "module.ts") {
  const { directives, comments } = scanSource(source, file);
  const matches = [...directives.matchAll(INTERNAL_RE)];
  if (matches.length === 0) {
    if (comments.includes(INTERNAL_MARKER)) {
      throw new ContractsBarrelError(
        `${file}: the \`${INTERNAL_MARKER}\` text here is a comment this gate does not read as a ` +
          "directive — a misplaced declaration is refused rather than ignored, because the " +
          `author meant to declare something: write it as its own \`// ${INTERNAL_MARKER} ` +
          "<name>[, <name>…]: <reason>` line",
      );
    }
    return null;
  }
  if (matches.length > 1) {
    throw new ContractsBarrelError(
      `${file}: carries ${matches.length} \`${INTERNAL_MARKER}\` declarations: one module declares ` +
        "once, so the reason and the members it covers stay one statement",
    );
  }
  const [, rawNames, reason] = matches[0];
  const names = rawNames
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  if (names.length === 0) {
    throw new ContractsBarrelError(
      `${file}:${lineOf(directives, matches[0].index)}: the \`${INTERNAL_MARKER}\` declaration ` +
        "names no member — list the members the module withholds, so a member added later cannot " +
        "inherit the exemption silently",
    );
  }
  for (const name of names) {
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
      throw new ContractsBarrelError(
        `${file}:${lineOf(directives, matches[0].index)}: the \`${INTERNAL_MARKER}\` declaration ` +
          `lists \`${name}\`, which is not a member name`,
      );
    }
  }
  return { names, reason, line: lineOf(directives, matches[0].index) };
}

/**
 * Every entry the barrel carries: the name a consumer imports, the name the
 * module must provide, and the module. `export *` is refused rather than skimmed
 * — a wildcard surface is one no rule here can read — and so is a name with no
 * `from` clause, which no module can be held to.
 */
export function barrelEntries(source, file = "index.ts") {
  const scanned = scanSource(source, file);
  const classified = classifyExports(scanned);
  requireBalanced(scanned, classified, file);
  requireNoQuotedExports(scanned, classified.quoted, file);
  const entries = [];
  for (const at of classified.statements) {
    const line = lineOf(scanned.code, at);
    const statement = exportStatement(scanned, at, file);
    if (statement.emptyList === true) continue;
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
