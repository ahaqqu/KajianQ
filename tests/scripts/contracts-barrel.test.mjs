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
  it("is green on the real tree, and reports what the runtime sees", async () => {
    const report = await assertBarrelCoverage(process.cwd());
    expect(report.modules).toBe(moduleFiles(process.cwd()).length);
    expect(report).toMatchObject({ members: 54, published: 54, withheld: 3 });
    expect(report.internal.map((entry) => entry.module)).toEqual(Object.keys(INTERNAL_MODULES));
    for (const entry of report.internal) expect(entry.reason.length).toBeGreaterThan(20);
    expect(moduleFiles(process.cwd())).toHaveLength(13);
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
    await expect(assertBarrelCoverage(root, { internal: {} })).rejects.toThrow(
      /Shared: .*a\.ts, .*b\.ts/,
    );
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
    expect(moduleFiles(root)).toEqual([
      `${SRC_DIR}/a.ts`,
      `${SRC_DIR}/c.cts`,
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
