import { ContractsBarrelError } from "./errors.mjs";
import { INTERNAL_MARKER, barrelEntries, internalDeclaration, moduleSurface } from "./surface.mjs";
import { BARREL_FILE, SRC_DIR, moduleFiles, readModuleFile, resolveModule } from "./tree.mjs";

/**
 * The contracts barrel's gate — the rules `packages/contracts/src/index.ts` and
 * its modules are checked against.
 *
 * The barrel re-exports every member of the package by explicit name. A member it
 * does not name is not an error anywhere on the consuming side: the import
 * resolves to `undefined`, the suite stays green, and only `tsc` says otherwise
 * (`TS2305`), one gate later and in another tool. `CHAT_MESSAGE_MAX_LENGTH`
 * reached `main` that way, read as a `400` on a valid message because
 * `maxLength(undefined)` checks nothing. The rules refuse both directions of that
 * gap, and neither is a list kept beside the truth:
 *
 *   - `unwiredMembers`: a module member no barrel entry publishes, reported as the
 *     member and its module. The barrel's own statements and each module's own
 *     `export` statements are what the reader reads, and membership resolves
 *     through a module's re-export edges, so a member published through `./trace`
 *     counts as published to whoever owns it;
 *   - `unprovidedBarrelNames`: a barrel entry naming a member its own `from`
 *     module does not provide, or a module the tree does not contain — the same
 *     defect from the other side, and the name a consumer would import as
 *     `undefined` just the same;
 *   - `misdeclaredModules`: a module declares itself out of the public surface
 *     with `// @contracts-internal <name>[, <name>…]: <reason>`, naming the
 *     members it withholds. The declaration answers for each of them: a member it
 *     withholds and does not name reddens (so a member added to a declared module
 *     cannot inherit the exemption silently), a name the module does not export
 *     reddens, and a name a barrel entry publishes reddens — the record has to be
 *     true, which also means a stale declaration is a failure and not a note;
 * One traversal answers both directions: `traced` follows a name a module publishes
 * through its re-export edges to the member that declares it, and both rules read
 * its two answers — `found` (does a module provide the name at all, so a broken
 * chain is a refusal and not a pass) and `marks` (which members a barrel entry
 * publishes). Two traversals that drifted apart is how a rule gets written twice
 * and disagrees with itself.
 *
 * There are no floors. A barrel entry that resolves to no module reddens, so a
 * walk that read nothing cannot pass; every module is either reached by an entry
 * or named in the unwired report; and every member is judged by one of the two
 * rules above, which is why the report's counts are evidence rather than a
 * separate assertion that could only restate them.
 *
 * Blind spots, stated. A name is a name: `export { type X }` and `export { X }` are
 * compared as the same member, so a VALUE re-exported type-only — where the
 * consumer's `import { X }` fails to compile rather than reading `undefined` — is
 * `tsc`'s to catch, not this gate's. A member whose name the barrel provides from
 * ANOTHER module (a collision) passes: the import resolves, so the silent gap is
 * closed, and which of the two the author meant is a reader's question. A module
 * that `import`s a name it re-exports is only attributed to that origin when the
 * import clause is one `statements.mjs` recognises; otherwise the export stays this
 * module's member and the origin's surfaces as unwired — loud, and fixed by
 * spelling the re-export `export … from`. A namespace re-export (`export * as ns
 * from "./x"`) publishes one name, `ns`: a member reachable only as `ns.carried`
 * is not importable by name, so the ticket's rule still wants it published or the
 * module declared. Consumers that deep-import `@app/contracts/src/<module>` bypass
 * this gate entirely: it checks that the barrel can serve every member, not that
 * every consumer goes through it.
 */

const key = (file, name) => `${file}\u0000${name}`;

/** The module tree and the barrel, read once. */
export function barrelInventory(root = process.cwd()) {
  const modules = new Map();
  for (const file of moduleFiles(root)) {
    const source = readModuleFile(root, file);
    modules.set(file, {
      file,
      ...moduleSurface(source, file),
      declaration: internalDeclaration(source, file),
    });
  }
  return { root, modules, entries: barrelEntries(readModuleFile(root, BARREL_FILE), BARREL_FILE) };
}

/**
 * Every module a barrel entry's `from` can reach, itself included: a member
 * published through a re-export chain is published where the chain ends, and a
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
 * Where a name a module publishes comes from: `found` says a module provides it at
 * all, `marks` says which members the publication stands for. One traversal feeds
 * both, because they are two questions about one walk — a name is provided only
 * when the chain ends at a member that declares it, and that member is what a
 * barrel entry publishes.
 *
 * `export { carried as renamed } from "./origin"` publishes `origin.ts: carried`; a
 * module that both imports and re-exports a name publishes its own member and the
 * origin's, since a consumer's one import reads the same value from either. A
 * wildcard edge carries its target's surface under the same names; a namespace
 * edge (`names[].provided === "*"`) carries the namespace object, which owes no
 * member name. A cycle stops rather than spinning.
 */
function traced(modules, file, name, seen = new Set()) {
  const module = modules.get(file);
  if (module === undefined) return { found: false, marks: [] };
  if (name === "*") return { found: true, marks: [] };
  const marks = [];
  let found = false;
  if (module.members.some((member) => member.name === name)) {
    marks.push({ file, name });
    found = true;
  }
  if (seen.has(file)) return { found, marks };
  const path = new Set(seen).add(file);
  for (const edge of module.edges) {
    const target = resolveModule(modules, file, edge.from);
    if (target === null) continue;
    if (edge.names === null) {
      const child = traced(modules, target, name, path);
      found = found || child.found;
      marks.push(...child.marks);
      continue;
    }
    for (const carried of edge.names) {
      if (carried.exported !== name) continue;
      const child = traced(modules, target, carried.provided, path);
      found = found || child.found;
      marks.push(...child.marks);
    }
  }
  return { found, marks };
}

/** Every module some barrel entry reaches, and every member one publishes. */
function reach(inventory) {
  const modules = new Set();
  const members = new Set();
  for (const entry of inventory.entries) {
    const target = resolveModule(inventory.modules, BARREL_FILE, entry.module);
    if (target === null) continue;
    for (const source of reachableSources(inventory.modules, target)) modules.add(source);
    for (const mark of traced(inventory.modules, target, entry.provided).marks) {
      members.add(key(mark.file, mark.name));
    }
  }
  return { modules, members };
}

/**
 * The module members no barrel entry publishes, each named with the module that
 * owns it. A module that declares itself internal contributes none of the members
 * it names: they are out of the public surface on the record, with a reason.
 */
export function unwiredMembers(inventory) {
  const published = reach(inventory);
  const unwired = [];
  for (const module of inventory.modules.values()) {
    if (module.declaration !== null) continue;
    const names = module.members
      .filter((member) => !published.members.has(key(module.file, member.name)))
      .map((member) => member.name);
    if (names.length > 0) {
      unwired.push({ file: module.file, reached: published.modules.has(module.file), names });
    }
  }
  return unwired;
}

/**
 * The barrel entries naming what their own module does not provide — the name a
 * consumer imports as `undefined`, and (with `export *` in the barrel) the case no
 * other rule here would see.
 */
export function unprovidedBarrelNames(inventory) {
  const unprovided = [];
  for (const entry of inventory.entries) {
    const target = resolveModule(inventory.modules, BARREL_FILE, entry.module);
    if (target === null) {
      unprovided.push({ ...entry, reason: `no module "${entry.module}" exists in ${SRC_DIR}` });
      continue;
    }
    if (!traced(inventory.modules, target, entry.provided).found) {
      unprovided.push({ ...entry, reason: `"${entry.module}" provides no such name` });
    }
  }
  return unprovided;
}

/**
 * The `@contracts-internal` declarations that no longer say what the module does:
 * a member withheld and not named, a name the module does not export, a name a
 * barrel entry publishes anyway. Each is a failure — the declaration is the record
 * of a decision, and a record that has drifted is re-justified or dropped.
 */
export function misdeclaredModules(inventory) {
  const published = reach(inventory);
  const misdeclared = [];
  for (const module of inventory.modules.values()) {
    const declaration = module.declaration;
    if (declaration === null) continue;
    const memberNames = new Set(module.members.map((member) => member.name));
    const unlisted = module.members
      .filter(
        (member) =>
          !published.members.has(key(module.file, member.name)) &&
          !declaration.names.includes(member.name),
      )
      .map((member) => member.name);
    const unknown = declaration.names.filter((name) => !memberNames.has(name));
    const redundant = declaration.names.filter(
      (name) => memberNames.has(name) && published.members.has(key(module.file, name)),
    );
    if (unlisted.length + unknown.length + redundant.length > 0) {
      misdeclared.push({ file: module.file, line: declaration.line, unlisted, unknown, redundant });
    }
  }
  return misdeclared;
}

/**
 * The report's counts: how many extracted members a barrel entry publishes, and
 * how many a declaration withholds. Evidence, not a rule — `unwiredMembers` and
 * `misdeclaredModules` are what judge a member, and a third assertion over their
 * two sets could only restate them.
 */
function tally(inventory) {
  const published = reach(inventory);
  let extracted = 0;
  let withheld = 0;
  for (const module of inventory.modules.values()) {
    for (const member of module.members) {
      extracted += 1;
      if (published.members.has(key(module.file, member.name))) continue;
      if (module.declaration?.names.includes(member.name)) withheld += 1;
    }
  }
  return { extracted, withheld, published: extracted - withheld };
}

/**
 * The whole gate: every module member is published through the barrel or withheld
 * on the record, every barrel entry names what some module provides, and every
 * declaration is still true. Throws with those lists when any of them fails;
 * returns the reading when they all hold.
 */
export function assertBarrelCoverage(root = process.cwd()) {
  const inventory = barrelInventory(root);
  const unwired = unwiredMembers(inventory);
  const unprovided = unprovidedBarrelNames(inventory);
  const misdeclared = misdeclaredModules(inventory);
  const counts = tally(inventory);
  const problems = [];

  if (unwired.length > 0) {
    problems.push(
      "module member(s) that no barrel entry re-exports — a consumer importing one reads `undefined` " +
        "under vitest, where only `tsc` (TS2305) says so:\n" +
        unwired
          .map(
            (module) =>
              `  ${module.file}: ${module.names.join(", ")}${
                module.reached ? "" : "  (no barrel entry reaches this module)"
              }`,
          )
          .join("\n") +
        `\n  Add each to ${BARREL_FILE}, or declare the module internal with ` +
        `\`// ${INTERNAL_MARKER} <name>[, <name>…]: <reason>\` when the package does not publish it`,
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

  if (misdeclared.length > 0) {
    problems.push(
      `\`${INTERNAL_MARKER}\` declaration(s) no longer saying what the module does:\n` +
        misdeclared
          .map((entry) => {
            const parts = [];
            if (entry.unlisted.length > 0) {
              parts.push(`withholds ${entry.unlisted.join(", ")} without naming it`);
            }
            if (entry.unknown.length > 0) {
              parts.push(`names ${entry.unknown.join(", ")}, which the module does not export`);
            }
            if (entry.redundant.length > 0) {
              parts.push(`withholds ${entry.redundant.join(", ")}, which a barrel entry publishes`);
            }
            return `  ${entry.file}:${entry.line}: ${parts.join("; ")}`;
          })
          .join("\n") +
        "\n  Name every member the module withholds and no barrel entry publishes, and drop the " +
        "names it no longer withholds",
    );
  }

  if (problems.length > 0) throw new ContractsBarrelError(problems.join("\n"));

  return {
    modules: inventory.modules.size,
    members: counts.extracted,
    entries: inventory.entries.length,
    published: counts.published,
    withheld: counts.withheld,
    nested: [...inventory.modules.values()].reduce((total, module) => total + module.nested, 0),
    internal: [...inventory.modules.values()]
      .filter((module) => module.declaration !== null)
      .map((module) => ({
        file: module.file,
        line: module.declaration.line,
        names: module.declaration.names,
        reason: module.declaration.reason,
      })),
  };
}
