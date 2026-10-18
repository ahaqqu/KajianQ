import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { ContractsBarrelError } from "../../scripts/contracts-barrel/errors.mjs";
import { BARREL_FILE, SRC_DIR, moduleFiles } from "../../scripts/contracts-barrel/tree.mjs";
import {
  INTERNAL_MODULES,
  assertBarrelCoverage,
  collidingNames,
  misdeclaredModules,
  staleDeclarations,
  starEntries,
  tally,
  unprovidedBarrelNames,
  unwiredMembers,
  valueInventory,
} from "../../scripts/contracts-barrel/policy.mjs";

/**
 * The contracts barrel gate's own gate.
 *
 * A member the barrel does not re-export reaches a consumer as `undefined` while
 * the suite stays green — only `tsc` disagrees, as TS2305, one gate later and in
 * another tool. The gate imports the barrel and every module and compares the
 * value names each module exports with the keys the barrel publishes, so these
 * tests build real trees on disk and read them the way the gate does: by import.
 */

const roots = [];

/** A package tree on disk, importable as the gate imports the real one. */
function fixtureTree(files) {
  const root = mkdtempSync(join(tmpdir(), "contracts-barrel-"));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const oneModule = (exports, barrel) =>
  fixtureTree({ [`${SRC_DIR}/mod.ts`]: exports, [BARREL_FILE]: barrel });

describe("the runtime is the truth: the barrel publishes what the tree exports", () => {
  it("is green on the real tree, and every count there is an invariant", async () => {
    const report = await assertBarrelCoverage(process.cwd());
    expect(report.modules).toBe(moduleFiles(process.cwd()).length);
    expect(report.modules).toBeGreaterThan(0);
    // Every value the tree binds is published and every published name is bound:
    // the counts agree because they are the same set, not because of a snapshot.
    expect(report.members).toBe(report.published);
    // The withheld names are exactly the table's, module by module, each with its reason.
    const declared = Object.keys(INTERNAL_MODULES).sort();
    expect(report.internal.map((entry) => entry.module).sort()).toEqual(declared);
    expect(report.withheld).toBe(
      report.internal.reduce((total, entry) => total + entry.names.length, 0),
    );
    for (const entry of report.internal) expect(entry.reason.length).toBeGreaterThan(20);
    expect(moduleFiles(process.cwd())).not.toContain(BARREL_FILE);
  });

  it("refuses a module value the barrel omits, naming the member and the module", async () => {
    const root = oneModule(
      "export const Published = 1;\nexport const Hidden = 2;\n",
      'export { Published } from "./mod";\n',
    );
    const inventory = await valueInventory(root, { internal: {} });
    expect(unwiredMembers(inventory)).toEqual([{ file: `${SRC_DIR}/mod.ts`, names: ["Hidden"] }]);
    const message = await assertBarrelCoverage(root, { internal: {} }).catch(
      (error) => error.message,
    );
    expect(message).toMatch(/mod\.ts: Hidden/);
    expect(message).toMatch(/undefined/);
    expect(message).toMatch(/INTERNAL_MODULES/);
  });

  it("refuses a star entry in the barrel, with its line, instead of publishing what it binds", async () => {
    const root = oneModule(
      "export const Named = 1;\nexport declare const DeclaredOnly: number;\n",
      'export * from "./mod";\n',
    );
    expect(starEntries(root)).toEqual([{ line: 1, text: 'export * from "./mod";' }]);
    const message = await assertBarrelCoverage(root, { internal: {} }).catch(
      (error) => error.message,
    );
    expect(message).toMatch(/index\.ts:1: export \* from "\.\/mod";/);
    expect(message).toMatch(/name each entry, one line per name/);
    expect(message).toMatch(/declared-only value/);
  });

  it("refuses `export * as` too, since a namespace name is still one no line reviewed", async () => {
    const root = oneModule("export const Named = 1;\n", 'export * as mod from "./mod";\n');
    const message = await assertBarrelCoverage(root, { internal: {} }).catch(
      (error) => error.message,
    );
    expect(message).toMatch(/index\.ts:1: export \* as mod from "\.\/mod";/);
  });

  it("is green when the barrel names every value, which is the only form it accepts", async () => {
    const root = oneModule(
      "export const Named = 1;\nexport declare const DeclaredOnly: number;\n",
      'export { Named } from "./mod";\n',
    );
    expect(starEntries(root)).toEqual([]);
    await expect(assertBarrelCoverage(root, { internal: {} })).resolves.toMatchObject({
      members: 1,
      published: 1,
    });
  });

  it("refuses a barrel name no module in the tree exports", async () => {
    const root = oneModule(
      "export const Published = 1;\n",
      'export { Published, Ghost } from "./mod";\n',
    );
    const inventory = await valueInventory(root, { internal: {} });
    expect(unprovidedBarrelNames(inventory)).toEqual([{ file: BARREL_FILE, name: "Ghost" }]);
    await expect(assertBarrelCoverage(root, { internal: {} })).rejects.toThrow(/publishes `Ghost`/);
  });

  it("refuses a barrel entry whose module does not exist, with the loader's own message", async () => {
    const root = fixtureTree({ [BARREL_FILE]: 'export { Nope } from "./missing";\n' });
    const message = await assertBarrelCoverage(root, { internal: {} }).catch(
      (error) => error.message,
    );
    expect(message).toMatch(/index\.ts does not import/);
    expect(message).toMatch(/Cannot find module/);
    expect(message).toMatch(/\.\/missing/);
  });

  it("refuses a module added after the gate, because the walk is the tree", async () => {
    const root = oneModule("export const A = 1;\n", 'export { A } from "./mod";\n');
    await expect(assertBarrelCoverage(root, { internal: {} })).resolves.toMatchObject({
      modules: 1,
    });
    writeFileSync(join(root, `${SRC_DIR}/late.ts`), "export const Late = 2;\n");
    await expect(assertBarrelCoverage(root, { internal: {} })).rejects.toThrow(/late\.ts: Late/);
  });

  it("leaves a module with no value export alone: there is nothing a consumer reads as undefined", async () => {
    const root = oneModule("export type Shape = { readonly a: string };\n", "");
    await expect(assertBarrelCoverage(root, { internal: {} })).resolves.toMatchObject({
      modules: 1,
      members: 0,
      published: 0,
      withheld: 0,
    });
  });

  it("refuses a module that throws on import, naming it", async () => {
    const root = oneModule('throw new Error("boom on import");\n', "");
    const message = await assertBarrelCoverage(root, { internal: {} }).catch(
      (error) => error.message,
    );
    expect(message).toMatch(/mod\.ts does not import: boom on import/);
  });

  it("refuses one name two modules export with values that are not the same", async () => {
    const root = fixtureTree({
      [`${SRC_DIR}/a.ts`]: "export const Shared = 1;\n",
      [`${SRC_DIR}/b.ts`]: "export const Shared = 2;\nexport const Other = 3;\n",
      [BARREL_FILE]: 'export { Shared } from "./a";\nexport { Other } from "./b";\n',
    });
    const inventory = await valueInventory(root, { internal: {} });
    expect(collidingNames(inventory)).toEqual([
      { name: "Shared", modules: [`${SRC_DIR}/a.ts`, `${SRC_DIR}/b.ts`] },
    ]);
    const message = await assertBarrelCoverage(root, { internal: {} }).catch(
      (error) => error.message,
    );
    expect(message).toMatch(/Shared: .*a\.ts, .*b\.ts/);
    expect(message).toMatch(/one name must carry one value/);
  });

  it("refuses a renamed re-export, because a value is published under the name its module binds", async () => {
    // `b.ts` binds `Renamed`; `a.ts` still binds `Shared`, which no entry publishes.
    // The runtime sees values and not specifiers, so the rename belongs at the origin.
    const root = fixtureTree({
      [`${SRC_DIR}/a.ts`]: "export const Shared = 1;\n",
      [`${SRC_DIR}/b.ts`]: 'export { Shared as Renamed } from "./a";\n',
      [BARREL_FILE]: 'export { Renamed } from "./b";\n',
    });
    const message = await assertBarrelCoverage(root, { internal: {} }).catch(
      (error) => error.message,
    );
    expect(message).toMatch(/a\.ts: Shared/);
    expect(message).toMatch(/is published under the name its module binds/);
    expect(message).toMatch(/rename at the origin/);
  });

  it("reads a re-export of the same value as one origin, not a collision", async () => {
    const root = fixtureTree({
      [`${SRC_DIR}/a.ts`]: "export const Shared = 1;\n",
      [`${SRC_DIR}/b.ts`]: 'export { Shared } from "./a";\nexport const Other = 2;\n',
      [BARREL_FILE]: 'export { Shared } from "./a";\nexport { Other } from "./b";\n',
    });
    await expect(assertBarrelCoverage(root, { internal: {} })).resolves.toMatchObject({
      members: 2,
      published: 2,
    });
  });

  it("refuses a value the barrel publishes from a module it declares internal", async () => {
    const internal = { [`${SRC_DIR}/variant.ts`]: "composed into the union, never parsed by name" };
    const root = fixtureTree({
      [`${SRC_DIR}/variant.ts`]: "export const variantSchema = 1;\n",
      [BARREL_FILE]: 'export { variantSchema } from "./variant";\n',
    });
    const inventory = await valueInventory(root, { internal });
    expect(misdeclaredModules(inventory)).toEqual([
      {
        file: `${SRC_DIR}/variant.ts`,
        names: ["variantSchema"],
        reason: internal[`${SRC_DIR}/variant.ts`],
      },
    ]);
    const message = await assertBarrelCoverage(root, { internal }).catch((error) => error.message);
    expect(message).toMatch(/variant\.ts: variantSchema — composed into the union/);
    expect(message).toMatch(/remove the entry, or take the module out of INTERNAL_MODULES/);
  });

  it("refuses an internal table entry whose module the tree does not hold", async () => {
    const internal = { [`${SRC_DIR}/gone.ts`]: "a module this tree does not hold" };
    const root = oneModule("export const A = 1;\n", 'export { A } from "./mod";\n');
    const inventory = await valueInventory(root, { internal });
    expect(staleDeclarations(inventory)).toEqual([`${SRC_DIR}/gone.ts`]);
    await expect(assertBarrelCoverage(root, { internal })).rejects.toThrow(
      /INTERNAL_MODULES names module\(s\) the tree does not hold: packages\/contracts\/src\/gone\.ts/,
    );
  });

  it("refuses a tree with no src directory rather than reading it as empty", async () => {
    const root = fixtureTree({ "README.md": "no modules here\n" });
    await expect(assertBarrelCoverage(root, { internal: {} })).rejects.toThrow(
      /no packages\/contracts\/src under/,
    );
    await expect(assertBarrelCoverage(root, { internal: {} })).rejects.toBeInstanceOf(
      ContractsBarrelError,
    );
  });
});

describe("a statement the text scanners could not read cannot hide a value", () => {
  it("reads `debugger`, a type tail and a line-leading regex — green by construction", async () => {
    // The shapes that defeated the text scanners: a statement ends the line before,
    // and a `/` opens there. The loader reads the module's namespace, so both
    // exports are keys regardless of what a tokeniser would have made of the line.
    const source = [
      "export const first = 1;",
      "debugger",
      '/\\/*x/.test("x");',
      "type Tail = string",
      '/\\/*x/.test("y");',
      "export const second = 2;",
    ].join("\n");
    const root = oneModule(`${source}\n`, 'export { first, second } from "./mod";\n');
    const inventory = await valueInventory(root, { internal: {} });
    expect(inventory.modules[0].names).toEqual(["first", "second"]);
    await expect(assertBarrelCoverage(root, { internal: {} })).resolves.toMatchObject({
      members: 2,
      published: 2,
    });
    // and the omission of one of them is still a red gate, naming it
    const partial = oneModule(`${source}\n`, 'export { first } from "./mod";\n');
    await expect(assertBarrelCoverage(partial, { internal: {} })).rejects.toThrow(
      /mod\.ts: second/,
    );
  });
});

describe("the tree walk is the tree", () => {
  it("imports a `.mts` module and judges it like any other", async () => {
    const root = fixtureTree({
      [`${SRC_DIR}/esm.mts`]: "export const EsmOnly = 1;\n",
      [BARREL_FILE]: "",
    });
    await expect(assertBarrelCoverage(root, { internal: {} })).rejects.toThrow(/esm\.mts: EsmOnly/);
  });

  it("reads every module file beside the barrel, tests aside, in every extension", () => {
    const root = fixtureTree({
      [`${SRC_DIR}/a.ts`]: "export const A = 1;",
      [`${SRC_DIR}/nested/b.mts`]: "export const B = 2;",
      [`${SRC_DIR}/c.cts`]: "export const C = 3;",
      [`${SRC_DIR}/d.tsx`]: "export const D = 4;",
      [`${SRC_DIR}/skipped.test.ts`]: "export const Test = 5;",
      [`${SRC_DIR}/declared.d.ts`]: "export declare const Declared: 1;",
      [BARREL_FILE]: "",
    });
    // `.cts` is outside the ESM surface the barrel can name, and a declaration file
    // carries no runtime value, so neither is a module this gate imports.
    expect(moduleFiles(root)).toEqual([
      `${SRC_DIR}/a.ts`,
      `${SRC_DIR}/d.tsx`,
      `${SRC_DIR}/nested/b.mts`,
    ]);
  });

  it("judges a module in a subdirectory, since the walk is the tree and not a list", async () => {
    const root = fixtureTree({
      [`${SRC_DIR}/nested/late.ts`]: "export const Nested = 1;\n",
      [BARREL_FILE]: "",
    });
    await expect(assertBarrelCoverage(root, { internal: {} })).rejects.toThrow(
      /nested\/late\.ts: Nested/,
    );
  });

  it("counts what it judged, so a green report is never empty", async () => {
    const root = oneModule(
      "export const A = 1;\nexport const B = 2;\n",
      'export { A, B } from "./mod";\n',
    );
    expect(tally(await valueInventory(root, { internal: {} }))).toMatchObject({
      modules: 1,
      members: 2,
      published: 2,
      withheld: 0,
    });
  });
});
