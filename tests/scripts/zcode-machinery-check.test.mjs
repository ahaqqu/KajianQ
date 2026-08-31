// Test suite for the .zcode/ machinery gate (issue #125). The invariants:
// - checkZcodeMachinery hard-fails when the hook wiring is missing/disabled,
//   when a role file lacks a concrete `model:` pin, or when a role file lacks
//   a valid `thoughtLevel:` pin (dispatched roles: exactly high).
// - The zcode:preflight script (zcode-pin-check.mjs) reports a stale pin —
//   one that cannot resolve in the local provider config — as a visible
//   drift WARNING and still exits 0, because CI has no ~/.zcode/v2/config.json;
//   structural violations still exit 1.
// - HOME override simulates the CI environment (no client config): resolution
//   is skipped with a warning, exit 0.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkHookWiring,
  checkRoleFile,
  checkZcodeMachinery,
} from "../../scripts/zcode-machinery-check.mjs";
// The expected machinery shape has ONE test-side source of truth (review B3
// on PR #127): this shared builder, asserted against the gate below.
import {
  MODEL_PIN,
  machineryConfig,
  machineryTmpFixture as fixture,
  roleBody,
} from "./helpers/zcode-machinery-fixture.mjs";

const PIN_CHECK = join(process.cwd(), "scripts/zcode-pin-check.mjs");

function wireOnly(config) {
  return { errors: checkHookWiring(config, ".zcode/config.json") };
}

describe("checkHookWiring", () => {
  it("accepts the fixture builder's config — the shared shape satisfies the gate", () => {
    // Review B3 on PR #127: the fixture builder is the single source of truth;
    // if the gate's expected shape and this config ever diverge, this fails.
    expect(wireOnly(machineryConfig()).errors).toEqual([]);
  });

  it("accepts the template shape: guardrail + usage hooks present and enabled", () => {
    expect(wireOnly(machineryConfig()).errors).toEqual([]);
  });

  it("fails when hooks are globally disabled", () => {
    const errors = wireOnly({ hooks: { ...machineryConfig().hooks, enabled: false } }).errors;
    expect(errors[0]).toContain("hooks.enabled is not true");
  });

  it("fails per missing event/matcher/script combination, naming the fix", () => {
    const config = machineryConfig();
    config.hooks.events.PostToolUse = config.hooks.events.PostToolUse.filter(
      (e) => e.matcher !== "Agent",
    );
    const errors = wireOnly(config).errors;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("PostToolUse/Agent");
    expect(errors[0]).toContain("scripts/agent-usage-metadata/hook.mjs");
    expect(errors[0]).toContain("template-sync update");
  });

  it("treats a disabled hook entry as missing", () => {
    const config = machineryConfig();
    config.hooks.events.PreToolUse[0].hooks[0].enabled = false;
    const errors = wireOnly(config).errors;
    expect(errors[0]).toContain("PreToolUse/Bash");
  });
});

describe("checkRoleFile", () => {
  it("accepts a concrete pin + thoughtLevel high and returns the pin record", () => {
    const dir = fixture();
    const { errors, role } = checkRoleFile("implementer.md", join(dir, ".zcode", "agents"));
    expect(errors).toEqual([]);
    expect(role).toEqual({
      role: "implementer",
      file: "implementer.md",
      model: MODEL_PIN,
      thoughtLevel: "high",
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails on a missing, inherit, lite, or bare model pin", () => {
    const dir = fixture();
    const agents = join(dir, ".zcode", "agents");
    for (const [name, body] of [
      ["no-model", roleBody(undefined)],
      ["inherit", roleBody("inherit")],
      ["lite", roleBody("lite")],
      ["bare", roleBody("GLM-5.3-Flash")],
    ]) {
      const file = `${name}.md`;
      writeFileSync(join(agents, file), body);
      const { errors, role } = checkRoleFile(file, agents);
      expect(role).toBeNull();
      expect(errors[0]).toContain(file);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails on a missing or invalid thoughtLevel and on a non-high dispatched role", () => {
    const dir = fixture();
    const agents = join(dir, ".zcode", "agents");
    // "no-level" (field omitted via null) and "bad-level" are fork-added role
    // names; "reviewer" is a dispatched role, which must pin exactly high.
    for (const [name, thoughtLevel] of [
      ["no-level", null],
      ["bad-level", "ultra"],
      ["reviewer", "max"],
    ]) {
      const file = `${name}.md`;
      writeFileSync(join(agents, file), roleBody(MODEL_PIN, thoughtLevel));
      const { errors } = checkRoleFile(file, agents);
      expect(errors[0]).toContain(file);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("allows a fork-added role any validated thoughtLevel but still requires a concrete pin", () => {
    const dir = fixture();
    const agents = join(dir, ".zcode", "agents");
    const file = "fork-role.md";
    writeFileSync(join(agents, file), roleBody(MODEL_PIN, "medium"));
    const { errors, role } = checkRoleFile(file, agents);
    expect(errors).toEqual([]);
    expect(role.thoughtLevel).toBe("medium");
    rmSync(dir, { recursive: true, force: true });
  });

  it("hard-fails a committed pin naming a known-stale, non-caching channel (review A3)", () => {
    // The shape check is the only CI-visible layer, so `ollama/*` (the stale
    // channel issue #125 was filed for) must fail here, not merely warn.
    const dir = fixture();
    const agents = join(dir, ".zcode", "agents");
    const file = "implementer.md";
    writeFileSync(join(agents, file), roleBody("ollama/glm-5.3-flash:cloud"));
    const { errors } = checkRoleFile(file, agents);
    expect(errors.join("\n")).toContain("known-stale, non-caching channel");
    expect(errors.join("\n")).toContain("~/.zcode/agents/implementer.md");
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects duplicated model: keys like duplicated thoughtLevel: keys (review A4)", () => {
    // YAML resolves duplicate keys last-wins, so the pin is ambiguous —
    // `model: inherit` hiding behind a later concrete pin must not pass.
    const dir = fixture();
    const agents = join(dir, ".zcode", "agents");
    const file = "implementer.md";
    const body = [
      "---",
      "name: implementer",
      "tools: ['*']",
      `model: inherit`,
      `model: ${MODEL_PIN}`,
      "thoughtLevel: high",
      "---",
      "",
      "Body.",
      "",
    ].join("\n");
    writeFileSync(join(agents, file), body);
    // The pin record still resolves from the last occurrence for the
    // downstream resolution layer; the ambiguity error is what gates.
    const { errors } = checkRoleFile(file, agents);
    expect(errors.some((e) => e.includes("2 model fields"))).toBe(true);
    expect(errors.some((e) => e.includes("ambiguous"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("checkZcodeMachinery", () => {
  it("passes a complete template-shaped tree with no errors", () => {
    const dir = fixture();
    const { errors, roles } = checkZcodeMachinery(dir);
    expect(errors).toEqual([]);
    expect(roles).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails with the restore hint when .zcode/ is absent entirely", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-empty-"));
    const { errors, roles } = checkZcodeMachinery(dir);
    expect(roles).toEqual([]);
    expect(errors.some((e) => e.includes(".zcode/config.json"))).toBe(true);
    expect(errors.some((e) => e.includes(".zcode/agents"))).toBe(true);
    expect(errors.join("\n")).toContain("template-sync update");
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails on a falsy config parse (JSON null) instead of skipping the wiring check (review A2)", () => {
    // JSON.parse("null") does not throw, so the catch branch never runs —
    // the wiring check must still run (against {}) and produce the standard
    // "hooks.enabled is not true" failure, never a silent pass.
    const dir = mkdtempSync(join(tmpdir(), "zcode-null-config-"));
    mkdirSync(join(dir, ".zcode"), { recursive: true });
    writeFileSync(join(dir, ".zcode", "config.json"), "null");
    const { errors } = checkZcodeMachinery(dir);
    expect(errors.some((e) => e.includes("hooks.enabled is not true"))).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("zcode-pin-check.mjs (preflight script)", () => {
  /** Fake HOME whose ZCode client config declares a provider that does NOT
   * carry the fixture's model — a non-resolving pin. The provider id is
   * deliberately NOT a known-stale channel (`ollama` hard-fails the structural
   * gate since review A3 on PR #127); this exercises the resolution-warning
   * path only. */
  function homeWithUnresolvedProvider() {
    const home = mkdtempSync(join(tmpdir(), "zcode-home-"));
    mkdirSync(join(home, ".zcode", "v2"), { recursive: true });
    writeFileSync(
      join(home, ".zcode", "v2", "config.json"),
      JSON.stringify({ provider: { localtest: { models: { "glm-5.3:cloud": {} } } } }),
    );
    return home;
  }

  function runScript(rootDir, homeDir) {
    return spawnSync("bun", [PIN_CHECK], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        ZCODE_PIN_CHECK_ROOT: rootDir,
        HOME: homeDir ?? tmpdir(), // default: no ~/.zcode/v2/config.json (CI-like)
      },
    });
  }

  it("exits 0 with a drift warning when the pin cannot resolve locally", () => {
    const dir = fixture({
      implementer: roleBody("localtest/nonexistent-model:cloud"),
    });
    const home = homeWithUnresolvedProvider();
    const r = runScript(dir, home);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("⚠ implementer: localtest/nonexistent-model:cloud");
    expect(r.stdout).toContain("drift warning, not a gate failure");
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("exits 1 on a committed pin naming the known-stale ollama channel (review A3)", () => {
    // End-to-end: the structural gate (which CI runs via template-gate)
    // hard-fails a committed stale-channel pin before resolution is even
    // attempted — the regression class issue #125 was filed for is
    // CI-visible, not only a local warning.
    const dir = fixture({ implementer: roleBody("ollama/glm-5.3-flash:cloud") });
    const r = runScript(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("known-stale, non-caching channel");
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits 0 with a warning when there is no client config (CI-like)", () => {
    const dir = fixture();
    const r = runScript(dir, join(tmpdir(), "definitely-empty-home"));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("skipping pin resolution");
    expect(r.stdout).toContain("machinery gate passed");
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits 1 when a role file is missing its thoughtLevel pin", () => {
    const dir = fixture({ implementer: roleBody(MODEL_PIN, null) });
    const r = runScript(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no thoughtLevel pin");
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits 1 when the hook wiring is broken", () => {
    const config = machineryConfig();
    config.hooks.enabled = false;
    const dir = fixture({ config });
    const r = runScript(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("hooks.enabled is not true");
    rmSync(dir, { recursive: true, force: true });
  });
});
