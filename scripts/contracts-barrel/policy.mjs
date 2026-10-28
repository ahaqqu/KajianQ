import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { refusedEntries } from "./entries.mjs";
import { ContractsBarrelError } from "./errors.mjs";
import { BARREL_FILE, moduleFiles } from "./tree.mjs";

export { refusedEntries };

/**
 * The contracts barrel gate: the values the runtime publishes, against the values
 * the tree binds.
 *
 * `packages/contracts/src/index.ts` re-exports every member by hand. A value the
 * barrel omits has no binding in the barrel's namespace, so a consumer importing
 * it reads `undefined` while the suite stays green, and only `tsc` disagrees, one
 * gate later and in another tool. This gate closes that gap at the runtime: it
 * imports the barrel and every module in the tree and compares the names each
 * module binds with the names the barrel publishes, and the values behind them.
 *
 * A module is never read as text. `Object.keys` of its namespace is the set of
 * names that have a runtime binding after it executes — what a consumer's import
 * actually reads — so a module's syntax (a regex, a template, a `debugger`
 * statement, a `/` that opens a line) cannot hide a binding from the loader. The
 * barrel is the one file the runtime cannot check by itself, so its entries are
 * read with the compiler's own scanner — comments are trivia and a template is one
 * token — and a star or `export type` entry is refused: it publishes a name no line
 * of the barrel reviews, and it is how a declared-only name gains a value binding
 * that reads `undefined`.
 *
 * The rules, in the order a caller sees them; the first failing class is the one
 * reported, and its findings are listed together. A mistake that straddles two
 * classes takes two runs to show both halves — a rename leaves both an unpublished
 * origin and an unbound entry:
 *
 *   - a star entry (`export *`, `export * as ns`) or an `export type` entry in the
 *     barrel, with its line, since neither is a value entry this gate can verify;
 *   - a value a module binds and the barrel does not publish, with its module;
 *   - a name the barrel publishes that no module in the tree binds, with the entry,
 *     or with the loader's own message when the specifier resolves to nothing;
 *   - a name the barrel publishes with a value no module binds under that name —
 *     the entry's value must be the very value a module binds, so a phantom key
 *     (`export { Absent } from "./mod"` where another module binds `Absent`) reads
 *     `undefined` and reddens here;
 *   - a name two modules bind with values that are not the same object: one name
 *     must carry one value, so a re-export of the same object is one name and two
 *     different values under one name are a collision;
 *   - a module named in `INTERNAL_MODULES` whose value the barrel publishes anyway,
 *     with the recorded reason;
 *   - an `INTERNAL_MODULES` entry whose module the tree does not hold.
 *
 * Three limits, stated so nothing is claimed past them. A type-only or
 * declared-only name has no runtime binding, and a consumer's value use of one is a
 * type error, not an `undefined`: the type checker judges it, and this gate does not
 * claim it — which is why the barrel still refuses a star entry, whose publish would
 * hand such a name a value binding. A module that throws on import is a refusal with
 * its own error surfaced, and the gate executes every module's top-level code, so a
 * module that hangs hangs the gate. A name is published under the name its module
 * binds: `export { x as y } from` publishes `y` where it is written and leaves `x`
 * unpublished at its origin, a `default` export can only be published as `default`,
 * and a rename belongs at the origin or the origin module belongs in
 * `INTERNAL_MODULES`.
 *
 * The claim, exactly: every value a module under `packages/contracts/src` binds in
 * `.ts`, `.tsx` or `.mts` is published by a barrel entry that names it, and every
 * name the barrel publishes is bound by a module under that name — a star entry,
 * an `export type` entry and a `.cts` module are outside what this gate judges, and
 * since a star or type-only entry is refused rather than read, a type-only or
 * declared-only name reaches a consumer as a type error, never as an `undefined`
 * this gate missed.
 *
 * An exemption is a row in `INTERNAL_MODULES` — module path to reason — and it
 * grants the whole module at once, for as long as the row stands: exact, reviewable,
 * and impossible to hide inside a string or a star entry.
 */
export const INTERNAL_MODULES = {
  "packages/contracts/src/trace-product-rules.ts":
    "composed into the TraceEvent union in ./trace-events.ts — a reader parses that union and branches on `kind`, never on a variant module",
  "packages/contracts/src/trace-source-routing.ts":
    "composed into the TraceEvent union in ./trace-events.ts and spread into the chat trace frame in ./chat-trace.ts — both publish the fields inline, so no consumer parses these schemas by name",
  "packages/contracts/src/trace-retriever.ts":
    "composed into the TraceEvent union in ./trace-events.ts — a reader parses that union and branches on `kind`, never on a variant module",
};

/** One module's runtime namespace, refused rather than read as empty when it throws. */
async function loadModule(root, file) {
  const path = join(root, file);
  try {
    return await import(pathToFileURL(path).href);
  } catch (error) {
    throw new ContractsBarrelError(
      `${file} does not import: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Every module file with the value names it binds, and the barrel's published
 * names — the facts the rules compare. A module that throws is refused here.
 */
export async function valueInventory(root = process.cwd(), { internal = INTERNAL_MODULES } = {}) {
  const files = moduleFiles(root);
  const modules = [];
  for (const file of files) {
    const namespace = await loadModule(root, file);
    modules.push({
      file,
      names: Object.keys(namespace),
      values: namespace,
      internal: Object.hasOwn(internal, file),
      reason: internal[file],
    });
  }
  const barrelValues = await loadModule(root, BARREL_FILE);
  return { modules, barrel: Object.keys(barrelValues), barrelValues, internal };
}

function providersOf(modules) {
  const map = new Map();
  for (const module of modules) {
    for (const name of module.names) {
      const list = map.get(name) ?? [];
      list.push(module);
      map.set(name, list);
    }
  }
  return map;
}

/** The modules that bind each name, internal ones aside — the package's own surface. */
export function providers(inventory) {
  return providersOf(inventory.modules.filter((module) => !module.internal));
}

/** Every value a module binds that no barrel entry publishes. */
export function unwiredMembers(inventory) {
  const published = new Set(inventory.barrel);
  return inventory.modules
    .filter((module) => !module.internal)
    .map((module) => ({
      file: module.file,
      names: module.names.filter((name) => !published.has(name)),
    }))
    .filter((entry) => entry.names.length > 0);
}

/** Every name the barrel publishes that no module in the tree binds. */
export function unprovidedBarrelNames(inventory) {
  const bound = providersOf(inventory.modules);
  return inventory.barrel
    .filter((name) => !bound.has(name))
    .map((name) => ({ file: BARREL_FILE, name }));
}

/** Every name the barrel publishes with a value no module binds under that name. */
export function unboundValues(inventory) {
  const bound = providers(inventory);
  return inventory.barrel.flatMap((name) => {
    const list = bound.get(name) ?? [];
    if (list.length === 0) return [];
    if (list.some((module) => Object.is(module.values[name], inventory.barrelValues[name])))
      return [];
    return [
      { name, value: inventory.barrelValues[name], modules: list.map((module) => module.file) },
    ];
  });
}

/** Every name two modules bind with values that are not the same object. */
export function collidingNames(inventory) {
  const bound = providers(inventory);
  const collisions = [];
  for (const name of inventory.barrel) {
    const list = bound.get(name) ?? [];
    if (list.length < 2) continue;
    const [first] = list;
    if (list.some((module) => module.values[name] !== first.values[name])) {
      collisions.push({ name, modules: list.map((module) => module.file) });
    }
  }
  return collisions;
}

/** A module declared internal that binds a value the barrel publishes anyway. */
export function misdeclaredModules(inventory) {
  const published = new Set(inventory.barrel);
  const misdeclared = [];
  for (const module of inventory.modules) {
    if (!module.internal) continue;
    const leaked = module.names.filter((name) => published.has(name));
    if (leaked.length > 0)
      misdeclared.push({ file: module.file, names: leaked, reason: module.reason });
  }
  return misdeclared;
}

/** The `INTERNAL_MODULES` entries whose module the tree does not hold. */
export function staleDeclarations(inventory) {
  const files = new Set(inventory.modules.map((module) => module.file));
  return Object.keys(inventory.internal).filter((file) => !files.has(file));
}

/** The count a reader gets: what the tree binds, what the barrel publishes. */
export function tally(inventory) {
  const bound = providers(inventory);
  const withheld = inventory.modules
    .filter((module) => module.internal)
    .flatMap((module) => module.names);
  return {
    modules: inventory.modules.length,
    members: bound.size,
    published: inventory.barrel.length,
    withheld: withheld.length,
    internal: inventory.modules
      .filter((module) => module.internal)
      .map((module) => ({ module: module.file, names: module.names, reason: module.reason })),
  };
}

/** One entry per failing class: what it finds, and the message its findings make. */
function rules(inventory) {
  return [
    {
      findings: () => unwiredMembers(inventory),
      message: (found) =>
        "module member(s) that no barrel entry re-exports — a consumer importing one reads `undefined` " +
        "under vitest, where only `tsc` (TS2305) says so:\n  " +
        found.map((entry) => `${entry.file}: ${entry.names.join(", ")}`).join("\n  ") +
        `\n  Add each to ${BARREL_FILE}, or name the module in INTERNAL_MODULES with its reason when ` +
        "the package does not publish it. A value is published under the name its module binds: " +
        "`export { x as y } from` publishes `y` where it is written and leaves `x` unpublished at " +
        "its origin — rename at the origin instead",
    },
    {
      findings: () => unprovidedBarrelNames(inventory),
      message: (found) =>
        "name(s) the barrel publishes that no module in the tree binds:\n  " +
        found.map((entry) => `${entry.file} publishes \`${entry.name}\``).join("\n  ") +
        "\n  Add the export to its module, or drop the entry",
    },
    {
      findings: () => unboundValues(inventory),
      message: (found) =>
        "name(s) the barrel publishes with a value no module binds under that name — the entry reads " +
        "`undefined` while another module binds the name, so only `tsc` (TS2305) disagrees:\n  " +
        found
          .map(
            (entry) =>
              `${entry.name}: the barrel's is ${String(entry.value)}; ${entry.modules.join(", ")} ` +
              `bind${entry.modules.length === 1 ? "s" : ""} it`,
          )
          .join("\n  ") +
        "\n  point the entry at the module that binds the value, or drop it",
    },
    {
      findings: () => collidingNames(inventory),
      message: (found) =>
        "name(s) two modules bind with values that are not the same:\n  " +
        found.map((entry) => `${entry.name}: ${entry.modules.join(", ")}`).join("\n  ") +
        "\n  one name must carry one value — re-export the same value, or give one module its own name",
    },
    {
      findings: () => misdeclaredModules(inventory),
      message: (found) =>
        "internal module(s) whose value the barrel publishes anyway:\n  " +
        found
          .map((entry) => `${entry.file}: ${entry.names.join(", ")} — ${entry.reason}`)
          .join("\n  ") +
        "\n  remove the entry, or take the module out of INTERNAL_MODULES",
    },
    {
      findings: () => staleDeclarations(inventory),
      message: (found) =>
        `INTERNAL_MODULES names module(s) the tree does not hold: ${found.join(", ")}` +
        "\n  remove the entry, or add the module back",
    },
  ];
}

/**
 * The gate: the star refusal first, then the classes above in order, and the report
 * a caller reads when none of them finds anything.
 */
export async function assertBarrelCoverage(
  root = process.cwd(),
  { internal = INTERNAL_MODULES } = {},
) {
  const refused = refusedEntries(root);
  if (refused.length > 0) {
    throw new ContractsBarrelError(
      "entry(s) in the barrel this gate cannot verify as values — a star entry publishes whatever its " +
        "module binds, so a name it adds is a member no line of this file reviewed and a declared-only " +
        "name gains a value binding that reads `undefined`, and an `export type` entry publishes no " +
        "value at all:\n  " +
        refused
          .map((entry) => `${BARREL_FILE}:${entry.line}: ${entry.text} (${entry.reason})`)
          .join("\n  ") +
        "\n  name each value, one line per name",
    );
  }
  const inventory = await valueInventory(root, { internal });
  for (const rule of rules(inventory)) {
    const found = rule.findings();
    if (found.length > 0) throw new ContractsBarrelError(rule.message(found));
  }
  return tally(inventory);
}
