import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const SCRIPT = `${ROOT}/scripts/check-vp-vite-pin.mjs`;

// The guard resolves apps/web/package.json, package.json, and
// node_modules/vite-plus/dist/versions.js relative to the script's own
// location, so the fixture mirrors the repo layout under a temp dir and the
// script is copied in to make those paths resolve inside the fixture.
function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "vp-pin-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "apps/web"), { recursive: true });
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

describe("vp version-coupling guard (ADR-0029 decision 5)", () => {
  let dir;

  beforeEach(() => {
    dir = makeFixture();
    write(
      join(dir, "apps/web/package.json"),
      JSON.stringify({ devDependencies: { vite: "8.2.2" } }),
    );
    write(
      join(dir, "package.json"),
      JSON.stringify({ devDependencies: { vitest: "4.1.11", "@vitest/coverage-v8": "4.1.11" } }),
    );
    write(join(dir, "node_modules/vite-plus/dist/versions.js"), VERSIONS);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes when vite and vitest pins match the vp bundled revisions", () => {
    const res = run(dir);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("vp-vite-pin OK");
    expect(res.stdout).toContain("vp-vitest-pin OK");
  });

  it("fails when the root vitest pin diverges from the vp bundled revision", () => {
    write(
      join(dir, "package.json"),
      JSON.stringify({ devDependencies: { vitest: "4.1.12", "@vitest/coverage-v8": "4.1.11" } }),
    );
    const res = run(dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("vp-vitest-pin");
    expect(res.stderr).toContain("4.1.12");
  });

  it("fails when @vitest/coverage-v8 diverges from the vp bundled revision", () => {
    write(
      join(dir, "package.json"),
      JSON.stringify({ devDependencies: { vitest: "4.1.11", "@vitest/coverage-v8": "4.1.12" } }),
    );
    const res = run(dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("vp-vitest-pin");
    expect(res.stderr).toContain("4.1.12");
  });

  it("fails when a vitest pin is missing", () => {
    write(join(dir, "package.json"), JSON.stringify({ devDependencies: { vitest: "4.1.11" } }));
    const res = run(dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("cannot read all versions");
  });

  it("still fails when the apps/web vite pin diverges", () => {
    write(
      join(dir, "apps/web/package.json"),
      JSON.stringify({ devDependencies: { vite: "8.2.1" } }),
    );
    const res = run(dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("vp-vite-pin");
  });
});
