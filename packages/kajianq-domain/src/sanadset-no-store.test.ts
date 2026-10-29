import { describe, expect, it } from "vite-plus/test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The invariant this file protects: **the S1 study constructs no database client, writes
 * no store row, and touches no object store.**
 *
 * The failure mode is silent. Nothing in the study *needs* a store, so a single added
 * import — a shared helper from `@app/infra`, a convenience barrel, a `DATABASE_URL`
 * read — would give the study a connection path, and the run would still look correct
 * while its "no writes" claim became false. The evidence below is the import graph the
 * CLI actually loads, walked statically, plus a source scan that no file in that graph
 * can even name the store entry points.
 *
 * The walker parses every form a module can use to load another one: `import x from`
 * (static named/default/star, re-export), `import "x"` (bare side effect),
 * `import("x")` and `require("x")`. Three rules keep it from passing on a graph it did not
 * really see:
 *
 * - an unresolved relative or `@app/…` specifier **throws** — a broken edge is a broken
 *   graph, not an external dependency;
 * - a non-literal `import(…)` or `require(…)` throws for the same reason: the walker
 *   cannot prove what it loads;
 * - a `createRequire` call throws: it builds a loader whose specifier no static walk can
 *   follow.
 *
 * A trap is built in: the walker asserts it found the study's own modules, so a resolver
 * that silently found nothing cannot pass the suite by being empty. The fixture suite
 * pins the negative space — a bare `@app/infra` import, a relative `.js` hop into
 * `@app/infra`, a literal `require` and a literal dynamic `import` of `@app/infra`, an
 * unresolved relative specifier, a computed `import`, a computed `require` and a
 * `createRequire` loader each have a fixture whose walk must see the violation or fail,
 * beside a clean control that must stay green.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI_ENTRY = join(REPO, "packages/kajianq-domain/scripts/sanadset-study.mjs");
const PUBLIC_BARREL = join(REPO, "packages/kajianq-domain/src/sanadset.ts");
/** Deliberately hostile modules: their only job is to make a silent walk fail a test. */
const FIXTURES = join(REPO, "packages/kajianq-domain/src/fixtures/sanadset-no-store");

/** Packages that can construct a database client or an object-store client. */
const DENIED_SPECIFIERS = [
  "pg",
  "postgres",
  "drizzle-orm",
  "@aws-sdk/client-s3",
  "better-sqlite3",
  "node:sqlite",
  "bun:sqlite",
];

/** Workspace packages the study may reach; `@app/infra` is deliberately absent. */
const ALLOWED_WORKSPACE = new Set(["@app/kajianq-domain", "@app/contracts"]);

/** Names that would mean a store was constructed, even without an import. */
const DENIED_SOURCE_TOKENS = [
  "resolvePostgresStore",
  "createPostgresStore",
  "DATABASE_URL",
  "@aws-sdk",
  "S3Client",
];

/** Every form that loads another module. `require` is parsed although the package is ESM. */
const SPECIFIER_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/gu, // static named / default / star, and `export … from`
  /\bimport\s*["']([^"']+)["']/gu, // bare side-effect import
  /\bimport\s*\(\s*["']([^"']+)["']/gu, // literal dynamic import
  /\brequire\s*\(\s*["']([^"']+)["']/gu, // CommonJS require
];

/** Loaders whose specifier the walker cannot see: each one is a hard walk failure. */
const OPAQUE_LOADERS = [
  {
    pattern: /\b(?:import|require)\s*\(\s*(?!["'])/gu,
    reason: "a dynamic import or require with a computed specifier is opaque",
  },
  {
    pattern: /\bcreateRequire\b/gu,
    reason: "createRequire builds a module loader the walker cannot follow",
  },
] as const;

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

/** Candidate files a relative specifier may name, in resolution order. */
function relativeCandidates(base: string): string[] {
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.mts`,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.js"),
    join(base, "index.mjs"),
  ];
  // A specifier naming the emitted `.js` may be the TypeScript source next to it.
  if (base.endsWith(".js")) candidates.push(`${base.slice(0, -3)}.ts`);
  if (base.endsWith(".mjs")) candidates.push(`${base.slice(0, -4)}.mts`);
  return candidates;
}

/** Resolve `subpath` against a package's `exports` map, including a `*` wildcard. */
function exportTarget(exports: Readonly<Record<string, string>>, subpath: string): string | null {
  const direct = exports[subpath];
  if (direct !== undefined) return direct;
  for (const [key, target] of Object.entries(exports)) {
    const star = key.indexOf("*");
    if (star < 0) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    if (subpath.length < prefix.length + suffix.length) continue;
    const inner = subpath.slice(prefix.length, subpath.length - suffix.length);
    const at = target.indexOf("*");
    return at < 0 ? target : `${target.slice(0, at)}${inner}${target.slice(at + 1)}`;
  }
  return null;
}

type Resolution =
  | { readonly file: string; readonly workspacePackage: string | null }
  | { readonly external: string }
  | { readonly unresolved: string };

function resolveSpecifier(fromFile: string, specifier: string): Resolution {
  if (specifier.startsWith(".")) {
    for (const candidate of relativeCandidates(resolve(dirname(fromFile), specifier))) {
      if (isFile(candidate)) return { file: candidate, workspacePackage: null };
    }
    return { unresolved: "no file matches the relative specifier" };
  }
  if (specifier.startsWith("@app/")) {
    const [, pkg, ...rest] = specifier.split("/");
    if (pkg === undefined) return { unresolved: "workspace specifier without a package name" };
    const workspacePackage = `@app/${pkg}`;
    const packageDir = join(REPO, "packages", pkg);
    const manifestPath = join(packageDir, "package.json");
    if (!isFile(manifestPath))
      return { unresolved: `workspace package @app/${pkg} has no package.json` };
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      exports?: Record<string, string>;
    };
    const subpath = rest.length === 0 ? "." : `./${rest.join("/")}`;
    const target = exportTarget(manifest.exports ?? {}, subpath);
    if (target === null)
      return { unresolved: `workspace package ${workspacePackage} declares no export ${subpath}` };
    const file = join(packageDir, target);
    if (!isFile(file)) return { unresolved: `${workspacePackage} export ${subpath} names ${file}` };
    return { file, workspacePackage };
  }
  return { external: specifier };
}

type ImportGraph = {
  readonly files: readonly string[];
  readonly externals: ReadonlySet<string>;
  readonly packages: ReadonlySet<string>;
};

/**
 * Walk the module graph reachable from `entry`.
 *
 * A `@app/…` specifier outside `allowedWorkspace` is recorded and not descended into: the
 * edge is the violation, and walking the offending package's own graph cannot un-record
 * it. Every other edge must resolve or the walk throws.
 */
function walkImportGraph(entry: string): ImportGraph {
  const files: string[] = [];
  const externals = new Set<string>();
  const packages = new Set<string>();
  const problems: string[] = [];
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    files.push(current);
    const source = readFileSync(current, "utf8");
    for (const pattern of SPECIFIER_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1] as string;
        const target = resolveSpecifier(current, specifier);
        if ("unresolved" in target) {
          problems.push(`${current}: cannot resolve "${specifier}" (${target.unresolved})`);
          continue;
        }
        if ("external" in target) {
          externals.add(target.external);
          continue;
        }
        if (target.workspacePackage !== null) {
          packages.add(target.workspacePackage);
          if (!ALLOWED_WORKSPACE.has(target.workspacePackage)) continue;
        }
        queue.push(target.file);
      }
    }
    for (const { pattern, reason } of OPAQUE_LOADERS) {
      for (const match of source.matchAll(pattern)) {
        const line = source.slice(0, match.index).split("\n").length;
        problems.push(`${current}:${line}: ${reason}`);
      }
    }
  }
  if (problems.length > 0)
    throw new Error(`sanadset import graph is incomplete:\n${problems.join("\n")}`);
  return { files, externals, packages };
}

function deniedExternals(graph: ImportGraph): string[] {
  return [...graph.externals].filter((specifier) =>
    DENIED_SPECIFIERS.some((denied) => specifier === denied || specifier.startsWith(`${denied}/`)),
  );
}

describe("the study's import graph", () => {
  const graph = walkImportGraph(PUBLIC_BARREL);

  it("is a real graph, not a resolution failure that would pass vacuously", () => {
    expect(graph.files.length).toBeGreaterThan(15);
    expect(graph.files.some((file) => file.endsWith("sanadset-study.ts"))).toBe(true);
    expect(graph.files.some((file) => file.endsWith("sanadset-cascade.ts"))).toBe(true);
    expect(graph.files.some((file) => file.endsWith("sanadset-report.ts"))).toBe(true);
    expect(graph.packages.has("@app/contracts")).toBe(true);
  });

  it("reaches no database, object-store or store-factory package", () => {
    expect(deniedExternals(graph)).toEqual([]);
    expect(graph.files.some((file) => file.includes("rag-store"))).toBe(false);
  });

  it("reaches no workspace package that could construct a store", () => {
    for (const pkg of graph.packages) expect(ALLOWED_WORKSPACE.has(pkg)).toBe(true);
    expect(graph.packages.has("@app/infra")).toBe(false);
  });

  it("names no store entry point or database variable in any reachable file", () => {
    for (const file of graph.files) {
      const source = readFileSync(file, "utf8");
      for (const token of DENIED_SOURCE_TOKENS) expect(source).not.toContain(token);
    }
  });

  it("exports no store factory from the public barrel", async () => {
    const barrel = (await import("./sanadset")) as Record<string, unknown>;
    for (const name of Object.keys(barrel)) {
      expect(name).not.toMatch(/Store|database|postgres|r2|object-store/iu);
    }
    expect(typeof barrel["runSanadsetStudy"]).toBe("function");
  });
});

/**
 * The negative space: each fixture is a module the walker must not be able to miss. A
 * walker that regresses to `... from` only, or that skips a specifier it cannot map,
 * fails one of these instead of keeping the real graph green.
 */
describe("the walker's negative space", () => {
  it("sees a bare side-effect import as an edge", () => {
    const graph = walkImportGraph(join(FIXTURES, "bare-app-infra.mjs"));
    expect(graph.files).toHaveLength(1);
    expect(graph.packages.has("@app/infra")).toBe(true);
  });

  it("follows a relative .js specifier into the module it names", () => {
    const graph = walkImportGraph(join(FIXTURES, "suffix-entry.mjs"));
    expect(graph.files).toContain(join(FIXTURES, "suffix-helper.js"));
    expect(graph.packages.has("@app/infra")).toBe(true);
  });

  it("sees a literal require as an edge", () => {
    const graph = walkImportGraph(join(FIXTURES, "require-app-infra.mjs"));
    expect(graph.files).toHaveLength(1);
    expect(graph.packages.has("@app/infra")).toBe(true);
  });

  it("sees a literal dynamic import as an edge", () => {
    const graph = walkImportGraph(join(FIXTURES, "dynamic-app-infra.mjs"));
    expect(graph.files).toHaveLength(1);
    expect(graph.packages.has("@app/infra")).toBe(true);
  });

  it("treats an unresolved relative specifier as a broken graph, not a skip", () => {
    expect(() => walkImportGraph(join(FIXTURES, "unresolved-entry.mjs"))).toThrow(
      /cannot resolve "\.\/missing-helper\.js"/u,
    );
  });

  it("throws on a dynamic import whose specifier is computed", () => {
    expect(() => walkImportGraph(join(FIXTURES, "computed-entry.mjs"))).toThrow(
      /computed specifier/u,
    );
  });

  it("throws on a require whose specifier is computed", () => {
    expect(() => walkImportGraph(join(FIXTURES, "computed-require.mjs"))).toThrow(
      /require with a computed specifier is opaque/u,
    );
  });

  it("throws on a require function built with createRequire", () => {
    expect(() => walkImportGraph(join(FIXTURES, "create-require.mjs"))).toThrow(
      /createRequire builds a module loader the walker cannot follow/u,
    );
  });

  it("stays green on a clean module, so the traps do not pass by failing everything", () => {
    const graph = walkImportGraph(join(FIXTURES, "clean-entry.mjs"));
    expect(graph.files).toContain(join(FIXTURES, "clean-helper.js"));
    expect(graph.packages.size).toBe(0);
    expect(deniedExternals(graph)).toEqual([]);
  });
});

describe("the CLI entry", () => {
  it("imports the study barrel and nothing that could open a connection", () => {
    const source = readFileSync(CLI_ENTRY, "utf8");
    const specifiers = SPECIFIER_PATTERNS.flatMap((pattern) =>
      [...source.matchAll(pattern)].map((match) => match[1] as string),
    );
    expect([...specifiers].sort()).toEqual(
      [
        "@app/kajianq-domain/sanadset",
        // The arm's provider profiles: a data module of the composition root, not a library.
        "./sanadset-arm-profiles.mjs",
        "node:os",
      ].sort(),
    );
    for (const token of DENIED_SOURCE_TOKENS) expect(source).not.toContain(token);
  });

  it("walks the CLI's own graph to the same verdict", () => {
    const cliGraph = walkImportGraph(CLI_ENTRY);
    expect(cliGraph.files.length).toBeGreaterThan(15);
    expect(deniedExternals(cliGraph)).toEqual([]);
    expect(cliGraph.packages.has("@app/infra")).toBe(false);
  });

  it("is the script the root manifest exposes as study:sanadset", () => {
    const manifest = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts["study:sanadset"]).toBe(
      "bun packages/kajianq-domain/scripts/sanadset-study.mjs",
    );
  });
});
