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
 * A trap is built in: the walker asserts it found the study's own modules, so a resolver
 * that silently found nothing cannot pass the suite by being empty.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI_ENTRY = join(REPO, "packages/kajianq-domain/scripts/sanadset-study.mjs");
const PUBLIC_BARREL = join(REPO, "packages/kajianq-domain/src/sanadset.ts");

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

function resolveSpecifier(
  fromFile: string,
  specifier: string,
): { file: string } | { external: string } | null {
  if (specifier.startsWith(".")) {
    const base = resolve(dirname(fromFile), specifier);
    for (const candidate of [`${base}.ts`, `${base}.mts`, join(base, "index.ts"), `${base}.mjs`]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return { file: candidate };
    }
    return null;
  }
  if (specifier.startsWith("@app/")) {
    const [scope, pkg, ...rest] = specifier.split("/");
    const packageDir = join(REPO, "packages", pkg as string);
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
      exports: Record<string, string>;
    };
    const subpath = rest.length === 0 ? "." : `./${rest.join("/")}`;
    const target = manifest.exports[subpath];
    if (target === undefined) return null;
    return { file: join(packageDir, target) };
  }
  return { external: specifier };
}

const IMPORT_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/g;

function walkImportGraph(entry: string): {
  files: string[];
  externals: Set<string>;
  packages: Set<string>;
} {
  const files: string[] = [];
  const externals = new Set<string>();
  const packages = new Set<string>();
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    files.push(current);
    const source = readFileSync(current, "utf8");
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1] as string;
      const target = resolveSpecifier(current, specifier);
      if (target === null) continue;
      if ("external" in target) {
        externals.add(target.external);
        if (target.external.startsWith("@app/"))
          packages.add(target.external.split("/").slice(0, 2).join("/"));
        continue;
      }
      if (target.file.startsWith(join(REPO, "packages")) && target.file.includes("/src/")) {
        const relative = target.file.slice(join(REPO, "packages").length + 1);
        packages.add(`@app/${relative.split("/")[0] as string}`);
      }
      queue.push(target.file);
    }
  }
  return { files, externals, packages };
}

describe("the study's import graph", () => {
  const graph = walkImportGraph(PUBLIC_BARREL);

  it("is a real graph, not a resolution failure that would pass vacuously", () => {
    expect(graph.files.length).toBeGreaterThan(15);
    expect(graph.files.some((file) => file.endsWith("sanadset-study.ts"))).toBe(true);
    expect(graph.files.some((file) => file.endsWith("sanadset-cascade.ts"))).toBe(true);
    expect(graph.files.some((file) => file.endsWith("sanadset-report.ts"))).toBe(true);
  });

  it("reaches no database, object-store or store-factory package", () => {
    const denied = [...graph.externals].filter((specifier) =>
      DENIED_SPECIFIERS.some(
        (deniedSpecifier) =>
          specifier === deniedSpecifier || specifier.startsWith(`${deniedSpecifier}/`),
      ),
    );
    expect(denied).toEqual([]);
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

describe("the CLI entry", () => {
  it("imports the study barrel and nothing that could open a connection", () => {
    const source = readFileSync(CLI_ENTRY, "utf8");
    const specifiers = [...source.matchAll(IMPORT_PATTERN)].map((match) => match[1] as string);
    expect(specifiers).toEqual(["@app/kajianq-domain/sanadset"]);
    for (const token of DENIED_SOURCE_TOKENS) expect(source).not.toContain(token);
  });

  it("walks the CLI's own graph to the same verdict", () => {
    const cliGraph = walkImportGraph(CLI_ENTRY);
    expect(cliGraph.files.length).toBeGreaterThan(15);
    expect(
      [...cliGraph.externals].filter((specifier) => DENIED_SPECIFIERS.includes(specifier)),
    ).toEqual([]);
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
