import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  BARREL_FILE,
  INTERNAL_MARKER,
  MIN_BARREL_ENTRIES,
  MIN_MEMBERS,
  MIN_MODULES,
  SRC_DIR,
  ContractsBarrelError,
  assertBarrelCoverage,
  barrelEntries,
  barrelInventory,
  internalDeclaration,
  moduleFiles,
  moduleSurface,
  staleInternalDeclarations,
  unprovidedBarrelNames,
  unwiredMembers,
} from "../../scripts/contracts-barrel/policy.mjs";

/**
 * The contracts barrel gate's own gate.
 *
 * A member the barrel does not re-export imports as `undefined` while the suite
 * stays green, so every rule that refuses it has to be shown refusing: the
 * derivation runs on the live tree, and each rule runs on a fixture tree of the
 * shape it exists for — a member the barrel omits, a name no module provides, a
 * module added after the gate. A rule that cannot be made to redden here is a new
 * hole of the same class as the one this gate closes.
 */

/** A module file in the package's own shape: the marker it declares, one `export const` per member. */
const moduleSource = ({ members, internal = null }) =>
  (internal === null ? "" : `// ${INTERNAL_MARKER}: ${internal}\n`) +
  members.map((name) => `export const ${name} = 1;`).join("\n") +
  "\n";

/** The barrel that wires every member of every module, by explicit name. */
const barrelSource = (modules) =>
  modules
    .map(
      (module) =>
        `export {\n${module.members.map((name) => `  ${name},`).join("\n")}\n} from "./${module.name}";\n`,
    )
    .join("");

/** That barrel with members left out: the defect, and nothing else. */
const barrelOmitting = (modules, ...omitted) =>
  barrelSource(
    modules.map((module) => ({
      ...module,
      members: module.members.filter((name) => !omitted.includes(name)),
    })),
  );

/** A module tree above every floor the gate sets: `count` modules of `per` members each. */
const moduleTree = ({ count = 8, per = 8 } = {}) =>
  Array.from({ length: count }, (_, index) => ({
    name: `module-${index}`,
    members: Array.from({ length: per }, (_, member) => `member${index}_${member}`),
    internal: null,
  }));

const trees = [];

/** A throwaway package tree, removed with the test that built it. */
function fixtureTree({ modules = moduleTree(), barrel = barrelSource(modules), files = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "kajianq-contracts-barrel-"));
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write(BARREL_FILE, barrel);
  for (const module of modules) write(`${SRC_DIR}/${module.name}.ts`, moduleSource(module));
  for (const [path, text] of Object.entries(files)) write(path, text);
  trees.push(root);
  return root;
}

afterEach(() => {
  for (const root of trees.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The message the gate refuses with — what a maintainer reads instead of an empty diff. */
function refusal(run) {
  try {
    run();
    return "";
  } catch (error) {
    if (!(error instanceof ContractsBarrelError)) throw error;
    return error.message;
  }
}

describe("the module tree comes from disk, not from a list", () => {
  const root = process.cwd();

  it("reads every .ts module beside the barrel, the test files aside", () => {
    const files = moduleFiles(root);
    expect(files.length).toBeGreaterThanOrEqual(MIN_MODULES);
    for (const file of [
      "packages/contracts/src/chat.ts",
      "packages/contracts/src/feedback.ts",
      "packages/contracts/src/trace.ts",
    ]) {
      expect(files).toContain(file);
    }
    expect(files).not.toContain(BARREL_FILE);
    expect(files.some((file) => file.endsWith(".test.ts"))).toBe(false);
  });

  it("reads each module's own export statements, not a copy of them", () => {
    // The member the silent-`undefined` case was about: a scan that stopped seeing
    // `export const` would go green over exactly the gap this gate exists for.
    const chat = moduleSurface(
      readFileSync(resolve(root, `${SRC_DIR}/chat.ts`), "utf8"),
      `${SRC_DIR}/chat.ts`,
    );
    expect(chat.members.map((member) => member.name)).toContain("CHAT_MESSAGE_MAX_LENGTH");
    const chatEntries = barrelEntries(readFileSync(resolve(root, BARREL_FILE), "utf8")).filter(
      (entry) => entry.module === "./chat",
    );
    expect(chatEntries.map((entry) => entry.provided)).toContain("CHAT_MESSAGE_MAX_LENGTH");
  });

  it("is green on the real tree, in both directions", () => {
    const inventory = barrelInventory(root);
    expect(unwiredMembers(inventory)).toEqual([]);
    expect(unprovidedBarrelNames(inventory)).toEqual([]);
    const report = assertBarrelCoverage(root);
    expect(report.modules).toBeGreaterThanOrEqual(MIN_MODULES);
    expect(report.members).toBeGreaterThanOrEqual(MIN_MEMBERS);
    expect(report.entries).toBeGreaterThanOrEqual(MIN_BARREL_ENTRIES);
    expect(report.stale).toEqual([]);
  });

  it("names the internal declarations the tree makes, each with its reason", () => {
    const report = assertBarrelCoverage(root);
    expect(report.internal.map((entry) => entry.file)).toEqual([
      "packages/contracts/src/trace-product-rules.ts",
      "packages/contracts/src/trace-source-routing.ts",
    ]);
    for (const entry of report.internal) expect(entry.reason.length).toBeGreaterThan(0);
  });
});

describe("a member the barrel omits is refused, with the member and its module", () => {
  it("names the member and the module that owns it", () => {
    const modules = moduleTree();
    const root = fixtureTree({ modules, barrel: barrelOmitting(modules, "member0_7") });
    expect(unwiredMembers(barrelInventory(root))).toEqual([
      { file: `${SRC_DIR}/module-0.ts`, names: ["member0_7"] },
    ]);
    expect(refusal(() => assertBarrelCoverage(root))).toMatch(
      /packages\/contracts\/src\/module-0\.ts: member0_7/,
    );
  });

  it("refuses a chain of omissions across modules, naming each one", () => {
    const modules = moduleTree();
    const root = fixtureTree({
      modules,
      barrel: barrelOmitting(modules, "member0_7", "member3_0"),
    });
    const message = refusal(() => assertBarrelCoverage(root));
    expect(message).toMatch(/module-0\.ts: member0_7/);
    expect(message).toMatch(/module-3\.ts: member3_0/);
  });

  it("counts a member re-exported through another module as wired to whoever owns it", () => {
    // The barrel names `./gateway`, which carries the member over from `./origin`:
    // the import resolves, so the member is published.
    const root = fixtureTree({
      modules: moduleTree(),
      files: {
        [`${SRC_DIR}/origin.ts`]: "export const carried = 1;\n",
        [`${SRC_DIR}/gateway.ts`]: 'export { carried } from "./origin";\n',
      },
      barrel: `${barrelSource(moduleTree())}export { carried } from "./gateway";\n`,
    });
    expect(unwiredMembers(barrelInventory(root))).toEqual([]);
    expect(refusal(() => assertBarrelCoverage(root))).toBe("");
  });
});

describe("a barrel name no module provides is refused", () => {
  it("names the entry and the module that provides no such name", () => {
    const root = fixtureTree({
      barrel: `${barrelSource(moduleTree())}export { ghost } from "./module-0";\n`,
    });
    expect(unprovidedBarrelNames(barrelInventory(root))).toEqual([
      expect.objectContaining({ provided: "ghost", exported: "ghost", module: "./module-0" }),
    ]);
    const message = refusal(() => assertBarrelCoverage(root));
    expect(message).toMatch(/ghost/);
    expect(message).toMatch(/module-0/);
  });

  it("names an entry whose module does not exist at all", () => {
    const root = fixtureTree({
      barrel: `${barrelSource(moduleTree())}export { member0_0 } from "./absent";\n`,
    });
    const message = refusal(() => assertBarrelCoverage(root));
    expect(message).toMatch(/member0_0/);
    expect(message).toMatch(/absent/);
  });

  it("reads the entry as the barrel writes it: a type-only name is still a name", () => {
    const root = fixtureTree({
      barrel: `${barrelSource(moduleTree())}export { type member0_0 } from "./module-0";\n`,
    });
    expect(unprovidedBarrelNames(barrelInventory(root))).toEqual([]);
  });
});

describe("a module added after the gate is judged by it", () => {
  it("refuses a new module the barrel never mentions, naming its members", () => {
    const root = fixtureTree({
      files: { [`${SRC_DIR}/newcomer.ts`]: "export const freshExport = 1;\n" },
    });
    expect(unwiredMembers(barrelInventory(root))).toEqual([
      { file: `${SRC_DIR}/newcomer.ts`, names: ["freshExport"] },
    ]);
    expect(refusal(() => assertBarrelCoverage(root))).toMatch(
      /packages\/contracts\/src\/newcomer\.ts: freshExport/,
    );
  });

  it("judges a module in a subdirectory too, since the walk is the tree and not a list", () => {
    const root = fixtureTree({
      files: { [`${SRC_DIR}/nested/newcomer.ts`]: "export const deepExport = 1;\n" },
    });
    expect(unwiredMembers(barrelInventory(root))).toEqual([
      { file: `${SRC_DIR}/nested/newcomer.ts`, names: ["deepExport"] },
    ]);
  });

  it("leaves a module that publishes nothing alone: there is no member to read as undefined", () => {
    const root = fixtureTree({
      files: { [`${SRC_DIR}/skeleton.ts`]: 'import * as v from "valibot";\n' },
    });
    expect(unwiredMembers(barrelInventory(root))).toEqual([]);
    expect(refusal(() => assertBarrelCoverage(root))).toBe("");
  });
});

describe("a module is out of the public surface only on the record", () => {
  it("exempts a module that declares itself internal, and carries the reason", () => {
    const modules = moduleTree();
    modules[0].internal = "composed into module-1's union; a reader parses that, not this";
    const root = fixtureTree({ modules, barrel: barrelOmitting(modules, "member0_7") });
    expect(unwiredMembers(barrelInventory(root))).toEqual([]);
    const report = assertBarrelCoverage(root);
    expect(report.internal).toEqual([
      { file: `${SRC_DIR}/module-0.ts`, reason: modules[0].internal },
    ]);
  });

  it("does not exempt a declaration that carries no reason", () => {
    const modules = moduleTree();
    modules[0].internal = "";
    const root = fixtureTree({ modules, barrel: barrelOmitting(modules, "member0_7") });
    expect(refusal(() => assertBarrelCoverage(root))).toMatch(
      /packages\/contracts\/src\/module-0\.ts: member0_7/,
    );
    expect(internalDeclaration(`// ${INTERNAL_MARKER}:\n`)).toBe(null);
    expect(internalDeclaration(`// ${INTERNAL_MARKER}\n`)).toBe(null);
    expect(internalDeclaration(`// ${INTERNAL_MARKER}: on the record\n`)).toEqual({
      reason: "on the record",
    });
  });

  it("notes a declaration that gates nothing rather than failing a file into a corner", () => {
    // A marker on a module the barrel publishes in full: declaring is the cheap
    // remedy for a module the rules cannot tell from a published one, so a marker
    // that turns out stale is a note — and the note is what says it is stale.
    const modules = moduleTree();
    modules[2].internal = "stale";
    const root = fixtureTree({ modules });
    const inventory = barrelInventory(root);
    expect(unwiredMembers(inventory)).toEqual([]);
    expect(staleInternalDeclarations(inventory)).toEqual([
      { file: `${SRC_DIR}/module-2.ts`, reason: "stale" },
    ]);
    expect(assertBarrelCoverage(root).stale).toHaveLength(1);
  });
});

describe("the export statements are read as the modules write them", () => {
  const surface = moduleSurface(
    [
      "export const a = 1, b = 2;",
      "export let c = 3;",
      "export function fn(value) { return value; }",
      "export async function afn() {}",
      "export class Klass {}",
      "export enum En { A }",
      "export interface Iface {}",
      "export type Alias = string;",
      "export type Generic<A, B> = [A, B];",
      "export const typed: Record<string, number> = {};",
      'export const fromString = "x, b = 2";',
      "export const object = { a: 1, b: 2 };",
      "const hidden = 1;",
      "export { hidden, hidden as shown };",
      'export { imported } from "./other";',
      'export { type OnlyType } from "./other";',
      'export type { AnotherType } from "./other";',
      'export * from "./other";',
      'export * as namespace from "./other";',
      "export default 1;",
    ].join("\n"),
    "shapes.ts",
  );

  it("reads a member out of every declaration shape", () => {
    const names = surface.members.map((member) => member.name).sort();
    expect(names).toEqual(
      [
        "Alias",
        "En",
        "Generic",
        "Iface",
        "Klass",
        "a",
        "afn",
        "b",
        "c",
        "default",
        "fn",
        "fromString",
        "hidden",
        "namespace",
        "object",
        "shown",
        "typed",
      ].sort(),
    );
  });

  it("reads what each name is: a type-only export is not a value", () => {
    const kindOf = (name) => surface.members.find((member) => member.name === name).typeOnly;
    expect(kindOf("Alias")).toBe(true);
    expect(kindOf("Iface")).toBe(true);
    expect(kindOf("a")).toBe(false);
    // A generic alias's own commas are not declarator boundaries.
    expect(kindOf("Generic")).toBe(true);
  });

  it("reads a re-export as the edge it is, and a local binding export as a member", () => {
    expect(surface.edges.map((edge) => ({ from: edge.from, names: edge.names }))).toEqual([
      { from: "./other", names: [{ provided: "imported", exported: "imported", typeOnly: false }] },
      { from: "./other", names: [{ provided: "OnlyType", exported: "OnlyType", typeOnly: true }] },
      {
        from: "./other",
        names: [{ provided: "AnotherType", exported: "AnotherType", typeOnly: true }],
      },
      { from: "./other", names: null },
    ]);
  });

  it("does not read an export keyword in a comment as a statement", () => {
    const commented = moduleSurface(
      "// export const ghost = 1;\n/**\n * export const alsoGhost = 1;\n */\nconst x = 1;\nexport { x };\n",
    );
    expect(commented.members.map((member) => member.name)).toEqual(["x"]);
  });

  it("refuses a module whose text quotes an export keyword, since a mis-read hides a statement", () => {
    // Quoted prose and a scan that mistook code for a literal read the same here,
    // and the second is the silence this gate exists to remove — so it refuses
    // rather than reading past the line.
    expect(() =>
      moduleSurface('const doc = "export const ghost = 1;";\nexport const real = 1;\n'),
    ).toThrow(ContractsBarrelError);
    expect(() => moduleSurface("const doc = `export const ghost = 1;`;\n")).toThrow(
      ContractsBarrelError,
    );
  });

  it("refuses a statement shape it cannot read, instead of reading past it", () => {
    expect(() => moduleSurface("export const { a, b } = pair;\n")).toThrow(ContractsBarrelError);
    expect(() => moduleSurface("export const a = 1\n")).toThrow(ContractsBarrelError);
    expect(() => moduleSurface("export ")).toThrow(ContractsBarrelError);
    expect(() => moduleSurface('export { "a-b" as x } from "./other";\n')).toThrow(
      ContractsBarrelError,
    );
    expect(() => moduleSurface('export { a as b from "./other";\n')).toThrow(ContractsBarrelError);
  });
});

describe("the extraction refuses to pass over nothing", () => {
  it("refuses a module tree short of the floors, rather than checking nothing", () => {
    const fewModules = fixtureTree({ modules: moduleTree({ count: 2, per: 2 }) });
    expect(refusal(() => assertBarrelCoverage(fewModules))).toMatch(/module/);
    const fewMembers = fixtureTree({ modules: moduleTree({ count: 8, per: 3 }) });
    expect(refusal(() => assertBarrelCoverage(fewMembers))).toMatch(/member/);
    const fewEntries = fixtureTree({
      modules: moduleTree(),
      barrel: barrelSource(moduleTree().slice(0, 1)),
    });
    expect(refusal(() => assertBarrelCoverage(fewEntries))).toMatch(/re-exported name/);
  });

  it("refuses a root with no module tree to read", () => {
    const empty = mkdtempSync(join(tmpdir(), "kajianq-contracts-barrel-empty-"));
    trees.push(empty);
    expect(refusal(() => assertBarrelCoverage(empty))).toMatch(/packages\/contracts\/src/);
  });

  it("refuses a tree whose barrel is missing, naming it", () => {
    const root = fixtureTree();
    rmSync(resolve(root, BARREL_FILE));
    expect(refusal(() => assertBarrelCoverage(root))).toMatch(/index\.ts/);
  });
});

describe("a barrel the gate cannot read is refused, not skimmed", () => {
  it("refuses `export *`, whose surface no rule here can see", () => {
    const root = fixtureTree({ barrel: 'export * from "./module-0";\n' });
    expect(refusal(() => assertBarrelCoverage(root))).toMatch(/module-0/);
    expect(refusal(() => barrelEntries('export * from "./module-0";\n'))).toMatch(/module-0/);
  });

  it("refuses a name with no `from` clause, which no module can be held to", () => {
    expect(refusal(() => barrelEntries("export { stray };\n"))).toMatch(/stray/);
  });
});
