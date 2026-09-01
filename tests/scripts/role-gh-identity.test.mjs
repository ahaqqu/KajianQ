// Test suite for the role-gh-identity hook (per ADR-0025). The invariant:
// when role-separated GitHub identities are enabled, a role subagent with a
// configured identity may invoke `gh` ONLY through the `gh-as <role>`
// wrapper — bare `gh` denies; everything else (enforcement off, unresolvable
// role, unconfigured role, non-gh commands, wrapper-form commands) allows.
// The hook fails OPEN on every internal error and never lets token contents
// into the deny message or the agent's context.
//
// Section map:
// A. bare-`gh` detection (pure) — including evasion shapes and TRAP cases
//    for false positives
// B. role resolution (pure + injected lookup)
// C. verdict composition (evaluateIdentityCall)
// D. config contract parsing (packages/contracts role-identity)
// E. hook end-to-end (spawned process, fixture envelope, temp config)

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateIdentityCall, invokesBareGh, GH_AS_WRAPPER, resolveRole } from "../../scripts/role-gh-identity/lib.mjs";
import { parseRoleIdentityConfig } from "../../packages/contracts/src/role-identity";

const ENFORCED_CONFIG = parseRoleIdentityConfig({
  enabled: true,
  roles: {
    implementer: { tokenFile: "/tmp/tokens/implementer.token" },
    reviewer: { tokenFile: "/tmp/tokens/reviewer.token" },
  },
  identitiesFile: "/tmp/tokens/identities.json",
}).config;

// ---------------------------------------------------------------------------
// A. Bare-`gh` detection (pure)
// ---------------------------------------------------------------------------
describe("invokesBareGh (A)", () => {
  const BARE = [
    "gh pr view 123",
    "gh api repos/x/y --input payload.json",
    "bun run check && gh pr checks 123",
    "gh pr checks 123 && bun run test",
    "gh pr view 123; echo done",
    "echo x | gh api --method POST --input -",
    "bash -c 'gh pr view 123'",
    'bash -c "gh pr view 123"',
    "if gh pr checks 123; then echo green; fi",
    "exec gh pr view 123",
    "gh api repos/a/b/pulls/1/comments -f body=…",
    "gh pr", // bare `gh` with no subcommand opens interactive mode — still the owner's identity
  ];
  it.each(BARE)("denies bare gh invocation: %s", (cmd) => {
    expect(invokesBareGh(cmd)).toBe(true);
  });

  // TRAP: the compliant wrapper form must never deny — the whole mechanism
  // redirects here; a false positive on it would trap every compliant call.
  const WRAPPED = [
    `gh-as implementer pr view 123`,
    `gh-as reviewer api repos/a/b/pulls/1/comments -f body=…`,
    `bun run check && gh-as implementer pr checks 123`,
    `gh-as reviewer pr view 123 && echo done`,
    `echo done; gh-as reviewer pr view 123`,
  ];
  it.each(WRAPPED)("allows wrapper form: %s", (cmd) => {
    expect(invokesBareGh(cmd)).toBe(false);
  });

  // TRAP: gh-shaped prose and paths must never deny — false positives on
  // these would brick unrelated work in the same session.
  const NOT_GH = [
    "echo gh pr view is broken",
    "cat ~/.config/gh/hosts.yml",
    "git commit -m 'gh pr view is the fix'",
    "ls scripts/gh helpers",
    "./gh pr view 123",
    "scripts/gh pr view 123",
    "GH_TOKEN=x echo hi",
    "ghost pr view", // 'gh' as substring of another word must not match
    "echo 'then gh pr view'", // quoted prose after keyword — accepted gap: prose starting a segment can false-positive, but this one has prose before it
  ];
  it.each(NOT_GH)("allows non-invocation: %s", (cmd) => {
    expect(invokesBareGh(cmd)).toBe(false);
  });

  it("mixed command denies on the bare segment despite a wrapper segment", () => {
    // False-negative TRAP: an earlier wrapper call must not amnesty a later
    // bare `gh` in the same compound command.
    expect(invokesBareGh("gh-as reviewer pr view 123 && gh api user")).toBe(true);
    expect(invokesBareGh("gh api user && gh-as reviewer pr view 123")).toBe(true);
  });

  it("rejects junk input without throwing", () => {
    expect(invokesBareGh("")).toBe(false);
    expect(invokesBareGh(null)).toBe(false);
    expect(invokesBareGh(undefined)).toBe(false);
    expect(invokesBareGh(123)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B. Role resolution (pure)
// ---------------------------------------------------------------------------
describe("resolveRole (B)", () => {
  it("uses the envelope agent_type when present", () => {
    expect(resolveRole({ agent_type: "reviewer" }, () => null, "sess_x")).toBe("reviewer");
  });

  it("falls back to the metadata lookup when agent_type is absent", () => {
    const lookup = (key) => (key === "sess_subagent_agent_abc" ? { role: "implementer" } : null);
    expect(resolveRole({}, lookup, "sess_subagent_agent_abc")).toBe("implementer");
  });

  it("returns null when the lookup misses (fail-open)", () => {
    expect(resolveRole({}, () => null, "sess_unknown")).toBeNull();
  });

  it("returns null when the lookup throws (fail-open)", () => {
    expect(resolveRole({}, () => { throw new Error("scan error"); }, "sess_x")).toBeNull();
  });

  it("returns null when the lookup result has no usable role", () => {
    expect(resolveRole({}, () => ({ role: "" }), "sess_x")).toBeNull();
    expect(resolveRole({}, () => ({}), "sess_x")).toBeNull();
  });

  it("returns null on empty session id with no agent_type", () => {
    expect(resolveRole({}, () => ({ role: "reviewer" }), "")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// C. Verdict composition (pure)
// ---------------------------------------------------------------------------
describe("evaluateIdentityCall (C)", () => {
  const denyCases = [
    ["bare gh from configured role", { command: "gh pr view 123", role: "reviewer", config: ENFORCED_CONFIG }],
    ["evasive compound from configured role", { command: "bun run check && gh pr checks 9", role: "implementer", config: ENFORCED_CONFIG }],
  ];
  it.each(denyCases)("denies: %s", (_name, args) => {
    const verdict = evaluateIdentityCall(args);
    expect(verdict.deny).toBe(true);
    expect(verdict.reason).toContain(GH_AS_WRAPPER);
    expect(verdict.reason).toContain(args.role);
    // TRAP: the token file path must never appear in the deny reason —
    // the agent's context must stay free of secret locations.
    expect(verdict.reason).not.toContain(args.config.roles[args.role].tokenFile);
  });

  const allowCases = [
    ["enforcement disabled", { command: "gh pr view 123", role: "reviewer", config: { ...ENFORCED_CONFIG, enabled: false } }],
    ["role unresolvable", { command: "gh pr view 123", role: null, config: ENFORCED_CONFIG }],
    ["role has no configured identity", { command: "gh pr view 123", role: "assistant-manager", config: ENFORCED_CONFIG }],
    ["command uses the wrapper", { command: "gh-as reviewer pr view 123", role: "reviewer", config: ENFORCED_CONFIG }],
    ["command has no gh at all", { command: "bun run check", role: "implementer", config: ENFORCED_CONFIG }],
    ["config missing entirely", { command: "gh pr view 123", role: "reviewer", config: null }],
  ];
  it.each(allowCases)("allows: %s", (_name, args) => {
    expect(evaluateIdentityCall(args)).toEqual({ deny: false });
  });

  it("allows an empty role entry (tokenFile dropped) — fail-open", () => {
    const config = { enabled: true, roles: { reviewer: {} } };
    expect(evaluateIdentityCall({ command: "gh pr view 1", role: "reviewer", config })).toEqual({ deny: false });
  });
});

// ---------------------------------------------------------------------------
// D. Config contract (packages/contracts)
// ---------------------------------------------------------------------------
describe("parseRoleIdentityConfig (D)", () => {
  it("parses the shipped config.json", () => {
    const shipped = JSON.parse(
      readFileSync(new URL("../../scripts/role-gh-identity/config.json", import.meta.url).pathname, "utf8"),
    );
    const r = parseRoleIdentityConfig(shipped);
    expect(r.ok).toBe(true);
    // TRAP: shipped default must be enforcement-OFF — the deny must never
    // fire before the owner mints per-role tokens.
    expect(r.config.enabled).toBe(false);
  });

  it("rejects a config missing `enabled`", () => {
    expect(parseRoleIdentityConfig({ roles: {} }).ok).toBe(false);
  });

  it("rejects a role entry with an empty tokenFile", () => {
    const r = parseRoleIdentityConfig({ enabled: true, roles: { reviewer: { tokenFile: "" } } });
    expect(r.ok).toBe(false);
  });

  it("rejects junk with a reason string and never throws", () => {
    for (const junk of [null, undefined, "x", 42, [], { enabled: "yes" }]) {
      const r = parseRoleIdentityConfig(junk);
      expect(r.ok).toBe(false);
      expect(typeof r.reason).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// E. Hook end-to-end (spawned process)
// ---------------------------------------------------------------------------
describe("hook.mjs end-to-end (E)", () => {
  const HOOK = new URL("../../scripts/role-gh-identity/hook.mjs", import.meta.url).pathname;
  const ENVELOPE = () => ({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    agent_type: "reviewer",
    session_id: "sess_subagent_agent_fixture",
    cwd: "/home/user/project",
    tool_input: { command: "gh pr view 123", timeout: 120000 },
  });

  let tmp;
  afterEach(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

  function runHook(env, payload) {
    return spawnSync("bun", [HOOK], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
  }

  it("denies a configured role's bare gh call with the wrapper redirect", () => {
    tmp = mkdtempSync(join(tmpdir(), "role-identity-"));
    const configPath = join(tmp, "config.json");
    writeFileSync(configPath, JSON.stringify({
      enabled: true,
      roles: { reviewer: { tokenFile: join(tmp, "r.token") } },
    }));
    const r = runHook({ ZCODE_ROLE_IDENTITY_CONFIG: configPath }, ENVELOPE());
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("gh-as reviewer");
  });

  it("allows the same call when enforcement is disabled (shipped default)", () => {
    tmp = mkdtempSync(join(tmpdir(), "role-identity-"));
    const configPath = join(tmp, "config.json");
    writeFileSync(configPath, JSON.stringify({ enabled: false, roles: { reviewer: { tokenFile: "x" } } }));
    const r = runHook({ ZCODE_ROLE_IDENTITY_CONFIG: configPath }, ENVELOPE());
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("fails open on an unreadable config", () => {
    const r = runHook({ ZCODE_ROLE_IDENTITY_CONFIG: "/nonexistent/config.json" }, ENVELOPE());
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("fails open on unreadable stdin (junk)", () => {
    tmp = mkdtempSync(join(tmpdir(), "role-identity-"));
    const configPath = join(tmp, "config.json");
    writeFileSync(configPath, JSON.stringify({ enabled: true, roles: { reviewer: { tokenFile: "x" } } }));
    const r = spawnSync("bun", [HOOK], { input: "not json", encoding: "utf8", env: { ...process.env, ZCODE_ROLE_IDENTITY_CONFIG: configPath } });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("fails open on a non-Bash event and a Bash event without a command", () => {
    tmp = mkdtempSync(join(tmpdir(), "role-identity-"));
    const configPath = join(tmp, "config.json");
    writeFileSync(configPath, JSON.stringify({ enabled: true, roles: { reviewer: { tokenFile: "x" } } }));
    const edit = runHook({ ZCODE_ROLE_IDENTITY_CONFIG: configPath }, {
      hook_event_name: "PostToolUse", tool_name: "Edit", session_id: "s", tool_input: { file_path: "/x" },
    });
    expect(edit.status).toBe(0);
    expect(edit.stdout).toBe("");
    const noCmd = runHook({ ZCODE_ROLE_IDENTITY_CONFIG: configPath }, {
      hook_event_name: "PreToolUse", tool_name: "Bash", agent_type: "reviewer", session_id: "s", tool_input: {},
    });
    expect(noCmd.status).toBe(0);
    expect(noCmd.stdout).toBe("");
  });

  it("resolves the role via the metadata scan when agent_type is absent", () => {
    tmp = mkdtempSync(join(tmpdir(), "role-identity-"));
    const agentsDir = join(tmp, "agents");
    mkdirSync(join(agentsDir, "sess_parent"), { recursive: true });
    mkdirSync(join(agentsDir, "sess_parent", "agent_abc"), { recursive: true });
    writeFileSync(join(agentsDir, "sess_parent", "agent_abc", "metadata.json"), JSON.stringify({
      agentId: "agent_abc",
      childSessionId: "sess_subagent_agent_abc",
      profileSnapshot: { name: "implementer" },
    }));
    const configPath = join(tmp, "config.json");
    writeFileSync(configPath, JSON.stringify({
      enabled: true,
      roles: { implementer: { tokenFile: join(tmp, "i.token") } },
    }));
    const r = runHook({ ZCODE_ROLE_IDENTITY_CONFIG: configPath, ZCODE_AGENTS_DIR: agentsDir }, {
      ...ENVELOPE(), agent_type: undefined, session_id: "sess_subagent_agent_abc",
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("gh-as implementer");
  });

  it("parses the committed runtime-envelope fixture against the contract (drift net)", () => {
    const fixture = JSON.parse(readFileSync(
      new URL("../../scripts/role-gh-identity/fixtures/pre-tool-use-bash.json", import.meta.url).pathname,
      "utf8",
    ));
    // The fixture is an enforcement-relevant shape (agent_type + gh command)
    // but the shipped config is enforcement-off, so the hook must allow it.
    const r = runHook({}, fixture);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });
});