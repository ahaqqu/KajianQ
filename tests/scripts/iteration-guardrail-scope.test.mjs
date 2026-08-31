// Test suite for the session-scope gate (issue #123) in front of the
// iteration-guardrail counting logic. The invariants:
// - scope "subagents-only" (default): only session ids matching the
//   configured subagent pattern are guarded; every other session is a FULL
//   no-op — no counting state file created, no deny.
// - scope "all": byte-identical to the pre-#123 semantics regardless of
//   pattern (the existing counting suite runs under this scope).
// - A non-matching session that still runs verification commands emits the
//   rate-limited warn_scope_zero_match exactly once per session, and leaves
//   NO counting state.
// No counting-logic assertion lives here — those are owned by
// iteration-guardrail.test.mjs and must never be weakened.

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultConfig,
  isSubagentSession,
  normalizeConfig,
} from "../../scripts/iteration-guardrail/lib.mjs";

// ---------------------------------------------------------------------------
// A. Scope config and decision (lib.mjs/scope.mjs, pure)
// ---------------------------------------------------------------------------
describe("scope config and decision (lib.mjs, pure)", () => {
  const cfg = normalizeConfig(defaultConfig()).config;

  it("default scope is subagents-only with the observed subagent convention", () => {
    expect(cfg.scope).toBe("subagents-only");
    expect(isSubagentSession(cfg, "sess_subagent_agent_impl1")).toBe(true);
    expect(isSubagentSession(cfg, "sess_subagent_agent_test_abc123")).toBe(true);
  });

  it("TRAP: non-matching session ids are never guarded under the default scope", () => {
    // The named fixtures from the issue: fixture envelopes and human-looking
    // interactive session ids must all fall outside the guardrail.
    for (const id of ["sess_fixture_pretooluse", "sess_guardrail_a", "sess_human_abc", "goal-session", ""]) {
      expect(isSubagentSession(cfg, id), JSON.stringify(id)).toBe(false);
    }
    // Missing identity is already handled upstream (skip_no_session), but the
    // decision must also fail closed-to-no-op for junk, never throw.
    for (const junk of [null, undefined, 42, {}]) {
      expect(isSubagentSession(cfg, junk), JSON.stringify(junk)).toBe(false);
    }
  });

  it("TRAP: scope all matches every session regardless of the pattern", () => {
    const all = normalizeConfig({ scope: "all" }).config;
    expect(all.scope).toBe("all");
    for (const id of ["sess_fixture_pretooluse", "sess_human_abc", "sess_subagent_agent_x"]) {
      expect(isSubagentSession(all, id), id).toBe(true);
    }
  });

  it("TRAP: invalid scope or pattern degrades to the defaults, never throws", () => {
    for (const bad of ["everything", "SUBAGENTS-ONLY", null, 42, []]) {
      const r = normalizeConfig({ scope: bad });
      expect(r.degraded, JSON.stringify(bad)).toContain("scope");
      expect(r.config.scope).toBe("subagents-only");
    }
    for (const bad of ["[unclosed", "", 42, null, "x".repeat(201)]) {
      const r = normalizeConfig({ subagentSessionPattern: bad });
      expect(r.degraded, JSON.stringify(bad)).toContain("subagentSessionPattern");
      // The default pattern still guards subagent ids after degradation.
      expect(isSubagentSession(r.config, "sess_subagent_agent_impl1")).toBe(true);
      expect(isSubagentSession(r.config, "sess_fixture_pretooluse")).toBe(false);
    }
    // A valid custom pattern replaces the default (configurable alongside the caps).
    const custom = normalizeConfig({ subagentSessionPattern: "^agent_" });
    expect(custom.degraded).toEqual([]);
    expect(isSubagentSession(custom.config, "agent_dispatch_1")).toBe(true);
    expect(isSubagentSession(custom.config, "sess_subagent_agent_1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B. Process-level scope behavior (hook.mjs via spawnSync)
// ---------------------------------------------------------------------------
describe("hook.mjs scope gate (process boundary)", () => {
  const HOOK = new URL("../../scripts/iteration-guardrail/hook.mjs", import.meta.url).pathname;
  const REPO_ROOT = new URL("../../", import.meta.url).pathname;
  const SUBAGENT = "sess_subagent_agent_impl1";
  const HUMAN = "sess_fixture_pretooluse"; // the issue's named non-matching id

  const liveEnvs = [];
  // scope === undefined keeps the shipped config.json untouched (exercises
  // the shipped default); otherwise the value is injected as the scope field.
  function newEnv(scope) {
    const dir = mkdtempSync(join(tmpdir(), "guardrail-scope-"));
    const stateDir = join(dir, "state");
    mkdirSync(stateDir, { recursive: true });
    const configPath = join(dir, "config.json");
    copyFileSync(join(REPO_ROOT, "scripts", "iteration-guardrail", "config.json"), configPath);
    if (scope !== undefined) {
      const cfg = JSON.parse(readFileSync(configPath, "utf8"));
      cfg.scope = scope;
      writeFileSync(configPath, JSON.stringify(cfg, null, 2));
    }
    const env = { dir, stateDir, configPath };
    liveEnvs.push(env);
    return env;
  }

  afterEach(() => {
    for (const env of liveEnvs) rmSync(env.dir, { recursive: true, force: true });
    liveEnvs.length = 0;
  });

  const stateFileFor = (env, sessionId) => join(env.stateDir, `${sessionId}.json`);
  // Review A3: markers live in the disjoint `scope/` subdirectory.
  const warnMarkerFor = (env, sessionId) => join(env.stateDir, "scope", `warn-${sessionId}.json`);
  const scopeCacheFor = (env) => join(env.stateDir, "scope", "last-good.json");

  function runHook(payload, env, extraEnv = {}) {
    return spawnSync("bun", [HOOK], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ZCODE_SESSION_ID: "",
        ZCODE_PROJECT_DIR: "",
        ZCODE_GUARDRAIL_STATE_DIR: env.stateDir,
        ZCODE_GUARDRAIL_CONFIG: env.configPath,
        ...extraEnv,
      },
    });
  }

  const preToolUse = (sessionId, command) => ({
    hook_event_name: "PreToolUse",
    session_id: sessionId,
    tool_name: "Bash",
    tool_input: { command },
  });
  const postBash = (sessionId, command, stdout) => ({
    hook_event_name: "PostToolUse",
    session_id: sessionId,
    tool_name: "Bash",
    tool_input: { command },
    tool_response: { status: "completed", exitCode: 1, stdout, stderr: "" },
  });
  const postEdit = (sessionId) => ({
    hook_event_name: "PostToolUse",
    session_id: sessionId,
    tool_name: "Edit",
    tool_input: { file_path: "src/fix.ts" },
  });
  const CMD = "bun run test";
  const FAIL_OUT = "FAIL tests/auth.test.ts > auth > rejects an expired token";

  function warnCount(stderr) {
    return stderr.split("warn_scope_zero_match").length - 1;
  }

  it("shipped default (subagents-only): a subagent session denies at the cap exactly as today", () => {
    const env = newEnv();
    for (let i = 0; i < 3; i++) {
      const r = runHook(postBash(SUBAGENT, CMD, FAIL_OUT), env);
      expect(r.status).toBe(0);
      expect(r.stderr).toContain("verification_result");
    }
    expect(existsSync(stateFileFor(env, SUBAGENT))).toBe(true);
    const denied = runHook(preToolUse(SUBAGENT, CMD), env);
    expect(denied.status).toBe(0);
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(warnCount(denied.stderr)).toBe(0); // matching sessions never warn
  });

  it("TRAP: a non-matching session is a full no-op — no counting state, no deny, even past the caps", () => {
    const env = newEnv("subagents-only");
    // Five failed verification cycles (past the same-failure cap of 3), an
    // Edit (fix attempt), and a breached-cap rerun: every event must be a
    // byte-level pass-through with zero counting-state footprint.
    for (let i = 0; i < 5; i++) {
      const r = runHook(postBash(HUMAN, CMD, FAIL_OUT), env);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).not.toContain("verification_result");
      expect(r.stderr).not.toContain('"event":"deny"');
    }
    const edit = runHook(postEdit(HUMAN), env);
    expect(edit.status).toBe(0);
    expect(existsSync(stateFileFor(env, HUMAN)), "no counting state file for a non-matching session").toBe(false);
    const rerun = runHook(preToolUse(HUMAN, CMD), env);
    expect(rerun.status).toBe(0);
    expect(rerun.stdout).toBe(""); // no deny JSON
    // Only the separate warn marker may exist — never the counting state.
    expect(existsSync(warnMarkerFor(env, HUMAN))).toBe(true);
    expect(existsSync(stateFileFor(env, HUMAN))).toBe(false);
  });

  it("zero-match warn is rate-limited to once per session", () => {
    const env = newEnv("subagents-only");
    for (let i = 0; i < 4; i++) {
      const r = runHook(postBash(HUMAN, CMD, FAIL_OUT), env);
      expect(r.status).toBe(0);
      expect(warnCount(r.stderr), `event ${i + 1}`).toBe(i === 0 ? 1 : 0);
    }
    // Non-verification activity never triggers (or resets) the warn.
    const git = runHook(postBash(HUMAN, 'git commit -m "checkpoint"', ""), env);
    expect(warnCount(git.stderr)).toBe(0);
    // A different session warns on its own first verification event.
    const other = runHook(postBash("sess_guardrail_b", CMD, FAIL_OUT), env);
    expect(warnCount(other.stderr)).toBe(1);
  });

  it("scope all restores the pre-#123 behavior for a non-matching-pattern session", () => {
    const env = newEnv("all");
    for (let i = 0; i < 3; i++) {
      const r = runHook(postBash(HUMAN, CMD, FAIL_OUT), env);
      expect(r.status).toBe(0);
      expect(r.stderr).toContain("verification_result");
    }
    expect(existsSync(stateFileFor(env, HUMAN))).toBe(true);
    const denied = runHook(preToolUse(HUMAN, CMD), env);
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(warnCount(denied.stderr)).toBe(0); // nothing is non-matching under "all"
  });

  // --- Review-round findings (PR #124) --------------------------------------

  it("TRAP: config loss preserves the last-known scope intent (an 'all' deployment keeps counting)", () => {
    const env = newEnv("all");
    // Two good loads under scope "all" record HUMAN's failures and seed the cache.
    for (let i = 0; i < 2; i++) runHook(postBash(HUMAN, CMD, FAIL_OUT), env);
    expect(existsSync(scopeCacheFor(env)), "scope intent cached from the good config").toBe(true);
    // The config file is then destroyed (unparseable garbage).
    writeFileSync(env.configPath, "NOT JSON{{{");
    // Counting must continue under the cached intent: the next failure is
    // recorded (3 total), so the rerun denies — no silent subagents-only flip.
    const seeded = runHook(postBash(HUMAN, CMD, FAIL_OUT), env);
    expect(seeded.stderr).toContain("verification_result");
    expect(seeded.stderr).toContain("warn_scope_degraded");
    const denied = runHook(preToolUse(HUMAN, CMD), env);
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(existsSync(stateFileFor(env, HUMAN))).toBe(true);
  });

  it("TRAP: a degraded scope field falls back to the cached intent, not the default", () => {
    const env = newEnv("all");
    runHook(postBash(HUMAN, CMD, FAIL_OUT), env); // seeds the cache with scope "all"
    // Corrupt ONLY the scope field (valid JSON, invalid value).
    const cfg = JSON.parse(readFileSync(env.configPath, "utf8"));
    cfg.scope = "everything";
    writeFileSync(env.configPath, JSON.stringify(cfg));
    const seeded = runHook(postBash(HUMAN, CMD, FAIL_OUT), env);
    expect(seeded.stderr).toContain("verification_result"); // still counting under "all"
    expect(seeded.stderr).toContain("warn_scope_degraded");
  });

  it("warn_config is scoped to verification-relevant events (Edit/Write stay silent)", () => {
    const env = newEnv();
    const missing = join(env.dir, "does-not-exist.json");
    const overrides = { ZCODE_GUARDRAIL_CONFIG: missing };
    // An Edit event under a missing config must be as silent as at base.
    const edit = runHook(postEdit(HUMAN), env, overrides);
    expect(edit.status).toBe(0);
    expect(edit.stderr).not.toContain("warn_config");
    expect(edit.stderr).not.toContain("warn_scope_degraded");
    // The Bash verification event still warns (it reaches the counting path).
    const bash = runHook(postBash(HUMAN, CMD, FAIL_OUT), env, overrides);
    expect(bash.stderr).toContain("warn_config");
  });
});
