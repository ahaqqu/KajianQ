import { ContractsBarrelError } from "./errors.mjs";
import { classifyExports, lineOf, scanSource } from "./source.mjs";
import { exportStatement, importBindings, requireNoQuotedExports } from "./statements.mjs";

/**
 * The three questions the rules ask of one file — the questions, and only those.
 *
 * `moduleSurface` answers what a module publishes and what it carries over from
 * elsewhere; `barrelEntries` answers what the barrel names and where from;
 * `internalDeclaration` answers what a module declares itself out of the public
 * surface by. All three read the barrel's and the modules' own text through the
 * same scanner and the same statement grammar, so the two sides cannot be read by
 * rules that disagree.
 */

/** The `@contracts-internal` directive: the members it withholds, then the reason. */
export const INTERNAL_MARKER = "@contracts-internal";
const INTERNAL_RE = new RegExp(
  `^[ \\t]*//[ \\t]*${INTERNAL_MARKER}\\b([^:\\n]*):[ \\t]*(\\S[^\\n]*?)[ \\t]*$`,
  "gm",
);

/** What a module's own source declares as its export surface. */
export function moduleSurface(source, file = "module.ts") {
  const scanned = scanSource(source, file);
  const { statements, quoted } = classifyExports(scanned);
  requireNoQuotedExports(scanned, quoted, file);
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
  return { members, edges };
}

/** The name and reason a module declares itself out of the public surface by, or null. */
export function internalDeclaration(source, file = "module.ts") {
  const { directives } = scanSource(source, file);
  const matches = [...directives.matchAll(INTERNAL_RE)];
  if (matches.length === 0) {
    if (directives.includes(INTERNAL_MARKER)) {
      throw new ContractsBarrelError(
        `${file}: the \`${INTERNAL_MARKER}\` directive here is not a comment line this gate reads ` +
          `as one — a declaration names the members it withholds and carries a reason: ` +
          `\`// ${INTERNAL_MARKER} <name>[, <name>…]: <reason>\``,
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
  const { statements, quoted } = classifyExports(scanned);
  requireNoQuotedExports(scanned, quoted, file);
  const entries = [];
  for (const at of statements) {
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
