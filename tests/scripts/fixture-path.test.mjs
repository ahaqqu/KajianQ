import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { readFixtureText, resolveFixturePath } from "../../packages/eval/scripts/fixture-path.mjs";
import { parseIndependentProbes } from "../../packages/eval/src/independent-probes.ts";

/**
 * The fixture path the eval CLIs read is a configured override, and the config
 * contract accepts an absolute path. A resolver that prefixes every path with the
 * cwd turns that override into `<cwd>//abs/path` and fails ENOENT before any spend,
 * so both forms are pinned here — and the absolute form is read end to end through
 * the same loader `eval:probes` uses.
 */

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE = "packages/kajianq-domain/fixtures/independent-probes-v1.json";

describe("resolveFixturePath", () => {
  it("keeps an absolute override as-is instead of prefixing the cwd", () => {
    const absolute = resolve(REPO_ROOT, FIXTURE);
    expect(resolveFixturePath(REPO_ROOT, absolute)).toBe(absolute);
    expect(resolveFixturePath(REPO_ROOT, absolute)).not.toContain(`${REPO_ROOT}/${absolute}`);
  });

  it("resolves a relative override against the given cwd", () => {
    expect(resolveFixturePath(REPO_ROOT, FIXTURE)).toBe(resolve(REPO_ROOT, FIXTURE));
  });
});

describe("readFixtureText", () => {
  it("reads an absolute override and parses it with the probe loader", () => {
    const absolute = resolve(REPO_ROOT, FIXTURE);
    const fixture = parseIndependentProbes(
      JSON.parse(readFixtureText(REPO_ROOT, absolute)),
      absolute,
    );
    expect(fixture.probes.length).toBeGreaterThan(0);
  });

  it("reads the checked-in default through its relative form", () => {
    expect(() => JSON.parse(readFixtureText(REPO_ROOT, FIXTURE))).not.toThrow();
  });
});
