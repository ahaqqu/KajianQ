import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  captureFingerprint,
  computeUsageTotals,
  mergeUsageIntoMetadata,
  ownedUsageKeys,
  parseHookPayload,
  serializeMetadata,
  USAGE_ROWS_SQL,
} from "../../scripts/agent-usage-metadata/lib.mjs";

const SESSION = "sess_subagent_agent_test";
const AGENT_ID = "agent_test";

function row(over = {}) {
  return {
    provider_id: "ollama",
    model_id: "glm-5.3:cloud",
    status: "completed",
    started_at: 1000,
    completed_at: 6000,
    duration_ms: 5000,
    input_tokens: 100,
    output_tokens: 10,
    reasoning_tokens: 2,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 50,
    computed_total_tokens: 162,
    ...over,
  };
}

function metadataText(over = {}) {
  return JSON.stringify({
    agentId: AGENT_ID,
    childSessionId: SESSION,
    status: "completed",
    ...over,
  });
}

describe("parseHookPayload", () => {
  it("accepts a TaskOutput PostToolUse payload and normalizes the agent id", () => {
    const withPrefix = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "TaskOutput",
      tool_use_id: "call_1",
      tool_input: { task_id: AGENT_ID },
    });
    expect(parseHookPayload(withPrefix)).toEqual({ ok: true, event: "task-output", agentId: AGENT_ID });
    const bareId = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "TaskOutput",
      tool_use_id: "call_1",
      tool_input: { task_id: "test" },
    });
    expect(parseHookPayload(bareId)).toEqual({ ok: true, event: "task-output", agentId: "agent_test" });
  });

  it("accepts an Agent PostToolUse payload as a dispatch-completion capture", () => {
    const raw = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      tool_use_id: "call_9",
      tool_input: { subagent_type: "implementer" },
    });
    expect(parseHookPayload(raw)).toEqual({ ok: true, event: "agent-dispatch", toolUseId: "call_9" });
  });

  it("rejects Stop payloads: not a capture point (dead in this runtime)", () => {
    const raw = JSON.stringify({ hook_event_name: "Stop", session_id: SESSION });
    expect(parseHookPayload(raw).ok).toBe(false);
  });

  it("rejects non-JSON, non-object, unknown events, and missing fields", () => {
    expect(parseHookPayload("not json").ok).toBe(false);
    expect(parseHookPayload("[1,2]").ok).toBe(false);
    expect(parseHookPayload(JSON.stringify({ hook_event_name: "PostToolUse", session_id: SESSION })).ok).toBe(false);
    expect(
      parseHookPayload(JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "TaskOutput", tool_use_id: "c", tool_input: {} })).ok,
    ).toBe(false);
    expect(
      parseHookPayload(JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "c", tool_input: {} })).ok,
    ).toBe(false);
  });
});

describe("computeUsageTotals", () => {
  it("sums token columns and request counts across rows", () => {
    const rows = [
      row(),
      row({ status: "error", input_tokens: 30, output_tokens: 0, reasoning_tokens: 0, cache_read_input_tokens: 0, completed_at: null }),
    ];
    const totals = computeUsageTotals(SESSION, rows, "2026-08-30T00:00:00.000Z");
    expect(totals.requestCount).toBe(2);
    expect(totals.completedRequestCount).toBe(1);
    expect(totals.inputTokens).toBe(130);
    expect(totals.outputTokens).toBe(10);
    expect(totals.reasoningTokens).toBe(2);
    expect(totals.cacheReadInputTokens).toBe(50);
    expect(totals.computedTotalTokens).toBe(324);
  });

  it("computes wall time from earliest started to latest completed", () => {
    const rows = [
      row({ started_at: 1000, completed_at: 6000 }),
      row({ started_at: 3000, completed_at: 9000 }),
    ];
    expect(computeUsageTotals(SESSION, rows, "x").wallTimeMs).toBe(8000);
  });

  it("zero wall time when nothing completed", () => {
    expect(computeUsageTotals(SESSION, [row({ status: "running", completed_at: null })], "x").wallTimeMs).toBe(0);
  });

  it("breaks usage down per model", () => {
    const rows = [row(), row({ model_id: "kimi-k2.7-code:cloud" })];
    const totals = computeUsageTotals(SESSION, rows, "x");
    expect(totals.models).toHaveLength(2);
    expect(totals.models[0].requestCount).toBe(1);
  });
});

describe("mergeUsageIntoMetadata", () => {
  const totals = computeUsageTotals(SESSION, [row()], "2026-08-30T00:00:00.000Z");

  it("preserves pre-existing keys and adds usage keys", () => {
    const next = mergeUsageIntoMetadata(metadataText(), totals);
    expect(next.agentId).toBe(AGENT_ID);
    expect(next.status).toBe("completed");
    expect(next.usage.inputTokens).toBe(100);
    expect(next.usageCaptures).toHaveLength(1);
  });

  it("is idempotent: re-capture with the same totals does not duplicate history", () => {
    const once = mergeUsageIntoMetadata(metadataText(), totals);
    const twice = mergeUsageIntoMetadata(serializeMetadata(once), totals);
    expect(twice.usageCaptures).toHaveLength(1);
    expect(twice.usage).toEqual(totals);
  });

  it("fingerprint covers cache/reasoning/wall-time so cache-only deltas append history (A4)", () => {
    const base = computeUsageTotals(SESSION, [row()], "x");
    const cacheOnlyGrowth = computeUsageTotals(
      SESSION,
      [row({ cache_read_input_tokens: 51, reasoning_tokens: 3, started_at: 900, completed_at: 7000 })],
      "x",
    );
    expect(captureFingerprint(cacheOnlyGrowth)).not.toBe(captureFingerprint(base));
  });

  it("accumulates across resumed subagents: new rows grow the totals", () => {
    const first = mergeUsageIntoMetadata(metadataText(), totals);
    const resumedTotals = computeUsageTotals(
      SESSION,
      [row(), row({ input_tokens: 200, output_tokens: 20, started_at: 90000, completed_at: 95000 })],
      "2026-08-30T00:01:00.000Z",
    );
    const second = mergeUsageIntoMetadata(serializeMetadata(first), resumedTotals);
    expect(second.usage.requestCount).toBe(2);
    expect(second.usage.inputTokens).toBe(300);
    expect(second.usageCaptures).toHaveLength(2);
    expect(captureFingerprint(resumedTotals)).not.toBe(captureFingerprint(totals));
  });

  it("throws on unparseable metadata instead of writing", () => {
    expect(() => mergeUsageIntoMetadata("{corrupt", totals)).toThrow(/not valid JSON/);
  });

  it("throws when the record does not belong to the usage session", () => {
    expect(() =>
      mergeUsageIntoMetadata(metadataText({ childSessionId: "sess_subagent_agent_other" }), totals),
    ).toThrow(/does not match/);
  });

  it("throws when metadata is not an object", () => {
    expect(() => mergeUsageIntoMetadata("[1]", totals)).toThrow(/not a JSON object/);
  });
});

describe("usage row SQL", () => {
  it("filters by session id placeholder and selects the token columns", () => {
    expect(USAGE_ROWS_SQL).toContain("session_id = ?");
    expect(USAGE_ROWS_SQL).toContain("cache_read_input_tokens");
    expect(USAGE_ROWS_SQL).toContain("from model_usage");
  });
});

describe("ownedUsageKeys", () => {
  it("declares exactly the keys the hook owns", () => {
    expect(ownedUsageKeys()).toEqual(["usage", "usageCaptures"]);
  });
});

// End-to-end guard checks: run the real hook entrypoint as a subprocess the
// same way the workspace-hook runtime does (payload JSON on stdin).
describe("hook.mjs subprocess (entrypoint as the runtime runs it)", () => {
  let env;
  const taskOutputPayload = JSON.stringify({
    hook_event_name: "PostToolUse",
    tool_name: "TaskOutput",
    tool_use_id: "call_probe",
    tool_input: { task_id: "agent_probe" },
  });
  const agentPayload = JSON.stringify({
    hook_event_name: "PostToolUse",
    tool_name: "Agent",
    tool_use_id: "call_probe_fg",
    tool_input: { subagent_type: "implementer" },
  });

  beforeAll(() => {
    env = mkdtempSync(join(tmpdir(), "hook-guard-"));
    mkdirSync(join(env, "agents", "sess_parent", "agent_probe"), { recursive: true });
    copyFileSync(
      new URL("../../scripts/agent-usage-metadata/hook.mjs", import.meta.url).pathname,
      join(env, "hook.mjs"),
    );
    copyFileSync(
      new URL("../../scripts/agent-usage-metadata/lib.mjs", import.meta.url).pathname,
      join(env, "lib.mjs"),
    );
    // Real DB with one usage row for the child session.
    const db = new DatabaseSync(join(env, "db.sqlite"));
    db.exec(`create table model_usage (id text primary key, session_id text, provider_id text, model_id text, status text,
      started_at integer, completed_at integer, duration_ms integer, input_tokens integer, output_tokens integer,
      reasoning_tokens integer, cache_creation_input_tokens integer, cache_read_input_tokens integer, computed_total_tokens integer)`);
    db.prepare("insert into model_usage values ('r1','sess_subagent_agent_probe','p','m','completed',1000,6000,5000,100,10,2,0,50,162)").run();
    db.close();
  });
  afterAll(() => rmSync(env, { recursive: true, force: true }));

  function runHook(payload, extraEnv = {}) {
    return spawnSync("bun", [join(env, "hook.mjs")], {
      input: payload,
      encoding: "utf8",
      env: {
        ...process.env,
        ZCODE_AGENTS_DIR: join(env, "agents"),
        ZCODE_DB_PATH: join(env, "db.sqlite"),
        ZCODE_AGENT_USAGE_LOG: join(env, "hook.log"),
        ...extraEnv,
      },
    });
  }

  it("TaskOutput capture: usage lands in metadata and repeats are idempotent", () => {
    const metaPath = join(env, "agents", "sess_parent", "agent_probe", "metadata.json");
    writeFileSync(metaPath, JSON.stringify({ agentId: "agent_probe", childSessionId: "sess_subagent_agent_probe", status: "completed" }));
    const first = runHook(taskOutputPayload);
    expect(first.status).toBe(0);
    expect(first.stderr).toContain("usage_recorded");
    const once = JSON.parse(readFileSync(metaPath, "utf8"));
    expect(once.usage.inputTokens).toBe(100);
    expect(once.usageCaptures).toHaveLength(1);
    const second = runHook(taskOutputPayload);
    expect(second.status).toBe(0);
    const rerun = JSON.parse(readFileSync(metaPath, "utf8"));
    expect(rerun.usageCaptures).toHaveLength(1);
    expect(rerun.usageCaptures[0].fingerprint).toBe(once.usageCaptures[0].fingerprint);
    expect(rerun.usage.inputTokens).toBe(100);
  });

  it("Agent (foreground) capture: parentToolUseId match records usage (B1)", () => {
    const metaPath = join(env, "agents", "sess_parent", "agent_probe", "metadata.json");
    writeFileSync(metaPath, JSON.stringify({
      agentId: "agent_probe",
      childSessionId: "sess_subagent_agent_probe",
      parentToolUseId: "call_probe_fg",
      status: "completed",
    }));
    const r = runHook(agentPayload);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("usage_recorded");
    expect(JSON.parse(readFileSync(metaPath, "utf8")).usage.requestCount).toBe(1);
  });

  it("Stop payload: validated no-op with observable skip, nothing written (A1/B1)", () => {
    const metaPath = join(env, "agents", "sess_parent", "agent_probe", "metadata.json");
    const before = readFileSync(metaPath, "utf8");
    const r = runHook(JSON.stringify({ hook_event_name: "Stop", session_id: "sess_subagent_agent_probe" }));
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("skip_payload");
    expect(readFileSync(metaPath, "utf8")).toBe(before);
  });

  it("corrupt metadata.json: never written into; skip is logged; bytes unchanged", () => {
    const metaPath = join(env, "agents", "sess_parent", "agent_probe", "metadata.json");
    const corrupt = '{"childSessionId": "sess_subagent_agent_probe", CORRUPT';
    writeFileSync(metaPath, corrupt);
    const r = runHook(taskOutputPayload);
    // An unparseable record must never be written into: the capture is
    // skipped with an observable log line and the file keeps its bytes.
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("skip_no_agent_record");
    expect(readFileSync(metaPath, "utf8")).toBe(corrupt);
  });

  it("missing telemetry DB: exits 1, logs, metadata untouched", () => {
    const metaPath = join(env, "agents", "sess_parent", "agent_probe", "metadata.json");
    const valid = JSON.stringify({ agentId: "agent_probe", childSessionId: "sess_subagent_agent_probe", status: "completed" });
    writeFileSync(metaPath, valid);
    const r = runHook(taskOutputPayload, { ZCODE_DB_PATH: join(env, "missing.sqlite") });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("error_db");
    expect(readFileSync(metaPath, "utf8")).toBe(valid);
  });
});
