// Test suite for the iteration-guardrail hook (issue #98), written from
// /tmp/wt-issue-98/TEST-BRIEF.md. The invariant: a deny fires ONLY on
// confident evidence of repeated failed verification cycles for the same
// problem in the current session; the hook fails OPEN on its own internal
// errors; every deny carries the full stuck-report escalation instruction.
//
// Sections A–G below map 1:1 to the brief's named test cases.

import { afterEach, describe, expect, it } from "vitest";
import { test as fcTest, fc } from "@fast-check/vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyStateChange,
  applyVerificationResult,
  buildDenyOutput,
  buildDenyReason,
  defaultConfig,
  emptyState,
  evaluateDeny,
  failureSignature,
  isVerificationCommand,
  isValidState,
  normalizeConfig,
  normalizeOutput,
  outcomeFromToolResponse,
} from "../../scripts/iteration-guardrail/lib.mjs";
import {
  parseZcodeHookPayload,
} from "../../packages/contracts/src/zcode-hook";

const CMD = "bun run test";
const FAIL_OUT = "FAIL tests/auth.test.ts > auth > rejects an expired token\n  expected 401 to be 200";

// The shipped defaults (3/8), in the compiled shape isVerificationCommand
// and evaluateDeny consume — mirrors what hook.mjs's loadConfig produces.
const defaultCfg = normalizeConfig(defaultConfig()).config;

// Apply one failed verification cycle through the pure state machine.
function fail(state, { command = CMD, outputText = FAIL_OUT } = {}) {
  return applyVerificationResult(state, { command, outcome: "failed", outputText });
}

// ---------------------------------------------------------------------------
// A. Progress-based counting (pure) — the core invariant
// ---------------------------------------------------------------------------
describe("progress-based counting (lib.mjs, pure)", () => {
  it("same-failure cap denies on the 4th attempt, not the 3rd", () => {
    // Three identical recorded failures arm the cap: the NEXT rerun
    // (the 4th attempt) is what gets denied. After the second failure
    // the deny must not fire — an off-by-one bricks early or never protects.
    let state = emptyState();
    state = fail(state);
    expect(evaluateDeny(state, defaultCfg)).toBeNull();
    state = fail(state);
    expect(evaluateDeny(state, defaultCfg)).toBeNull();
    state = fail(state);
    expect(evaluateDeny(state, defaultCfg)).toEqual({ cap: "sameFailureCap", count: 3, limit: 3 });
  });

  it("TRAP: distinct failures never trip the same-failure cap", () => {
    // 10 fix-then-fail cycles, each with a DIFFERENT failure signature.
    // sameFailStreak must stay at 1 throughout (so sameFailureCap never
    // appears); if anything fires it is the distinct cap at 8.
    let state = emptyState();
    for (let i = 1; i <= 10; i++) {
      state = applyStateChange(state);
      state = fail(state, { outputText: `FAIL case-${i} > distinct error ${i}` });
      const breach = evaluateDeny(state, defaultCfg);
      if (i < 8) {
        expect(breach, `cycle ${i}`).toBeNull();
      } else {
        expect(breach, `cycle ${i}`).not.toBeNull();
        expect(breach.cap).toBe("distinctFailureCap");
        expect(breach.cap).not.toBe("sameFailureCap");
      }
      expect(state.sameFailStreak, `cycle ${i}`).toBe(1);
    }
  });

  it("TRAP: a success resets the budget", () => {
    // A cap that survives a successful verification bricks legitimate
    // convergent work. After deny-level state, one success must clear BOTH
    // counters back to 0.
    let state = emptyState();
    state = fail(state);
    state = fail(state);
    state = fail(state);
    expect(evaluateDeny(state, defaultCfg)).not.toBeNull();
    state = applyVerificationResult(state, { command: CMD, outcome: "success", outputText: "Test Files  5 passed" });
    expect(evaluateDeny(state, defaultCfg)).toBeNull();
    expect(state.sameFailStreak).toBe(0);
    expect(state.failCyclesSinceSuccess).toBe(0);
    expect(state.lastVerificationFailed).toBe(false);
  });

  it("TRAP: distinct verification commands without edits never arm the same-failure cap (cross-PR duty)", () => {
    // Three red `gh pr checks` on DIFFERENT PRs in a non-editing session are
    // distinct verifications (the manager role's cross-PR verification duty),
    // not retries of one failure: the streak stays at 1 and no deny fires.
    // Bare-retry counting requires command identity.
    let state = emptyState();
    for (const pr of [120, 121, 122]) {
      state = fail(state, { command: `gh pr checks ${pr}`, outputText: "Some checks were not successful" });
      expect(state.sameFailStreak, `pr ${pr}`).toBe(1);
      expect(evaluateDeny(state, defaultCfg), `pr ${pr}`).toBeNull();
    }
    // ...while same-command flake retries (no edit between) still increment:
    // nothing changed, so a different result is flake, not progress.
    state = fail(state, { command: "gh pr checks 122", outputText: "Some checks were not successful (2 failed)" });
    state = fail(state, { command: "gh pr checks 122", outputText: "Some checks were not successful (3 failed)" });
    expect(state.sameFailStreak).toBe(3);
    expect(evaluateDeny(state, defaultCfg)).toEqual({ cap: "sameFailureCap", count: 3, limit: 3 });
  });

  it("TRAP: flaky bare retry cannot evade the cap", () => {
    // Failures with DIFFERENT outputs but NO state change (no Edit/Write)
    // between cycles are bare retries: any output difference is flake, not
    // progress, so the same-failure streak still increments. Without this,
    // output jitter (durations, ordering) defeats the guardrail.
    let state = emptyState();
    state = fail(state, { outputText: "FAIL auth.test.ts > token expired (1.23s)" });
    state = fail(state, { outputText: "FAIL auth.test.ts > token invalid (3.45s)" });
    expect(state.sameFailStreak).toBe(2);
    state = fail(state, { outputText: "FAIL auth.test.ts > token revoked (9.99s)" });
    expect(state.sameFailStreak).toBe(3);
    expect(evaluateDeny(state, defaultCfg)).toEqual({ cap: "sameFailureCap", count: 3, limit: 3 });
  });

  it("a real fix attempt with a new failure is progress", () => {
    // fail -> edit -> fail with a different signature: the streak resets to 1
    // (the total failed-cycle count still grows — the distinct cap owns that).
    let state = emptyState();
    state = fail(state, { outputText: "FAIL auth.test.ts > token expired" });
    state = applyStateChange(state);
    state = fail(state, { outputText: "FAIL auth.test.ts > token invalid" });
    expect(state.sameFailStreak).toBe(1);
    expect(state.failCyclesSinceSuccess).toBe(2);
  });

  it("distinct cap boundary: fires at 8 failed cycles, null at 7", () => {
    let state = emptyState();
    for (let i = 1; i <= 7; i++) {
      state = applyStateChange(state);
      state = fail(state, { outputText: `FAIL distinct-${i} > unique error` });
      expect(evaluateDeny(state, defaultCfg), `cycle ${i}`).toBeNull();
    }
    state = applyStateChange(state);
    state = fail(state, { outputText: "FAIL distinct-8 > unique error" });
    expect(evaluateDeny(state, defaultCfg)).toEqual({ cap: "distinctFailureCap", count: 8, limit: 8 });
  });

  it("interrupted/cancelled calls are never evidence", () => {
    // Cancelled, backgrounded, spawn-error and unclassifiable shapes are
    // indeterminate: an uncountable outcome may only silence the guardrail,
    // never strengthen it.
    for (const response of [
      { status: "cancelled", exitCode: 1 },
      { status: "backgrounded" },
      { status: "spawn_error" },
      null,
      "failed",
      42,
      [],
      [1, 2],
      { status: "something_unrecognized" },
    ]) {
      expect(outcomeFromToolResponse(response), JSON.stringify(response)).toBe("indeterminate");
    }
    // Applying an indeterminate outcome leaves the state UNCHANGED.
    let state = fail(emptyState());
    const before = { ...state };
    for (const response of [{ status: "cancelled" }, null, "junk", [], { status: "completed" }, {}]) {
      state = applyVerificationResult(state, {
        command: CMD,
        outcome: outcomeFromToolResponse(response),
        outputText: "ignored",
      });
    }
    expect(state).toEqual(before);
  });

  it("failed vs success classification of tool responses", () => {
    expect(outcomeFromToolResponse({ status: "completed", exitCode: 1 })).toBe("failed");
    expect(outcomeFromToolResponse({ exitCode: 1 })).toBe("failed"); // status omitted
    expect(outcomeFromToolResponse({ status: "failed" })).toBe("failed");
    expect(outcomeFromToolResponse({ status: "timed_out" })).toBe("failed");
    expect(outcomeFromToolResponse({ timedOut: true, status: "completed", exitCode: 0 })).toBe("failed");
    expect(outcomeFromToolResponse({ status: "completed", exitCode: 0 })).toBe("success");
    expect(outcomeFromToolResponse({ exitCode: 0 })).toBe("success");
    // Success requires POSITIVE exitCode evidence (review A3): a failure
    // envelope that omits the field must never classify as success — that
    // would silently reset both counters.
    expect(outcomeFromToolResponse({ status: "completed" })).toBe("indeterminate");
    expect(outcomeFromToolResponse({})).toBe("indeterminate");
    // Status is checked first: a cancelled call is never evidence, even
    // when the envelope carries a non-zero exitCode.
    expect(outcomeFromToolResponse({ status: "cancelled", exitCode: 1 })).toBe("indeterminate");
  });
});

// ---------------------------------------------------------------------------
// B. Signature determinism — "same failure" must mean the same thing
// ---------------------------------------------------------------------------
describe("failure signature determinism (lib.mjs)", () => {
  it("volatile tokens are normalized away (durations, timestamps, ANSI, whitespace, tmp paths)", () => {
    const run1 = "FAIL auth.test.ts: expected 1 to be 2 (1.23s) log /tmp/cache-1/out.log at 2026-08-30T01:02:03.000Z";
    const run2 =
      "\x1B[31mFAIL\x1B[0m auth.test.ts:   expected 1 to be 2   (345ms) log /tmp/cache-22/other.log at 2026-08-31T09:10:11Z";
    expect(normalizeOutput(run1)).toBe(normalizeOutput(run2));
    expect(failureSignature(CMD, run1)).toBe(failureSignature(CMD, run2));
  });

  // Property: generated durations, tmp paths, timestamps, pids, clock times,
  // epoch-millis, memory figures and bracketed counters stand in for live
  // output jitter; the invariant must hold for every generated combination.
  // (Path segments are letters-only so they can never contain a duration
  // token, which is stripped before temp paths are normalized.)
  const clockArb = fc.record({
    h: fc.integer({ min: 0, max: 23 }),
    m: fc.integer({ min: 0, max: 59 }),
    s: fc.integer({ min: 0, max: 59 }),
  });
  const pad2 = (n) => String(n).padStart(2, "0");
  const renderClock = ({ h, m, s }) => `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  const volatileJitter = fc.record({
    seconds: fc.integer({ min: 0, max: 9999 }),
    millis: fc.integer({ min: 0, max: 999999 }),
    tmpA: fc.stringMatching(/^[a-zA-Z]{1,12}$/),
    tmpB: fc.stringMatching(/^[a-zA-Z]{1,12}$/),
    epochSeconds: fc.integer({ min: 0, max: 2 ** 30 }),
    pidA: fc.integer({ min: 1, max: 999999 }),
    pidB: fc.integer({ min: 1, max: 999999 }),
    clockA: clockArb,
    clockB: clockArb,
    epochMillisA: fc.integer({ min: 10 ** 12, max: 10 ** 13 - 1 }), // exactly 13 digits
    epochMillisB: fc.integer({ min: 10 ** 12, max: 10 ** 13 - 1 }),
    memA: fc.integer({ min: 0, max: 9999 }),
    memB: fc.integer({ min: 0, max: 9999 }),
    counterA: fc.integer({ min: 0, max: 999 }),
    counterB: fc.integer({ min: 0, max: 999 }),
  });
  fcTest.prop([volatileJitter])(
    "property: two runs of the same failing command sign identically over generated volatile jitter",
    ({ seconds, millis, tmpA, tmpB, epochSeconds, pidA, pidB, clockA, clockB, epochMillisA, epochMillisB, memA, memB, counterA, counterB }) => {
      const iso = (s) => new Date(s * 1000).toISOString();
      const runA = `FAIL auth.test.ts: expected 1 to be 2  at /tmp/${tmpA}  after ${seconds}.${seconds % 10}s  at ${iso(epochSeconds)}  pid=${pidA}  since ${renderClock(clockA)}  epoch ${epochMillisA}  heap ${memA} MiB  try [${counterA}]`;
      const runB = `FAIL auth.test.ts: expected 1 to be 2  at /tmp/${tmpB}  after ${millis}ms  at ${iso(epochSeconds + 1)}  pid=${pidB}  since ${renderClock(clockB)}  epoch ${epochMillisB}  heap ${memB}.${memB % 10} KiB  try [${counterB}]`;
      expect(failureSignature(CMD, runA)).toBe(failureSignature(CMD, runB));
    },
  );

  it("TRAP: post-edit volatile jitter (pids, clocks, epoch-millis, memory, counters) cannot disguise the same failure", () => {
    // The same failure re-emitting fresh volatile tokens, WITH an edit
    // between: the signatures must still match (jitter normalizes away), so
    // the streak increments. If volatile tokens made the same failure read
    // as a fresh signature, every fix-fail cycle would look like progress
    // and the same-failure cap would be unreachable.
    const runA = "FAIL auth.test.ts > token expired (pid=4242) at 01:02:03 ts 1767139200000 heap 1.5 MiB attempt [1]";
    const runB = "FAIL auth.test.ts > token expired (pid=98765) at 10:11:12 ts 1767140200000 heap 512.0 KiB attempt [7]";
    expect(failureSignature(CMD, runA)).toBe(failureSignature(CMD, runB));
    let state = fail(emptyState(), { outputText: runA });
    state = applyStateChange(state);
    state = fail(state, { outputText: runB });
    expect(state.sameFailStreak).toBe(2); // same failure after an edit, not progress
  });

  it("a different failing test produces a different signature", () => {
    const a = "FAIL auth.test.ts > token expired";
    const b = "FAIL login.test.ts > token expired";
    expect(failureSignature(CMD, a)).not.toBe(failureSignature(CMD, b));
  });

  it("signature binds command + output", () => {
    // Rerunning a DIFFERENT verification command on the same error text is
    // not the same cycle...
    expect(failureSignature("bun run test", FAIL_OUT)).not.toBe(failureSignature("bun run check", FAIL_OUT));
    // ...but whitespace-only differences in the command do not change identity.
    expect(failureSignature("bun   run test", FAIL_OUT)).toBe(failureSignature("bun run test", FAIL_OUT));
  });
});

// ---------------------------------------------------------------------------
// C. Config and state hardening (lib.mjs) — fail-open inputs
// ---------------------------------------------------------------------------
describe("config and state hardening (lib.mjs)", () => {
  it("TRAP: caps are read from config, not hardcoded", () => {
    // Tight caps must actually govern the deny decision — this is the
    // "caps are tunable" acceptance test. A single same-failure cycle with
    // sameFailureCap:1 denies; two distinct failures with distinctFailureCap:2
    // deny under that cap.
    const tightSame = normalizeConfig({ sameFailureCap: 1, distinctFailureCap: 8 }).config;
    expect(tightSame.sameFailureCap).not.toBe(defaultCfg.sameFailureCap);
    expect(evaluateDeny(fail(emptyState()), tightSame)).toEqual({ cap: "sameFailureCap", count: 1, limit: 1 });

    const tightDistinct = normalizeConfig({ sameFailureCap: 8, distinctFailureCap: 2 }).config;
    expect(tightDistinct.distinctFailureCap).not.toBe(defaultCfg.distinctFailureCap);
    let state = emptyState();
    state = fail(state, { outputText: "FAIL distinct-a" });
    state = applyStateChange(state);
    state = fail(state, { outputText: "FAIL distinct-b" });
    expect(evaluateDeny(state, tightDistinct)).toEqual({ cap: "distinctFailureCap", count: 2, limit: 2 });
  });

  it("TRAP: corrupt config degrades to defaults, never throws", () => {
    for (const raw of [null, undefined, 42, "config", [], true]) {
      const { config, degraded } = normalizeConfig(raw);
      expect(degraded.length, JSON.stringify(raw)).toBeGreaterThan(0);
      expect(config.sameFailureCap).toBe(defaultCfg.sameFailureCap);
      expect(config.distinctFailureCap).toBe(defaultCfg.distinctFailureCap);
    }
    // Invalid cap values fall back per field.
    for (const cap of [0, -1, 2.5, "3", null]) {
      const { config, degraded } = normalizeConfig({ sameFailureCap: cap, distinctFailureCap: cap });
      expect(degraded).toContain("sameFailureCap");
      expect(degraded).toContain("distinctFailureCap");
      expect(config.sameFailureCap).toBe(defaultCfg.sameFailureCap);
      expect(config.distinctFailureCap).toBe(defaultCfg.distinctFailureCap);
    }
    // Invalid regex patterns: all-invalid patterns degrade to the defaults...
    const allInvalid = normalizeConfig({ verificationPatterns: ["[unclosed", "((?P<"] });
    expect(allInvalid.degraded).toContain("verificationPatterns");
    // ...an empty pattern array degrades too...
    const emptyPatterns = normalizeConfig({ verificationPatterns: [] });
    expect(emptyPatterns.degraded).toContain("verificationPatterns");
    // ...and a partially invalid array keeps the valid patterns (skip, not crash),
    // leaving a fully usable config.
    const mixed = normalizeConfig({ verificationPatterns: ["\\bpytest\\b", "[unclosed"] });
    expect(mixed.degraded).toEqual([]);
    expect(isVerificationCommand("pytest tests/", mixed.config)).toBe(true);
    expect(isVerificationCommand("bun run test", mixed.config)).toBe(false);
  });

  // Formerly BLOCKED (production bug found by this suite): string defaults
  // used to leak into every fallback path, making classification throw.
  // FIXED by b11cd47 — defaultConfig() now compiles its patterns, so every
  // degraded config is classification-ready.
  it("TRAP: a degraded config is still usable for classification", () => {
    expect(isVerificationCommand("bun run test", normalizeConfig(null).config)).toBe(true);
    expect(isVerificationCommand("bun run test", normalizeConfig({ verificationPatterns: [] }).config)).toBe(true);
    expect(isVerificationCommand("bun run test", normalizeConfig({ sameFailureCap: 0 }).config)).toBe(true);
  });

  it("TRAP: corrupt state fails open at the shape check", () => {
    const garbage = [
      null,
      undefined,
      [],
      "state",
      42,
      {}, // missing every key
      { sameFailStreak: 0 }, // missing keys
      { ...emptyState(), sameFailStreak: "3" }, // wrong type
      { ...emptyState(), lastSignature: 7 }, // corrupted nullable string
      { ...emptyState(), failCyclesSinceSuccess: null },
    ];
    for (const bad of garbage) {
      expect(isValidState(bad), JSON.stringify(bad)).toBe(false);
    }
    // A round-tripped valid state (what hook.mjs writes and reloads) is accepted.
    const valid = JSON.parse(JSON.stringify(fail(emptyState())));
    expect(isValidState(valid)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D. Deny message content — the escalation instruction
// ---------------------------------------------------------------------------
describe("deny message content (lib.mjs)", () => {
  function denyLevelState() {
    let state = emptyState();
    state = fail(state, { outputText: "FAIL auth.test.ts > token expired (expected 200, got 401)" });
    state = fail(state);
    state = fail(state);
    return state;
  }

  it("TRAP: deny reason carries the full stuck-report format", () => {
    const state = denyLevelState();
    const breach = evaluateDeny(state, defaultCfg);
    const reason = buildDenyReason(state, defaultCfg, breach);
    // The five numbered stuck-report items (issue #94 format), by content.
    expect(reason).toContain("1. Invariant under test");
    expect(reason).toContain("2. Exact current failure");
    expect(reason).toContain("3. Attempted fixes");
    expect(reason).toContain("4. Ruled-out hypotheses");
    expect(reason).toContain("5. Checkpoint commit ref");
    // Checkpoint-first instruction: escalation must never lose work.
    expect(reason).toContain("FIRST");
    expect(reason).toMatch(/commit your work to the branch FIRST/i);
    // "Never fake done": completion criterion unchanged.
    expect(reason).toContain("Never fake done");
    expect(reason).toContain("PR must exist and all its checks must be green");
    // Which cap was breached, with count and limit.
    expect(reason).toContain(`sameFailureCap: ${breach.count} failed cycles >= limit ${breach.limit}`);
    // The failure signature and the config path for tuning.
    expect(reason).toContain(state.lastSignature);
    expect(reason).toContain("scripts/iteration-guardrail/config.json");
  });

  it("deny JSON shape is exactly what the runtime parses", () => {
    // A wrong shape here would make every deny silently no-op.
    const parsed = JSON.parse(buildDenyOutput("reason text"));
    expect(parsed).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "reason text",
      },
    });
  });
});

// ---------------------------------------------------------------------------
// E. Command classification (lib.mjs)
// ---------------------------------------------------------------------------
describe("command classification (lib.mjs)", () => {
  it("verification commands are classified as verification", () => {
    for (const command of [
      "bun run test",
      "bun run check",
      "bunx vitest run tests/x.test.mjs",
      "bunx tsc --noEmit",
      "bun test tests/auth.test.ts",
      "pytest tests/",
      "go test ./...",
      "gh pr checks 122",
      "npm run test",
      "pnpm check",
      "cargo test",
      "make lint",
    ]) {
      expect(isVerificationCommand(command, defaultCfg), command).toBe(true);
    }
  });

  it("TRAP: checkpoint duty is never blocked — git commands are not verification", () => {
    // The stuck-report protocol REQUIRES committing before escalating; if
    // git commands were classified as verification, a breached session could
    // not even create the checkpoint commit the report must reference.
    for (const command of [
      'git commit -m "wip: checkpoint before escalation"',
      "git push origin issue-98-iteration-guardrail",
      "git worktree add /tmp/wt-escalate fix-branch",
      "git add -A",
      "git status",
    ]) {
      expect(isVerificationCommand(command, defaultCfg), command).toBe(false);
    }
  });

  it("empty or non-string commands are not verification", () => {
    for (const command of ["", "   ", null, undefined, 42, ["bun run test"]]) {
      expect(isVerificationCommand(command, defaultCfg), JSON.stringify(command)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// F. Process-level behavior (hook.mjs via spawnSync, isolated state per test)
// ---------------------------------------------------------------------------
describe("hook.mjs subprocess (fail-open and deny at the process boundary)", () => {
  const HOOK = new URL("../../scripts/iteration-guardrail/hook.mjs", import.meta.url).pathname;
  const REPO_ROOT = new URL("../../", import.meta.url).pathname;
  const SESSION_A = "sess_guardrail_a";
  const SESSION_B = "sess_guardrail_b";

  // Failure-safe cleanup (review B4): every env created by newEnv() is
  // removed after each test even when an assertion fails mid-test, so no
  // guardrail-hook-* directories leak into $TMPDIR.
  const liveEnvs = [];
  // Issue #123 parameterization: the shipped config.json defaults to scope
  // "subagents-only", under which these hook-level sessions (sess_guardrail_*)
  // would be a full no-op. The counting/deny semantics under test are
  // scope-agnostic, so they run under scope "all" — byte-identical to the
  // pre-#123 behavior. Scope-specific behavior has its own suite:
  // iteration-guardrail-scope.test.mjs.
  function newEnv(scope = "all") {
    const dir = mkdtempSync(join(tmpdir(), "guardrail-hook-"));
    const stateDir = join(dir, "state");
    mkdirSync(stateDir, { recursive: true });
    const configPath = join(dir, "config.json");
    copyFileSync(join(REPO_ROOT, "scripts", "iteration-guardrail", "config.json"), configPath);
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    cfg.scope = scope;
    writeFileSync(configPath, JSON.stringify(cfg, null, 2));
    const env = { dir, stateDir, configPath };
    liveEnvs.push(env);
    return env;
  }

  afterEach(() => {
    for (const env of liveEnvs) rmSync(env.dir, { recursive: true, force: true });
    liveEnvs.length = 0;
  });

  function stateFileFor(env, sessionId) {
    return join(env.stateDir, `${sessionId}.json`);
  }

  function runHook(payload, env, extraEnv = {}) {
    return spawnSync("bun", [HOOK], {
      input: typeof payload === "string" ? payload : JSON.stringify(payload),
      encoding: "utf8",
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        // Isolate from any live session identity the harness may have set.
        ZCODE_SESSION_ID: "",
        ZCODE_PROJECT_DIR: "",
        ZCODE_GUARDRAIL_STATE_DIR: env.stateDir,
        ZCODE_GUARDRAIL_CONFIG: env.configPath,
        ...extraEnv,
      },
    });
  }

  const preToolUse = (sessionId, command, toolName = "Bash") => ({
    hook_event_name: "PreToolUse",
    session_id: sessionId,
    tool_name: toolName,
    tool_input: { command },
  });
  const postBash = (sessionId, command, toolResponse) => ({
    hook_event_name: "PostToolUse",
    session_id: sessionId,
    tool_name: "Bash",
    tool_input: { command },
    tool_response: toolResponse,
  });
  const postEdit = (sessionId) => ({
    hook_event_name: "PostToolUse",
    session_id: sessionId,
    tool_name: "Edit",
    tool_input: { file_path: "src/fix.ts" },
  });
  const postFailure = (sessionId, command, message, extra = {}) => ({
    hook_event_name: "PostToolUseFailure",
    session_id: sessionId,
    tool_name: "Bash",
    tool_input: { command },
    error: { message },
    ...extra,
  });
  const failedResponse = (stdout) => ({ status: "completed", exitCode: 1, stdout, stderr: "" });

  function seedFailure(env, sessionId, { command = CMD, stdout = FAIL_OUT } = {}, extraEnv = {}) {
    const r = runHook(postBash(sessionId, command, failedResponse(stdout)), env, extraEnv);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("verification_result");
  }

  function seedFailures(env, sessionId, n, opts = {}, extraEnv = {}) {
    for (let i = 0; i < n; i++) seedFailure(env, sessionId, opts, extraEnv);
  }

  it("end-to-end stuck loop: 3 identical failures then the rerun is denied with the stuck report", () => {
    const env = newEnv();
    seedFailures(env, SESSION_A, 2);
    // After only TWO failures: allowed, no deny JSON on stdout.
    const early = runHook(preToolUse(SESSION_A, CMD), env);
    expect(early.status).toBe(0);
    expect(early.stdout).toBe("");
    seedFailures(env, SESSION_A, 1);
    // Third identical failure arms the cap: the PreToolUse rerun is denied.
    const denied = runHook(preToolUse(SESSION_A, CMD), env);
    expect(denied.status).toBe(0);
    const out = JSON.parse(denied.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    const reason = out.hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain("1. Invariant under test");
    expect(reason).toContain("2. Exact current failure");
    expect(reason).toContain("3. Attempted fixes");
    expect(reason).toContain("4. Ruled-out hypotheses");
    expect(reason).toContain("5. Checkpoint commit ref");
    expect(reason).toContain("Never fake done");
    expect(reason).toContain(CMD);
    expect(denied.stderr).toContain('"event":"deny"');
  });

  it("TRAP: a breached session does not leak into a fresh session in the same state dir", () => {
    // State is keyed per session: the manager's re-dispatch ladder depends on
    // a fresh dispatch (different session_id) starting with clean counters.
    const env = newEnv();
    seedFailures(env, SESSION_A, 3);
    const deniedA = runHook(preToolUse(SESSION_A, CMD), env);
    expect(JSON.parse(deniedA.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    const freshB = runHook(preToolUse(SESSION_B, CMD), env);
    expect(freshB.status).toBe(0);
    expect(freshB.stdout).toBe("");
  });

  it("TRAP: corrupted state file fails open with a structured skip event", () => {
    const env = newEnv();
    // Not-JSON bytes at all:
    writeFileSync(stateFileFor(env, SESSION_A), "NOT JSON{{{");
    const notJson = runHook(preToolUse(SESSION_A, CMD), env);
    expect(notJson.status).toBe(0);
    expect(notJson.stdout).toBe("");
    expect(notJson.stderr).toContain("skip_corrupt_state");
    // JSON that parses but fails shape validation:
    writeFileSync(stateFileFor(env, SESSION_A), JSON.stringify({ schemaVersion: 1, state: { hello: "wrong shape" } }));
    const wrongShape = runHook(preToolUse(SESSION_A, CMD), env);
    expect(wrongShape.status).toBe(0);
    expect(wrongShape.stdout).toBe("");
    expect(wrongShape.stderr).toContain("skip_corrupt_state");
    expect(wrongShape.stderr).toContain("shape validation");
  });

  it("fail-open on malformed stdin and contract-rejected payloads", () => {
    const env = newEnv();
    for (const raw of ['garbage{{', "", JSON.stringify({ hook_event_name: "Stop", session_id: SESSION_A })]) {
      const r = runHook(raw, env);
      expect(r.status, `payload: ${JSON.stringify(raw)}`).toBe(0);
      expect(r.stdout, `payload: ${JSON.stringify(raw)}`).toBe("");
    }
  });

  it("fail-open on missing config: warn event, exit 0, no deny output", () => {
    const env = newEnv();
    const missing = join(env.dir, "does-not-exist.json");
    const overrides = { ZCODE_GUARDRAIL_CONFIG: missing };
    const warn = runHook(preToolUse(SESSION_A, CMD), env, overrides);
    expect(warn.status).toBe(0);
    expect(warn.stdout).toBe("");
    expect(warn.stderr).toContain("warn_config");
    expect(warn.stderr).toContain("built-in defaults");
  });

  // Formerly BLOCKED (same production bug as the skipped case in section C):
  // with a missing config the hook used to go fully inert (error_fatal on
  // every event, no deny reachable). FIXED by b11cd47 — the default caps
  // apply and a seeded stuck loop denies again.
  it("TRAP: a stuck loop seeded against the default caps still denies with missing config", () => {
    const env = newEnv();
    const missing = join(env.dir, "does-not-exist.json");
    const overrides = { ZCODE_GUARDRAIL_CONFIG: missing };
    // Issue #123: with the config file missing, the built-in defaults apply —
    // which now include scope "subagents-only". The session must therefore
    // match the default subagent pattern for the caps to govern it.
    const sid = "sess_subagent_agent_missing_config";
    seedFailures(env, sid, 3, {}, overrides);
    const denied = runHook(preToolUse(sid, CMD), env, overrides);
    expect(denied.status).toBe(0);
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("interrupted failure is not counted: skip_interrupted, and deny needs a real third failure", () => {
    const env = newEnv();
    seedFailures(env, SESSION_A, 2);
    const interrupt = runHook(
      postFailure(SESSION_A, CMD, "Command was cancelled by the user", { is_interrupt: true }),
      env,
    );
    expect(interrupt.status).toBe(0);
    expect(interrupt.stderr).toContain("skip_interrupted");
    // Had the interrupt counted as a failed cycle, this rerun would deny.
    expect(runHook(preToolUse(SESSION_A, CMD), env).stdout).toBe("");
    seedFailures(env, SESSION_A, 1);
    const denied = runHook(preToolUse(SESSION_A, CMD), env);
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("non-verification commands pass through and write no state", () => {
    const env = newEnv();
    const pre = runHook(preToolUse(SESSION_A, 'git commit -m "checkpoint: stuck-report evidence"'), env);
    expect(pre.status).toBe(0);
    expect(pre.stdout).toBe("");
    expect(existsSync(stateFileFor(env, SESSION_A)), "PreToolUse must not write state").toBe(false);
    const post = runHook(postBash(SESSION_A, "git push origin HEAD", failedResponse(FAIL_OUT)), env);
    expect(post.status).toBe(0);
    expect(post.stderr).not.toContain("verification_result");
    expect(existsSync(stateFileFor(env, SESSION_A)), "PostToolUse must not write state").toBe(false);
  });

  it("an Edit event records a fix attempt: progress is allowed, bare retries deny", () => {
    const env = newEnv();
    const outputs = [
      "FAIL auth.test.ts > token expired",
      "FAIL auth.test.ts > token invalid",
      "FAIL auth.test.ts > token revoked",
    ];
    // WITH an Edit between each failure: each failure is a new signature, so
    // the same-failure streak resets — three failed cycles and still allowed.
    for (let i = 0; i < 3; i++) {
      seedFailure(env, SESSION_A, { stdout: outputs[i] });
      if (i < 2) {
        const edit = runHook(postEdit(SESSION_A), env);
        expect(edit.status).toBe(0);
      }
    }
    expect(runHook(preToolUse(SESSION_A, CMD), env).stdout).toBe("");
    // WITHOUT any Edit: the same three failing reruns are bare retries —
    // output differences are flake, not progress — so the cap denies.
    for (const out of outputs) seedFailure(env, SESSION_B, { stdout: out });
    const denied = runHook(preToolUse(SESSION_B, CMD), env);
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("PostToolUseFailure (non-interrupt) counts: deny reachable without any PostToolUse event", () => {
    const env = newEnv();
    for (let i = 0; i < 3; i++) {
      const r = runHook(postFailure(SESSION_A, CMD, "hook failed: bun exited with code 1 (missing module @app/contracts)"), env);
      expect(r.status).toBe(0);
      expect(r.stderr).toContain("verification_failure_event");
    }
    const denied = runHook(preToolUse(SESSION_A, CMD), env);
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// G. Contract boundary (packages/contracts/src/zcode-hook.ts)
// ---------------------------------------------------------------------------
describe("hook payload contract (packages/contracts/src/zcode-hook.ts)", () => {
  const pre = {
    hook_event_name: "PreToolUse",
    session_id: "sess_contract",
    tool_name: "Bash",
    tool_input: { command: "bun run test" },
  };
  const post = {
    hook_event_name: "PostToolUse",
    session_id: "sess_contract",
    tool_name: "Bash",
    tool_input: { command: "bun run test" },
    tool_response: { status: "completed", exitCode: 0, stdout: "ok", stderr: "" },
  };
  const editMinimal = { hook_event_name: "PostToolUse", tool_name: "Edit" }; // optionals omitted
  const failure = {
    hook_event_name: "PostToolUseFailure",
    session_id: "sess_contract",
    tool_name: "Bash",
    tool_input: { command: "bun run test" },
    error: { message: "spawn failed" },
    is_interrupt: true,
  };

  it("accepts all three events with realistic payloads, including optional-field omissions", () => {
    for (const payload of [pre, post, editMinimal, failure]) {
      const r = parseZcodeHookPayload(payload);
      expect(r.ok, JSON.stringify(payload)).toBe(true);
      expect(r.payload.hook_event_name).toBe(payload.hook_event_name);
    }
    // Unknown keys are ignored (forward compatibility with the runtime envelope).
    expect(parseZcodeHookPayload({ ...pre, future_field: { nested: 1 } }).ok).toBe(true);
  });

  // Note: the per-event behavioral coverage above already exercises the
  // schema variant for all three events; structural valibot-AST assertions
  // were removed (review B3) — they pinned implementation internals.

  // Runtime envelope fixtures (review A5): committed under
  // scripts/iteration-guardrail/fixtures/, derived from the runtime's
  // hook-input serialization (each carries a `_meta` provenance note, not a
  // live capture). They act as a contract-drift regression net: if the
  // envelope contract drifts from what the runtime actually delivers, these
  // parses fail.
  const FIXTURES = new URL("../../scripts/iteration-guardrail/fixtures/", import.meta.url).pathname;
  const FIXTURE_NAMES = ["pre-tool-use-bash", "post-tool-use-bash-failed", "post-tool-use-edit", "post-tool-use-failure"];

  function readFixture(name) {
    return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
  }

  it("parses all committed runtime-envelope fixtures against the contract", () => {
    for (const name of FIXTURE_NAMES) {
      const payload = readFixture(name);
      const r = parseZcodeHookPayload(payload);
      expect(r.ok, `${name}: ${r.ok ? "" : r.reason}`).toBe(true);
      expect(r.payload.hook_event_name, name).toBe(payload.hook_event_name);
      expect(r.payload.tool_name, name).toBe(payload.tool_name);
    }
  });

  it("classifies the failed Bash fixture's tool_response as failed", () => {
    const failed = readFixture("post-tool-use-bash-failed");
    expect(failed.tool_response.status).toBe("completed");
    expect(failed.tool_response.exitCode).toBe(1);
    expect(outcomeFromToolResponse(failed.tool_response)).toBe("failed");
  });

  it("rejects junk with a reason string and never throws", () => {
    const junk = [
      null,
      undefined,
      42,
      "x",
      [],
      { hook_event_name: "Stop", session_id: "s1" }, // unknown event
      { hook_event_name: "PreToolUse" }, // missing tool_name
      { hook_event_name: "PreToolUse", tool_name: "" }, // empty tool_name
      { hook_event_name: "PreToolUse", tool_name: "Bash", session_id: 7 }, // non-string session id
      { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: 5 }, // non-string junk
      { hook_event_name: "PostToolUseFailure", tool_name: "Bash", error: { message: "" } }, // empty error message
    ];
    for (const bad of junk) {
      const r = parseZcodeHookPayload(bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      expect(typeof r.reason, JSON.stringify(bad)).toBe("string");
      expect(r.reason.length, JSON.stringify(bad)).toBeGreaterThan(0);
    }
  });
});
