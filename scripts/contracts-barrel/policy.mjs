import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ContractsBarrelError } from "./errors.mjs";
import { BARREL_FILE, moduleFiles } from "./tree.mjs";

/**
 * The contracts barrel gate: what the runtime publishes, against what the tree
 * provides.
 *
 * A member the barrel omits reaches a consumer as `undefined` while the suite
 * stays green — only `tsc` disagrees, as TS2305, one gate later and in another
 * tool. `CHAT_MESSAGE_MAX_LENGTH` reached `main` that way.
 *
 * This gate asks the runtime instead of reading text. It imports the barrel and
 * every module in the tree and compares the *value* exports each module provides
 * with the keys the barrel publishes: `Object.keys` of a module namespace is
 * exactly the set of names a consumer can read, so no regex, `debugger`
 * statement, template or line-leading `/` can hide one from a loader. The rules:
 *
 *   - a value a module exports and the barrel does not publish is unwired, and is
 *     reported with its member and its module;
 *   - a name the barrel publishes that no module in the tree exports is reported
 *     with the entry;
 *   - a name two modules export with values that are not the same object is a
 *     collision: a name has one origin, and a re-export of the same value is not
 *     a second one;
 *   - a module named in `INTERNAL_MODULES` with its reason must publish nothing;
 *     a module in the tree and not named there must have every value published,
 *     so a module added after this gate cannot go unjudged;
 *   - an `INTERNAL_MODULES` entry whose module the tree does not hold is stale.
 *
 * Two limits, and only these: a type-only export is not a runtime key, and is
 * loud at the type level instead (a consumer's import is TS2305), so this gate
 * does not claim it; and a module that throws on import is a refusal, not a green,
 * with the module's own error surfaced.
 *
 * An exemption is a row in `INTERNAL_MODULES`, not a comment in a source file: a
 * comment a scanner reads is the guessing this gate exists to remove, and a table
 * is exact, reviewable, and cannot be hidden inside a string.
 */
export const INTERNAL_MODULES = {
  "packages/contracts/src/trace-product-rules.ts":
    "composed into the TraceEvent union in ./trace-events.ts — a reader parses that union and branches on `kind`, never on a variant module",
  "packages/contracts/src/trace-source-routing.ts":
    "composed into the TraceEvent union in ./trace-events.ts and spread into chat's trace frame in ./chat.ts — both publish the fields inline, so no consumer parses these schemas by name",
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
 * Every module file with the value names it exports, and the barrel's published
 * names — the two facts the rules compare. A module that throws is refused here.
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
  const barrel = Object.keys(await loadModule(root, BARREL_FILE));
  return { modules, barrel, internal };
}

/** The modules that export each name, non-internal only — the package's own surface. */
export function providers(inventory) {
  return providersOf(inventory.modules.filter((module) => !module.internal));
}

/** The modules that export each name, internal ones included: a published name must be provided. */
function anyProviders(inventory) {
  return providersOf(inventory.modules);
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

/** Every value a module exports that no barrel entry publishes. */
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

/** Every name the barrel publishes that no module in the tree exports. */
export function unprovidedBarrelNames(inventory) {
  const exported = anyProviders(inventory);
  return inventory.barrel
    .filter((name) => !exported.has(name))
    .map((name) => ({ file: BARREL_FILE, name }));
}

/** Every name two modules export with values that are not the same object. */
export function collidingNames(inventory) {
  const exported = providers(inventory);
  const collisions = [];
  for (const name of inventory.barrel) {
    const list = exported.get(name) ?? [];
    if (list.length < 2) continue;
    const [first] = list;
    if (list.some((module) => module.values[name] !== first.values[name])) {
      collisions.push({ name, modules: list.map((module) => module.file) });
    }
  }
  return collisions;
}

/** A module declared internal that publishes a value the barrel publishes anyway. */
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

/** The count a reader gets: what the tree provides, what the barrel publishes. */
export function tally(inventory) {
  const exported = providers(inventory);
  const withheld = inventory.modules
    .filter((module) => module.internal)
    .flatMap((module) => module.names);
  return {
    modules: inventory.modules.length,
    members: exported.size,
    published: inventory.barrel.length,
    withheld: withheld.length,
    internal: inventory.modules
      .filter((module) => module.internal)
      .map((module) => ({ module: module.file, names: module.names, reason: module.reason })),
  };
}

/**
 * The gate: every rule above, and the report a caller reads. Each finding is part
 * of one message, so a caller sees all of them at once rather than one per run.
 */
export async function assertBarrelCoverage(
  root = process.cwd(),
  { internal = INTERNAL_MODULES } = {},
) {
  const inventory = await valueInventory(root, { internal });
  const findings = [];
  for (const entry of unwiredMembers(inventory)) {
    findings.push(`${entry.file}: ${entry.names.join(", ")}`);
  }
  if (findings.length > 0) {
    throw new ContractsBarrelError(
      `module member(s) that no barrel entry re-exports — a consumer importing one reads \`undefined` +
        "` under vitest, where only `tsc` (TS2305) says so:\n  " +
        findings.join("\n  ") +
        `\n  Add each to ${BARREL_FILE}, or name the module in INTERNAL_MODULES with its reason when ` +
        "the package does not publish it",
    );
  }
  for (const entry of unprovidedBarrelNames(inventory)) {
    findings.push(`${entry.file} publishes \`${entry.name}\``);
  }
  if (findings.length > 0) {
    throw new ContractsBarrelError(
      `name(s) the barrel publishes that no module in the tree exports:\n  ${findings.join("\n  ")}` +
        "\n  Add the export to its module, or drop the entry",
    );
  }
  for (const entry of collidingNames(inventory)) {
    findings.push(`${entry.name}: ${entry.modules.join(", ")}`);
  }
  if (findings.length > 0) {
    throw new ContractsBarrelError(
      `name(s) two modules export with values that are not the same:\n  ${findings.join("\n  ")}` +
        "\n  a name has one origin — re-export the same value, or give one module its own name",
    );
  }
  for (const entry of misdeclaredModules(inventory)) {
    findings.push(`${entry.file}: ${entry.names.join(", ")} — ${entry.reason}`);
  }
  if (findings.length > 0) {
    throw new ContractsBarrelError(
      `internal module(s) whose value the barrel publishes anyway:\n  ${findings.join("\n  ")}` +
        "\n  remove the entry, or take the module out of INTERNAL_MODULES",
    );
  }
  const stale = staleDeclarations(inventory);
  if (stale.length > 0) {
    throw new ContractsBarrelError(
      `INTERNAL_MODULES names module(s) the tree does not hold: ${stale.join(", ")}` +
        "\n  remove the entry, or add the module back",
    );
  }
  return tally(inventory);
}
