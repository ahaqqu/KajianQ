import { describe, expect, it, beforeEach, afterEach } from "vite-plus/test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const SCRIPT = `${ROOT}/scripts/check-vp-vite-pin.mjs`;

// The guard resolves package.json and node_modules/vite-plus/* relative to the
// script's own location, so the fixture mirrors that layout under a temp dir
// and the script is copied in to make those paths resolve inside it.
function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "vp-pin-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "node_modules/vite-plus/dist"), { recursive: true });
  copyFileSync(SCRIPT, join(dir, "scripts/check-vp-vite-pin.mjs"));
  return dir;
}

function write(file, data) {
  writeFileSync(file, data);
}

function run(dir) {
  return spawnSync("bun", [join(dir, "scripts/check-vp-vite-pin.mjs")], {
    cwd: dir,
    encoding: "utf8",
  });
}

const VERSIONS = `export const versions = {
  "vite": "8.2.2",
  "vitest": "4.1.11"
};`;

const VP_CORE_ALIAS = "npm:@voidzero-dev/vite-plus-core@0.3.0";

// Built dynamically so the truth gate's quoted-specifier scan (which counts
// tests/ as import corpus) does not read the fixture key as a real importer
// of @vitest/coverage-v8 — the package is loaded by vitest config, not
// imported, and its allowlist entry is load-bearing.
const COVERAGE_PKG = `@vitest/coverage-v${8}`;

function writeRootPkg(dir, { vite, vitest, coverage }) {
  write(
    join(dir, "package.json"),
    JSON.stringify({
      devDependencies: { [COVERAGE_PKG]: coverage },
      overrides: { vite, vitest },
    }),
  );
}

describe("vp version-coupling guard", () => {
  let dir;

  beforeEach(() => {
    dir = makeFixture();
    // What `vite-plus` itself depends on at runtime: the guard reads the
    // revision vp carries rather than restating it, so bumping vp is what
    // moves the alias.
    write(
      join(dir, "node_modules/vite-plus/package.json"),
      JSON.stringify({ dependencies: { "@voidzero-dev/vite-plus-core": "0.3.0" } }),
    );
    write(join(dir, "node_modules/vite-plus/dist/versions.js"), VERSIONS);
    writeRootPkg(dir, { vite: VP_CORE_ALIAS, vitest: "4.1.11", coverage: "4.1.11" });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes when the vite alias and vitest pins match the vp revisions", () => {
    const res = run(dir);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("vp-vite-pin OK");
    expect(res.stdout).toContain("vp-vitest-pin OK");
  });

  it("fails when the vitest override diverges from the vp bundled revision", () => {
    writeRootPkg(dir, { vite: VP_CORE_ALIAS, vitest: "4.1.12", coverage: "4.1.11" });
    const res = run(dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("vp-vitest-pin");
    expect(res.stderr).toContain("4.1.12");
  });

  it("fails when @vitest/coverage-v8 diverges from the vp bundled revision", () => {
    writeRootPkg(dir, { vite: VP_CORE_ALIAS, vitest: "4.1.11", coverage: "4.1.12" });
    const res = run(dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("vp-vitest-pin");
    expect(res.stderr).toContain("4.1.12");
  });

  it("fails when a vitest pin is missing", () => {
    write(
      join(dir, "package.json"),
      JSON.stringify({
        devDependencies: { [COVERAGE_PKG]: "4.1.11" },
        overrides: { vite: VP_CORE_ALIAS },
      }),
    );
    const res = run(dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("cannot read all versions");
  });

  it("fails when the vite alias diverges from the revision vp depends on", () => {
    writeRootPkg(dir, {
      vite: "npm:@voidzero-dev/vite-plus-core@0.3.3",
      vitest: "4.1.11",
      coverage: "4.1.11",
    });
    const res = run(dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("vp-vite-pin");
    expect(res.stderr).toContain("0.3.3");
  });
});
