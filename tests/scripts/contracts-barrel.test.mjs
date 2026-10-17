import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { ContractsBarrelError } from "../../scripts/contracts-barrel/errors.mjs";
import {
  INTERNAL_MARKER,
  barrelEntries,
  internalDeclaration,
  moduleSurface,
} from "../../scripts/contracts-barrel/surface.mjs";
import {
  BARREL_FILE,
  SRC_DIR,
  moduleFiles,
  readModuleFile,
  resolveModule,
} from "../../scripts/contracts-barrel/tree.mjs";
import {
  accountFor,
  assertBarrelCoverage,
  barrelInventory,
  misdeclaredModules,
  unprovidedBarrelNames,
  unwiredMembers,
} from "../../scripts/contracts-barrel/policy.mjs";

/**
 * The contracts barrel gate's own gate.
 *
 * A member the barrel does not re-export imports as `undefined` while the suite
 * stays green, so every rule that refuses it has to be shown refusing: the
 * derivation runs on the live tree, and each rule runs on a fixture tree of the
 * shape it exists for. The fixtures are deliberately hostile — a multi-line
 * template carrying a comment opener, a module in an extension the walk might not
 * know, a declaration smuggled inside a comment, the odd-but-valid declarations —
 * because a fixture that only writes the shapes the reader prefers tests the
 * reader against itself.
 */

/** A module description: the members it exports, and the declaration it may carry. */
const module_ = (name, members, internal = null) => ({ name, members, internal });

/** A module file in the package's own shape: its declaration, then one `export const` per member. */
const moduleSource = ({ members, internal = null }) =>
  (internal === null
    ? ""
    : `// ${INTERNAL_MARKER} ${internal.names.join(", ")}: ${internal.reason}\n`) +
  members.map((name) => `export const ${name} = 1;`).join("\n") +
  (members.length === 0 ? "" : "\n");

/** The barrel that publishes every member of every module, by explicit name. */
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

const ALPHA = module_("alpha", ["alphaOne", "alphaTwo"]);
const BETA = module_("beta", ["betaOne"]);

const trees = [];

/** A throwaway package tree, removed with the test that built it. */
function fixtureTree({ modules = [ALPHA, BETA], barrel = barrelSource(modules), files = {} } = {}) {
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

const names = (surface) => surface.members.map((member) => member.name);

describe("the module tree comes from disk, not from a list", () => {
  const root = process.cwd();

  it("reads every module file beside the barrel, the test files aside", () => {
    const files = moduleFiles(root);
    for (const file of [
      "packages/contracts/src/chat.ts",
      "packages/contracts/src/feedback.ts",
      "packages/contracts/src/trace.ts",
    ]) {
      expect(files).toContain(file);
    }
    expect(files).not.toContain(BARREL_FILE);
    expect(files.some((file) => /\.test\./.test(file))).toBe(false);
  });

  it("reads each module's own export statements, not a copy of them", () => {
    // The member the silent-`undefined` case was about: a scan that stopped seeing
    // `export const` would go green over exactly the gap this gate exists for.
    const chat = moduleSurface(readModuleFile(root, `${SRC_DIR}/chat.ts`), `${SRC_DIR}/chat.ts`);
    expect(names(chat)).toContain("CHAT_MESSAGE_MAX_LENGTH");
    const entries = barrelEntries(readModuleFile(root, BARREL_FILE), BARREL_FILE).filter(
      (entry) => entry.module === "./chat",
    );
    expect(entries.map((entry) => entry.provided)).toContain("CHAT_MESSAGE_MAX_LENGTH");
  });

  it("is green on the real tree, in both directions, with every member judged", () => {
    const inventory = barrelInventory(root);
    expect(unwiredMembers(inventory)).toEqual([]);
    expect(unprovidedBarrelNames(inventory)).toEqual([]);
    expect(misdeclaredModules(inventory)).toEqual([]);
    const accounting = accountFor(inventory);
    expect(accounting.unaccounted).toEqual([]);
    expect(accounting.published + accounting.withheld).toBe(accounting.extracted);
    const report = assertBarrelCoverage(root);
    expect(report.members).toBe(accounting.extracted);
    expect(report.published + report.withheld).toBe(report.members);
  });

  it("names the declarations the tree makes, member by member, each with its reason", () => {
    const report = assertBarrelCoverage(root);
    expect(report.internal.map((entry) => [entry.file, entry.names])).toEqual([
      ["packages/contracts/src/trace-product-rules.ts", ["productRulesEventSchema"]],
      [
        "packages/contracts/src/trace-source-routing.ts",
        ["sourceRoutingDetailSchema", "sourceRoutingEventSchema"],
      ],
    ]);
    for (const entry of report.internal) {
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.line).toBeGreaterThan(0);
    }
  });
});

describe("a member the barrel omits is refused, with the member and its module", () => {
  it("names the member and the module that owns it", () => {
    const modules = [ALPHA, BETA];
    const root = fixtureTree({ modules, barrel: barrelOmitting(modules, "alphaTwo") });
    expect(unwiredMembers(barrelInventory(root))).toEqual([
      { file: `${SRC_DIR}/alpha.ts`, reached: true, names: ["alphaTwo"] },
    ]);
    expect(refusal(() => assertBarrelCoverage(root))).toMatch(
      /packages\/contracts\/src\/alpha\.ts: alphaTwo/,
    );
  });

  it("refuses a chain of omissions across modules, naming each one", () => {
    const modules = [ALPHA, BETA];
    const root = fixtureTree({ modules, barrel: barrelOmitting(modules, "alphaTwo", "betaOne") });
    const message = refusal(() => assertBarrelCoverage(root));
    expect(message).toMatch(/alpha\.ts: alphaTwo/);
    expect(message).toMatch(/beta\.ts: betaOne/);
  });

  it("counts a member re-exported through another module as published to its owner", () => {
    // The barrel names `./gateway`, which carries the member over from `./origin`.
    const root = fixtureTree({
      modules: [ALPHA],
      files: {
        [`${SRC_DIR}/origin.ts`]: "export const carried = 1;\n",
        [`${SRC_DIR}/gateway.ts`]: 'export { carried } from "./origin";\n',
      },
      barrel: `${barrelSource([ALPHA])}export { carried } from "./gateway";\n`,
    });
    expect(unwiredMembers(barrelInventory(root))).toEqual([]);
    expect(refusal(() => assertBarrelCoverage(root))).toBe("");
  });

  it("counts a member imported and then re-exported as published to its origin too", () => {
    // `export { x }` of an imported name is the re-export edge it is — reading it
    // as a member with no origin reports `origin.ts` falsely.
    const root = fixtureTree({
      modules: [ALPHA],
      files: {
        [`${SRC_DIR}/origin.ts`]: "export const carried = 1;\n",
        [`${SRC_DIR}/gateway.ts`]: 'import { carried } from "./origin";\nexport { carried };\n',
      },
      barrel: `${barrelSource([ALPHA])}export { carried } from "./gateway";\n`,
    });
    expect(unwiredMembers(barrelInventory(root))).toEqual([]);
    expect(refusal(() => assertBarrelCoverage(root))).toBe("");
  });

  it("counts a member a module re-exports under another name as provided by it", () => {
    // The barrel names `renamed`, which only `gateway` provides, as `origin`'s
    // `carried` under another name.
    const root = fixtureTree({
      modules: [ALPHA],
      files: {
        [`${SRC_DIR}/origin.ts`]: "export const carried = 1;\n",
        [`${SRC_DIR}/gateway.ts`]: 'export { carried as renamed } from "./origin";\n',
      },
      barrel: `${barrelSource([ALPHA])}export { renamed } from "./gateway";\n`,
    });
    expect(unprovidedBarrelNames(barrelInventory(root))).toEqual([]);
    expect(unwiredMembers(barrelInventory(root))).toEqual([]);
    expect(refusal(() => assertBarrelCoverage(root))).toBe("");
  });
});

describe("a barrel name no module provides is refused", () => {
  it("names the entry and the module that provides no such name", () => {
    const root = fixtureTree({
      barrel: `${barrelSource([ALPHA, BETA])}export { ghost } from "./alpha";\n`,
    });
    expect(unprovidedBarrelNames(barrelInventory(root))).toEqual([
      expect.objectContaining({ provided: "ghost", exported: "ghost", module: "./alpha" }),
    ]);
    const message = refusal(() => assertBarrelCoverage(root));
    expect(message).toMatch(/ghost/);
    expect(message).toMatch(/alpha/);
  });

  it("names an entry whose module does not exist at all", () => {
    const root = fixtureTree({
      barrel: `${barrelSource([ALPHA, BETA])}export { alphaOne } from "./absent";\n`,
    });
    const message = refusal(() => assertBarrelCoverage(root));
    expect(message).toMatch(/alphaOne/);
    expect(message).toMatch(/absent/);
  });

  it("resolves the ESM spelling of a module the tree holds", () => {
    const root = fixtureTree({
      modules: [ALPHA],
      files: { [`${SRC_DIR}/mystery.mts`]: "export const mysteryOne = 1;\n" },
      barrel: `${barrelSource([ALPHA])}export { mysteryOne } from "./mystery.mjs";\n`,
    });
    expect(unprovidedBarrelNames(barrelInventory(root))).toEqual([]);
    expect(unwiredMembers(barrelInventory(root))).toEqual([]);
    expect(refusal(() => assertBarrelCoverage(root))).toBe("");
  });

  it("reads the entry as the barrel writes it: a type-only name is still a name", () => {
    const root = fixtureTree({
      barrel: `${barrelSource([ALPHA, BETA])}export { type alphaOne } from "./alpha";\n`,
    });
    expect(unprovidedBarrelNames(barrelInventory(root))).toEqual([]);
  });
});

describe("a module added after the gate is judged by it", () => {
  it("refuses a new module the barrel never mentions, naming its members", () => {
    const root = fixtureTree({
      files: { [`${SRC_DIR}/newcomer.ts`]: "export const freshExport = 1;\n" },
      barrel: barrelSource([ALPHA, BETA]),
    });
    expect(unwiredMembers(barrelInventory(root))).toEqual([
      { file: `${SRC_DIR}/newcomer.ts`, reached: false, names: ["freshExport"] },
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
      { file: `${SRC_DIR}/nested/newcomer.ts`, reached: false, names: ["deepExport"] },
    ]);
  });

  it("judges a module in every extension the package can hold", () => {
    // The extension test, not the walk, decided this before: `.mts`, `.cts` and
    // `.tsx` sat outside the universe and their members were invisible.
    for (const extension of [".mts", ".cts", ".tsx"]) {
      const root = fixtureTree({
        files: { [`${SRC_DIR}/mystery${extension}`]: "export const mysteryOne = 1;\n" },
      });
      expect(unwiredMembers(barrelInventory(root))).toEqual([
        { file: `${SRC_DIR}/mystery${extension}`, reached: false, names: ["mysteryOne"] },
      ]);
    }
  });

  it("leaves a module that publishes nothing alone: there is no member to read as undefined", () => {
    const root = fixtureTree({
      files: { [`${SRC_DIR}/skeleton.ts`]: 'import * as v from "valibot";\n' },
    });
    expect(unwiredMembers(barrelInventory(root))).toEqual([]);
    expect(refusal(() => assertBarrelCoverage(root))).toBe("");
  });
});

describe("the scan reads code, not prose, and refuses what it cannot see", () => {
  it("reads a real export below a multi-line template that carries a comment opener", () => {
    // The shape that used to blank everything below it: the template spans lines,
    // so the `/*` on its second line is text, not a comment.
    const source = [
      "const USAGE = `x",
      "packages/contracts/src/*",
      "`;",
      "export const invisible = 1;",
    ].join("\n");
    expect(names(moduleSurface(source, "template.ts"))).toEqual(["invisible"]);
    const root = fixtureTree({
      files: { [`${SRC_DIR}/template.ts`]: `${source}\n` },
    });
    expect(refusal(() => assertBarrelCoverage(root))).toMatch(
      /packages\/contracts\/src\/template\.ts: invisible/,
    );
  });

  it("reads a real export below a multi-line template without a comment opener", () => {
    const source = ["const USAGE = `line one", "line two", "`;", "export const real = 1;"].join(
      "\n",
    );
    expect(names(moduleSurface(source, "template.ts"))).toEqual(["real"]);
  });

  it("refuses a block comment that never closes, naming the line it opened on", () => {
    const message = refusal(() =>
      moduleSurface("const doc = 1; /* open\nexport const swallowed = 1;\n", "open.ts"),
    );
    expect(message).toMatch(/open\.ts:1/);
    expect(message).toMatch(/never closes/);
  });

  it("refuses a template literal that never closes, naming the line it opened on", () => {
    const message = refusal(() =>
      moduleSurface("const doc = `open\nexport const swallowed = 1;\n", "open.ts"),
    );
    expect(message).toMatch(/open\.ts:1/);
    expect(message).toMatch(/never closes/);
  });

  it("refuses an export keyword the scan read as quoted text", () => {
    // Quoted prose and a scan that mistook code for a literal read the same here,
    // and the second is the silence this gate exists to remove.
    expect(() =>
      moduleSurface('const doc = "export const ghost = 1;";\nexport const real = 1;\n'),
    ).toThrow(ContractsBarrelError);
    expect(() =>
      moduleSurface("const doc = `line one\nexport const ghost = 1;\n`;\nexport const real = 1;\n"),
    ).toThrow(ContractsBarrelError);
  });

  it("does not read an export keyword in a comment as a statement", () => {
    const commented = moduleSurface(
      "// export const ghost = 1;\n/**\n * export const alsoGhost = 1;\n */\nconst x = 1;\nexport { x };\n",
    );
    expect(names(commented)).toEqual(["x"]);
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

describe("a module is out of the public surface only on the record", () => {
  it("exempts the members a declaration names, and carries the reason", () => {
    const modules = [ALPHA, BETA];
    const root = fixtureTree({
      modules,
      files: {
        [`${SRC_DIR}/alpha.ts`]: `${moduleSource({
          members: ["alphaOne", "alphaTwo"],
          internal: { names: ["alphaTwo"], reason: "composed into beta's union" },
        })}\n`,
      },
      barrel: barrelOmitting(modules, "alphaTwo"),
    });
    expect(unwiredMembers(barrelInventory(root))).toEqual([]);
    const report = assertBarrelCoverage(root);
    expect(report.withheld).toBe(1);
    expect(report.internal).toEqual([
      expect.objectContaining({ file: `${SRC_DIR}/alpha.ts`, names: ["alphaTwo"] }),
    ]);
  });

  it("refuses a member added to a declared module without being named", () => {
    // The exemption answers for the members it names, so a new one cannot inherit it.
    const root = fixtureTree({
      modules: [ALPHA, BETA],
      files: {
        [`${SRC_DIR}/alpha.ts`]: `${moduleSource({
          members: ["alphaOne", "alphaTwo"],
          internal: { names: ["alphaOne"], reason: "one member is held back" },
        })}\n`,
      },
      barrel: `${barrelSource([BETA])}\n`,
    });
    expect(misdeclaredModules(barrelInventory(root))).toEqual([
      expect.objectContaining({ file: `${SRC_DIR}/alpha.ts`, unlisted: ["alphaTwo"] }),
    ]);
    expect(refusal(() => assertBarrelCoverage(root))).toMatch(/alphaTwo/);
  });

  it("refuses a declaration that names a member the module does not export", () => {
    const root = fixtureTree({
      files: {
        [`${SRC_DIR}/alpha.ts`]: `${moduleSource({
          members: ["alphaOne"],
          internal: { names: ["alphaGhost"], reason: "gone" },
        })}\n`,
      },
      barrel: barrelSource([ALPHA, BETA]),
    });
    expect(misdeclaredModules(barrelInventory(root))).toEqual([
      expect.objectContaining({ unknown: ["alphaGhost"] }),
    ]);
  });

  it("refuses a declaration that withholds a member the barrel publishes", () => {
    const root = fixtureTree({
      files: {
        [`${SRC_DIR}/alpha.ts`]: `${moduleSource({
          members: ["alphaOne"],
          internal: { names: ["alphaOne"], reason: "stale" },
        })}\n`,
      },
      barrel: barrelSource([ALPHA, BETA]),
    });
    expect(misdeclaredModules(barrelInventory(root))).toEqual([
      expect.objectContaining({ redundant: ["alphaOne"] }),
    ]);
  });

  it("does not accept a declaration smuggled inside a block comment or a template", () => {
    const smuggledInComment = [
      "/**",
      ` * // ${INTERNAL_MARKER} alphaOne: smuggled`,
      " */",
      "export const alphaOne = 1;",
    ].join("\n");
    expect(internalDeclaration(smuggledInComment, "alpha.ts")).toBe(null);
    const smuggledInTemplate = [
      "const usage = `",
      `// ${INTERNAL_MARKER} alphaOne: smuggled`,
      "`;",
      "export const alphaOne = 1;",
    ].join("\n");
    expect(internalDeclaration(smuggledInTemplate, "alpha.ts")).toBe(null);
    const root = fixtureTree({
      files: { [`${SRC_DIR}/alpha.ts`]: `${smuggledInComment}\n` },
      barrel: barrelSource([BETA]),
    });
    expect(refusal(() => assertBarrelCoverage(root))).toMatch(/alpha\.ts: alphaOne/);
  });

  it("refuses a declaration with no reason, no member, or a second one", () => {
    expect(() => internalDeclaration(`// ${INTERNAL_MARKER} alphaOne:\n`, "a.ts")).toThrow(
      ContractsBarrelError,
    );
    expect(() => internalDeclaration(`// ${INTERNAL_MARKER}: held back\n`, "a.ts")).toThrow(
      ContractsBarrelError,
    );
    expect(() =>
      internalDeclaration(
        `// ${INTERNAL_MARKER} a: one\n// ${INTERNAL_MARKER} b: two\nexport const a = 1;\n`,
        "a.ts",
      ),
    ).toThrow(ContractsBarrelError);
    expect(internalDeclaration(`// ${INTERNAL_MARKER} alphaOne: held back\n`)).toEqual({
      names: ["alphaOne"],
      reason: "held back",
      line: 1,
    });
  });
});

describe("the export statements are read as the modules write them", () => {
  const surface = moduleSurface(
    [
      "export function* generator() { yield 1; }",
      "export async function* asyncGenerator() { yield 1; }",
      "export const enum Colour { Red }",
      "export namespace Nested { export const inner = 1; }",
      "export const object = { export: 1 };",
      "export type Shape = { export: string };",
      'import { carried } from "./origin";',
      "export { carried };",
      'export { default as renamed } from "./other";',
      'export * as namespace from "./other";',
      'export * from "./other";',
    ].join("\n"),
    "shapes.ts",
  );

  it("reads a member out of every declaration shape", () => {
    expect(names(surface).sort()).toEqual(
      [
        // A nested export publishes into its namespace or object, not into the
        // module: `inner` and the `export` property are not members. A name carried
        // over from another module is an edge, not a member this module owns.
        "Colour",
        "Nested",
        "Shape",
        "asyncGenerator",
        "carried",
        "generator",
        "namespace",
        "object",
      ].sort(),
    );
  });

  it("reads a generator's name after the star, and a const enum's after `enum`", () => {
    const kindOf = (name) => surface.members.find((member) => member.name === name);
    expect(kindOf("generator").typeOnly).toBe(false);
    expect(kindOf("asyncGenerator").typeOnly).toBe(false);
    expect(kindOf("Colour").typeOnly).toBe(false);
    expect(kindOf("Shape").typeOnly).toBe(true);
  });

  it("reads the re-export edges, including a local binding's origin", () => {
    const shape = (edge) =>
      `${edge.from}|${edge.names === null ? "*" : edge.names.map((n) => `${n.provided}->${n.exported}`).join(",")}`;
    expect(surface.edges.map(shape).sort()).toEqual(
      ["./origin|carried->carried", "./other|default->renamed", "./other|*"].sort(),
    );
  });
});

describe("the extraction refuses to pass over nothing", () => {
  it("cannot be satisfied by a barrel the tree cannot resolve", () => {
    // The barrel's own entries are the proof that the walk read something: with no
    // modules, every entry is unprovided. No floor constant has to be raised as
    // the package grows.
    const root = fixtureTree({ modules: [], barrel: 'export { alphaOne } from "./alpha";\n' });
    expect(unprovidedBarrelNames(barrelInventory(root))).toHaveLength(1);
    expect(refusal(() => assertBarrelCoverage(root))).toMatch(/alphaOne/);
  });

  it("is green on a one-module package: the rules are relations, not totals", () => {
    const root = fixtureTree({ modules: [module_("alpha", ["alphaOne"])] });
    expect(refusal(() => assertBarrelCoverage(root))).toBe("");
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

  it("refuses a specifier that resolves to no module in the tree", () => {
    expect(resolveModule(new Map([["a/b.ts", {}]]), "a/x.ts", "./b")).toBe("a/b.ts");
    expect(resolveModule(new Map([["a/b.mts", {}]]), "a/x.ts", "./b.mjs")).toBe("a/b.mts");
    expect(resolveModule(new Map(), "a/x.ts", "./b")).toBe(null);
  });
});

describe("a barrel the gate cannot read is refused, not skimmed", () => {
  it("refuses `export *`, whose surface no rule here can see", () => {
    const root = fixtureTree({ barrel: 'export * from "./alpha";\n' });
    expect(refusal(() => assertBarrelCoverage(root))).toMatch(/alpha/);
    expect(refusal(() => barrelEntries('export * from "./alpha";\n', BARREL_FILE))).toMatch(
      /alpha/,
    );
  });

  it("refuses a name with no `from` clause, which no module can be held to", () => {
    expect(refusal(() => barrelEntries("export { stray };\n", BARREL_FILE))).toMatch(/stray/);
  });
});
