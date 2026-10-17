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
 *   - `accountFor`: every extracted member receives exactly one verdict —
 *     published, or withheld by a declaration — and the two counts equal the
 *     extraction. A member that falls between the rules cannot hide inside a
 *     total, and the count is a rule over the tree rather than a floor under it:
 *     the barrel's own entries are what prove the extraction read something (an
 *     empty walk leaves every entry unresolved), so no constant has to be raised
 *     as the package grows.
 *
 * Blind spots, stated. A name is a name: `export { type X }` and `export { X }` are
 * compared as the same member, so a VALUE re-exported type-only — where the
 * consumer's `import { X }` fails to compile rather than reading `undefined` — is
 * `tsc`'s to catch, not this gate's. A member whose name the barrel provides from
 * ANOTHER module (a collision) passes: the import resolves, so the silent gap is
 * closed, and which of the two the author meant is a reader's question. A module
 * that `import`s a name it re-exports is only attributed to that origin when the
 * import clause is one `read.mjs` recognises; otherwise the export stays this
 * module's member and the origin's surfaces as unwired — loud, and fixed by
 * spelling the re-export `export … from`. Consumers that deep-import
 * `@app/contracts/src/<module>` bypass this gate entirely: it checks that the
 * barrel can serve every member, not that every consumer goes through it.
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
 * Whether a module publishes a name: it declares one, an `export … from` edge
 * carries one over under that name, or a wildcard edge carries its target's whole
 * surface. A cycle stops rather than spinning.
 */
function provides(modules, file, name, seen = new Set()) {
  const module = modules.get(file);
  if (module === undefined) return false;
  if (module.members.some((member) => member.name === name)) return true;
  if (seen.has(file)) return false;
  const path = new Set(seen).add(file);
  for (const edge of module.edges) {
    const target = resolveModule(modules, file, edge.from);
    if (target === null) continue;
    if (edge.names === null && provides(modules, target, name, path)) return true;
    if (edge.names !== null && edge.names.some((carried) => carried.exported === name)) return true;
  }
  return false;
}

/**
 * The members a barrel entry publishes: the target's own member of that name, and
 * every member along the chain it resolves through. `export { carried as renamed }
 * from "./origin"` publishes `origin.ts: carried`; a module that both imports and
 * re-exports a name publishes its own member and the origin's, since a consumer's
 * one import reads the same value from either.
 */
function publishedBy(modules, file, name, seen = new Set()) {
  const marks = [];
  const module = modules.get(file);
  if (module === undefined) return marks;
  if (module.members.some((member) => member.name === name)) marks.push({ file, name });
  if (seen.has(file)) return marks;
  const path = new Set(seen).add(file);
  for (const edge of module.edges) {
    const target = resolveModule(modules, file, edge.from);
    if (target === null) continue;
    if (edge.names === null) {
      // A wildcard carries its target's surface under the same names.
      marks.push(...publishedBy(modules, target, name, path));
      continue;
    }
    for (const carried of edge.names) {
      if (carried.exported === name)
        marks.push(...publishedBy(modules, target, carried.provided, path));
    }
  }
  return marks;
}

/** Every module some barrel entry reaches, and every member one publishes. */
function reach(inventory) {
  const modules = new Set();
  const members = new Set();
  for (const entry of inventory.entries) {
    const target = resolveModule(inventory.modules, BARREL_FILE, entry.module);
    if (target === null) continue;
    for (const source of reachableSources(inventory.modules, target)) modules.add(source);
    for (const mark of publishedBy(inventory.modules, target, entry.provided)) {
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
    if (!provides(inventory.modules, target, entry.provided)) {
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
 * Every extracted member's one verdict: published by a barrel entry, or withheld
 * by a declaration. The counts are the gate's accounting — `unaccounted` is a
 * member no rule spoke about, which is the shape a silently-dropped member takes.
 */
export function accountFor(inventory) {
  const published = reach(inventory);
  const tally = { extracted: 0, published: 0, withheld: 0, unaccounted: [] };
  for (const module of inventory.modules.values()) {
    for (const member of module.members) {
      tally.extracted += 1;
      if (published.members.has(key(module.file, member.name))) tally.published += 1;
      else if (module.declaration?.names.includes(member.name)) tally.withheld += 1;
      else tally.unaccounted.push(`${module.file}: ${member.name}`);
    }
  }
  return tally;
}

/**
 * The whole gate: every module member is published through the barrel or withheld
 * on the record, every barrel entry names what some module provides, every
 * declaration is still true, and every extracted member has a verdict. Throws with
 * those lists when any of them fails; returns the reading when they all hold.
 */
export function assertBarrelCoverage(root = process.cwd()) {
  const inventory = barrelInventory(root);
  const unwired = unwiredMembers(inventory);
  const unprovided = unprovidedBarrelNames(inventory);
  const misdeclared = misdeclaredModules(inventory);
  const accounting = accountFor(inventory);
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

  if (
    accounting.unaccounted.length > 0 ||
    accounting.published + accounting.withheld !== accounting.extracted
  ) {
    problems.push(
      `member(s) the rules never judged (${accounting.published} published + ` +
        `${accounting.withheld} withheld ≠ ${accounting.extracted} extracted):\n` +
        accounting.unaccounted.map((member) => `  ${member}`).join("\n"),
    );
  }

  if (problems.length > 0) throw new ContractsBarrelError(problems.join("\n"));

  return {
    modules: inventory.modules.size,
    members: accounting.extracted,
    entries: inventory.entries.length,
    published: accounting.published,
    withheld: accounting.withheld,
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
